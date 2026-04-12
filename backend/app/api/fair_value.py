"""POST /fair-value — Optic Odds v3 pipeline.

Flow:
  1. Auth by shared token.
  2. Served-fair cache hit? return.
  3. Parse ticker → league.
  4. OpticClient.get_league_moneyline(league, sharp_books) (cached bulk).
  5. ticker_lookup.find_ticker(fixtures, ticker, sharp_books) — scans for the
     Kalshi row whose source_ids.market_id == ticker.
  6. Require ≥ min_sharp_books quotes → devig → fair value.
  7. Edge vs. Kalshi orderbook best asks.
  8. Return structured payload.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException

from .. import fair_value as fv
from ..config import Settings, get_settings
from ..edge import compute_edge
from ..logging import log
from ..mapping.kalshi_parser import extract_league
from ..mapping.ticker_lookup import MappingHit, find_ticker
from ..odds.cache import get_json, set_json
from ..odds.optic_client import get_optic_client
from ..odds.stream import get_stream_manager
from ..schemas.request import FairValueRequest
from ..schemas.response import (
    BookOdds,
    CacheInfo,
    EdgeBlock,
    FairBlock,
    FairValueResponse,
    MappingInfo,
    SportsbookBlock,
)

router = APIRouter(tags=["fair-value"])


async def _require_token(
    x_extension_token: Optional[str] = Header(default=None),
    settings: Settings = Depends(get_settings),
) -> None:
    expected = settings.extension_shared_token
    if not expected:
        return
    if x_extension_token != expected:
        raise HTTPException(status_code=401, detail="invalid_extension_token")


@router.post("/fair-value", response_model=FairValueResponse)
async def post_fair_value(
    body: FairValueRequest,
    _auth: None = Depends(_require_token),
    settings: Settings = Depends(get_settings),
) -> FairValueResponse:
    # Served-fair cache — cheapest hit path. Include yes_label in the key so
    # two sides of the same event don't collide.
    yl = (body.yes_label or "").strip().lower().replace(" ", "_")
    fair_key = f"fair:{body.ticker}:{yl}"
    hit = await get_json(fair_key)
    if hit is not None:
        cached, age_ms = hit
        cached["cache"] = {"hit": True, "age_ms": age_ms}
        return FairValueResponse(**cached)

    league = extract_league(body.ticker)
    if league is None:
        return FairValueResponse(
            status="unmapped", reason="unknown_league_prefix"
        )

    # Pick the book list for this league. User overrides (from the extension
    # popup's Sharp Books tab) take precedence over the server config.
    if body.books_override and league in body.books_override:
        league_books = body.books_override[league]
    elif body.books_override:
        # Try case-insensitive match (user prefs might have different casing).
        league_upper = league.upper()
        matched = next(
            (v for k, v in body.books_override.items() if k.upper() == league_upper),
            None,
        )
        league_books = matched if matched else settings.books_for_league(league)
    else:
        league_books = settings.books_for_league(league)

    fixtures: Optional[list[dict]] = None
    source_used: str = settings.odds_source
    hit_mapping = None

    # Try stream cache first when in stream mode.
    if settings.odds_source == "stream":
        sm = get_stream_manager()
        if sm is not None:
            fixtures = sm.get_fixtures(league)
        if fixtures:
            hit_mapping = find_ticker(
                fixtures, body.ticker, league_books, body.yes_label
            )

    # REST path (also used as a fallback when the stream cache is cold or when
    # a specific ticker hasn't been pushed yet — SSE drip-feeds fixtures).
    if hit_mapping is None:
        client = get_optic_client()
        rest_fixtures = await client.get_league_moneyline(league, league_books)
        if rest_fixtures:
            rest_hit = find_ticker(
                rest_fixtures, body.ticker, league_books, body.yes_label
            )
            if rest_hit is not None:
                hit_mapping = rest_hit
                fixtures = rest_fixtures
                if settings.odds_source == "stream":
                    source_used = "rest_fallback"

    if not fixtures:
        return FairValueResponse(
            status="unmapped", reason="no_optic_fixtures_for_league"
        )

    if hit_mapping is None:
        return FairValueResponse(
            status="unmapped", reason="ticker_not_in_optic_response"
        )

    if len(hit_mapping.book_quotes) < settings.min_sharp_books:
        return FairValueResponse(
            status="unmapped",
            reason=f"insufficient_sharp_books_{len(hit_mapping.book_quotes)}",
            mapping=_mapping_info(hit_mapping, confidence=0.5),
        )

    # Compute fair value — three-way (soccer) or two-way (everything else).
    fair_block: Optional[FairBlock] = None
    per_book_list: list[BookOdds] = []

    if hit_mapping.is_three_way:
        three_way = fv.compute_three_way_fair(hit_mapping.simple_three_way_quotes)
        if three_way is None:
            return FairValueResponse(
                status="unmapped", reason="devig_failed_3way",
                mapping=_mapping_info(hit_mapping, confidence=0.5),
            )
        # Which side did the user ask about? Map yes_side to home/away/draw.
        sel_lower = (body.yes_label or "").strip().lower()
        is_draw = sel_lower in ("draw", "tie")
        if is_draw:
            yes_prob = three_way.draw_prob
            no_prob = 1.0 - three_way.draw_prob
        elif hit_mapping.yes_side == "home":
            yes_prob = three_way.home_prob
            no_prob = 1.0 - three_way.home_prob
        else:
            yes_prob = three_way.away_prob
            no_prob = 1.0 - three_way.away_prob

        fair_block = FairBlock(
            yes_prob=yes_prob,
            no_prob=no_prob,
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
                yes_american=q[1] if hit_mapping.yes_side == "home" else q[2],
                no_american=q[2] if hit_mapping.yes_side == "home" else q[1],
                draw_american=q[3] if len(q) > 3 else None,
            )
            for q in hit_mapping.book_quotes
        ]
    else:
        result = fv.compute_fair_value(hit_mapping.simple_quotes)
        if result is None:
            return FairValueResponse(
                status="unmapped", reason="devig_failed",
                mapping=_mapping_info(hit_mapping, confidence=0.5),
            )
        fair_block = FairBlock(
            yes_prob=result.yes_prob,
            no_prob=result.no_prob,
            yes_cents=result.yes_cents,
            no_cents=result.no_cents,
            yes_american=result.yes_american,
            no_american=result.no_american,
        )
        per_book_list = [
            BookOdds(book=b, yes_american=y, no_american=n)
            for (b, y, n) in hit_mapping.book_quotes
        ]

    best_ask_yes = body.orderbook.best_ask_yes if body.orderbook else None
    best_ask_no = body.orderbook.best_ask_no if body.orderbook else None
    edge = compute_edge(
        fair_yes_cents=fair_block.yes_cents,
        fair_no_cents=fair_block.no_cents,
        best_ask_yes=best_ask_yes,
        best_ask_no=best_ask_no,
        playable_threshold=settings.edge_playable_cents,
        avoid_threshold=settings.edge_avoid_cents,
    )

    response = FairValueResponse(
        status="ok",
        mapping=_mapping_info(hit_mapping, confidence=0.99),
        sportsbook=SportsbookBlock(
            per_book=per_book_list,
        ),
        fair=fair_block,
        edge=EdgeBlock(
            yes_buy_cents=edge.yes_buy_cents,
            no_buy_cents=edge.no_buy_cents,
            signal=edge.signal,
        ),
        updated_at=datetime.now(timezone.utc).isoformat(),
        cache=CacheInfo(hit=False, age_ms=0),
    )

    await set_json(fair_key, response.model_dump(mode="json"), settings.cache_ttl_fair)
    log.info(
        "fair_value.ok",
        ticker=body.ticker,
        fixture_id=hit_mapping.fixture_id,
        yes_cents=fair_block.yes_cents,
        no_cents=fair_block.no_cents,
        is_three_way=hit_mapping.is_three_way,
        books=hit_mapping.books_used,
        signal=edge.signal,
        source=source_used,
    )
    return response


def _mapping_info(hit: MappingHit, confidence: float) -> MappingInfo:
    if confidence >= 0.9:
        label = "high"
    elif confidence >= 0.7:
        label = "medium"
    else:
        label = "low"
    return MappingInfo(
        strategy="source_ids_market_id",
        confidence=confidence,
        confidence_label=label,
        books_used=hit.books_used,
        optic_event_id=hit.fixture_id,
        market_type="moneyline",
        yes_side=hit.yes_side,
    )
