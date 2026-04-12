"""POST /resolve-event — resolve an event title + team name to a ticker + fair value.

Used by the portfolio page scraper where Kalshi provides zero links, zero
data attributes, and zero __NEXT_DATA__ — only raw text like
"Alcaraz vs Sinner" and "Buy Yes · Jannik Sinner".

Flow:
  1. Parse the title to guess the league (scan all supported leagues).
  2. For each candidate league, fetch fixtures from Optic (cached).
  3. Find the fixture whose home_team + away_team match the title's teams.
  4. Find the Kalshi row whose selection matches the given team.
  5. Return the ticker + fair value (same payload shape as /fair-value).
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field

from .. import fair_value as fv
from ..config import Settings, get_settings
from ..edge import compute_edge
from ..logging import log
from ..mapping.kalshi_parser import extract_league, KALSHI_LEAGUE_PREFIXES
from ..mapping.ticker_lookup import find_ticker, team_matches
from ..odds.optic_client import get_optic_client
from ..schemas.response import (
    BookOdds,
    CacheInfo,
    EdgeBlock,
    FairBlock,
    FairValueResponse,
    MappingInfo,
    SportsbookBlock,
)


class ResolveEventRequest(BaseModel):
    title: str = Field(..., description="Event title from the group header, e.g. 'Alcaraz vs Sinner'")
    team: str = Field(..., description="Team/player name from the order row, e.g. 'Jannik Sinner'")
    side: str = Field(..., description="'yes' or 'no'")
    books_override: Optional[dict[str, list[str]]] = Field(
        default=None,
        description="Per-league book overrides from user settings.",
    )


router = APIRouter(tags=["resolve"])


async def _require_token(
    x_extension_token: Optional[str] = Header(default=None),
    settings: Settings = Depends(get_settings),
) -> None:
    expected = settings.extension_shared_token
    if not expected:
        return
    if x_extension_token != expected:
        raise HTTPException(status_code=401, detail="invalid_extension_token")


# All leagues we might need to search through.
SEARCHABLE_LEAGUES = sorted(
    set(KALSHI_LEAGUE_PREFIXES.values()),
    key=lambda x: x,
)


@router.post("/resolve-event", response_model=FairValueResponse)
async def post_resolve_event(
    body: ResolveEventRequest,
    _auth: None = Depends(_require_token),
    settings: Settings = Depends(get_settings),
) -> FairValueResponse:
    title = (body.title or "").strip()
    team = (body.team or "").strip()
    side = (body.side or "").strip().lower()

    if not title or not team:
        return FairValueResponse(status="unmapped", reason="missing_title_or_team")

    # Parse the title into two team/player names.
    title_teams = _split_title(title)
    if len(title_teams) < 2:
        return FairValueResponse(
            status="unmapped",
            reason=f"cannot_split_title:{title}",
        )

    client = get_optic_client()

    # Fetch ALL leagues in parallel so we don't pay sequential latency.
    import asyncio as _aio
    # User overrides take precedence per league.
    def _books_for(lg):
        if body.books_override:
            if lg in body.books_override:
                return body.books_override[lg]
            lg_upper = lg.upper()
            matched = next(
                (v for k, v in body.books_override.items() if k.upper() == lg_upper),
                None,
            )
            if matched:
                return matched
        return settings.books_for_league(lg)

    league_books_map = {lg: _books_for(lg) for lg in SEARCHABLE_LEAGUES}

    async def _fetch_league(lg):
        try:
            fixtures = await client.get_league_moneyline(lg, league_books_map[lg])
            return (lg, fixtures)
        except Exception:
            return (lg, None)

    league_results = await _aio.gather(
        *[_fetch_league(lg) for lg in SEARCHABLE_LEAGUES],
    )

    # Search all fetched fixtures for a match.
    for league, fixtures in league_results:
        if not fixtures:
            continue

        for fixture in fixtures:
            home = fixture.get("home_team_display") or ""
            away = fixture.get("away_team_display") or ""
            if not home or not away:
                continue

            # Check if both title teams match this fixture's teams (order-insensitive).
            t0, t1 = title_teams
            match_a = (
                (team_matches(t0, home) and team_matches(t1, away)) or
                (team_matches(t0, away) and team_matches(t1, home))
            )
            if not match_a:
                continue

            # Found the fixture. Now find the Kalshi row for our team.
            # We need a ticker — scan the fixture's odds for Kalshi source_ids.
            kalshi_ticker = None
            for row in fixture.get("odds") or []:
                if str(row.get("sportsbook") or "").lower() != "kalshi":
                    continue
                source_ids = row.get("source_ids") or {}
                mid = source_ids.get("market_id")
                if not mid:
                    continue
                sel = row.get("selection") or ""
                if team_matches(team, sel):
                    kalshi_ticker = str(mid).strip().upper()
                    break

            if not kalshi_ticker:
                # Found the fixture but no Kalshi ticker for this team.
                # Try the event-prefix form (strip the outcome suffix).
                for row in fixture.get("odds") or []:
                    if str(row.get("sportsbook") or "").lower() != "kalshi":
                        continue
                    mid = (row.get("source_ids") or {}).get("market_id")
                    if mid:
                        parts = str(mid).upper().split("-")
                        kalshi_ticker = "-".join(parts[:-1]) if len(parts) > 2 else str(mid).upper()
                        break

            if not kalshi_ticker:
                continue

            # Now run the normal fair-value pipeline.
            hit = find_ticker(fixtures, kalshi_ticker, league_books_map[league], team)
            if hit is None:
                continue
            if len(hit.book_quotes) < settings.min_sharp_books:
                continue

            # Build fair block — three-way (soccer) or two-way.
            fair_block: FairBlock
            per_book_list: list[BookOdds]

            if hit.is_three_way:
                three_way = fv.compute_three_way_fair(hit.simple_three_way_quotes)
                if three_way is None:
                    continue
                sel_lower = (body.team or "").strip().lower()
                is_draw = sel_lower in ("draw", "tie")
                if is_draw:
                    yes_prob = three_way.draw_prob
                elif hit.yes_side == "home":
                    yes_prob = three_way.home_prob
                else:
                    yes_prob = three_way.away_prob
                no_prob = 1.0 - yes_prob

                fair_block = FairBlock(
                    yes_prob=yes_prob, no_prob=no_prob,
                    yes_cents=fv.prob_to_cents(yes_prob),
                    no_cents=fv.prob_to_cents(no_prob),
                    yes_american=fv.implied_to_american(yes_prob),
                    no_american=fv.implied_to_american(no_prob),
                    is_three_way=True,
                    draw_prob=three_way.draw_prob,
                    draw_cents=three_way.draw_cents,
                    draw_american=three_way.draw_american,
                    home_prob=three_way.home_prob,
                    home_cents=three_way.home_cents,
                    away_prob=three_way.away_prob,
                    away_cents=three_way.away_cents,
                )
                per_book_list = [
                    BookOdds(
                        book=q[0],
                        yes_american=q[1] if hit.yes_side == "home" else q[2],
                        no_american=q[2] if hit.yes_side == "home" else q[1],
                        draw_american=q[3] if len(q) > 3 else None,
                    )
                    for q in hit.book_quotes
                ]
            else:
                result = fv.compute_fair_value(hit.simple_quotes)
                if result is None:
                    continue
                fair_block = FairBlock(
                    yes_prob=result.yes_prob, no_prob=result.no_prob,
                    yes_cents=result.yes_cents, no_cents=result.no_cents,
                    yes_american=result.yes_american, no_american=result.no_american,
                )
                per_book_list = [
                    BookOdds(book=q[0], yes_american=q[1], no_american=q[2])
                    for q in hit.book_quotes
                ]

            edge = compute_edge(
                fair_yes_cents=fair_block.yes_cents,
                fair_no_cents=fair_block.no_cents,
                best_ask_yes=None, best_ask_no=None,
                playable_threshold=settings.edge_playable_cents,
                avoid_threshold=settings.edge_avoid_cents,
            )

            log.info(
                "resolve_event.ok",
                title=title, team=team, league=league,
                ticker=kalshi_ticker, yes_cents=fair_block.yes_cents,
                is_three_way=hit.is_three_way,
            )

            return FairValueResponse(
                status="ok",
                mapping=MappingInfo(
                    strategy="title_team_match",
                    confidence=0.9,
                    confidence_label="high",
                    books_used=hit.books_used,
                    optic_event_id=hit.fixture_id,
                    market_type="moneyline",
                    yes_side=hit.yes_side,
                ),
                sportsbook=SportsbookBlock(per_book=per_book_list),
                fair=fair_block,
                edge=EdgeBlock(
                    yes_buy_cents=edge.yes_buy_cents,
                    no_buy_cents=edge.no_buy_cents,
                    signal=edge.signal,
                ),
                updated_at=datetime.now(timezone.utc).isoformat(),
                cache=CacheInfo(hit=False, age_ms=0),
            )

    return FairValueResponse(
        status="unmapped",
        reason=f"no_fixture_match_for:{title}",
    )


def _split_title(title: str) -> list[str]:
    """Split 'Alcaraz vs Sinner' or 'Atlanta at Miami' into two team names."""
    for sep in [" vs ", " @ ", " at ", " v "]:
        if sep in title.lower():
            idx = title.lower().index(sep)
            return [
                title[:idx].strip(),
                title[idx + len(sep):].strip(),
            ]
    return [title]
