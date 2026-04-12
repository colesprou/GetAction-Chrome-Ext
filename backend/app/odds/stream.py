"""Optic Odds SSE stream manager.

Maintains an in-memory cache of fixtures with the same shape the REST path
produces, so the /fair-value endpoint can treat REST and stream identically.

Architecture:
  - One task per league (spawned via start()).
  - Each task connects to /api/v3/stream/odds/{sport}?league=X with sharp books
    + "Kalshi" + market=Moneyline.
  - Every `odds` event is flattened (each row independently updates a fixture's
    book×selection slot).
  - `get_fixtures(league)` returns a list-of-fixtures dict identical in shape
    to OpticClient.get_league_moneyline.
  - Auto-reconnects with exponential backoff; passes `last_entry_id` on retry.

Reference: Optic_Odds_Lesson.md §3c, §9, §10 (Circa stream lag caveat).
"""
from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Optional

import httpx
from httpx_sse import aconnect_sse

from ..config import Settings
from ..logging import log
from .optic_client import OpticClient

# League → Optic sport family for the path parameter.
LEAGUE_SPORT_MAP: dict[str, str] = {
    "MLB": "baseball",
    "NBA": "basketball",
    "NCAAB": "basketball",
    "NCAAW": "basketball",
    "NFL": "football",
    "NCAAF": "football",
    "NHL": "hockey",
    "ATP": "tennis",
    "WTA": "tennis",
}


@dataclass
class LeagueState:
    league: str
    fixtures: dict[str, dict] = field(default_factory=dict)  # fixture_id -> fixture
    last_entry_id: Optional[str] = None
    connected: bool = False
    last_event_at: float = 0.0


class StreamManager:
    """Per-league SSE consumer + in-memory fixture cache."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.api_key = settings.oddsjam_api_key
        self.base_url = settings.optic_odds_base_url.rstrip("/")
        self._states: dict[str, LeagueState] = {}
        self._tasks: dict[str, asyncio.Task] = {}
        self._warmup_tasks: dict[str, asyncio.Task] = {}
        self._stopped = False

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self, leagues: list[str]) -> None:
        """Kick off warmup + background consumer tasks per league."""
        self._stopped = False
        for league in leagues:
            if league in self._tasks and not self._tasks[league].done():
                continue
            sport = LEAGUE_SPORT_MAP.get(league)
            if not sport:
                log.warning("stream.unknown_league", league=league)
                continue
            self._states[league] = LeagueState(league=league)
            # REST warmup: seed fixture metadata + initial sharp/Kalshi odds
            # before the stream takes over. The stream task waits for warmup.
            warmup = asyncio.create_task(
                self._warmup_league(league), name=f"optic-warmup-{league}"
            )
            self._warmup_tasks[league] = warmup
            self._tasks[league] = asyncio.create_task(
                self._run_league(league, sport, warmup),
                name=f"optic-stream-{league}",
            )
            log.info("stream.started", league=league, sport=sport)

    async def stop(self) -> None:
        self._stopped = True
        for task in self._tasks.values():
            task.cancel()
        for task in self._warmup_tasks.values():
            task.cancel()
        pending = list(self._tasks.values()) + list(self._warmup_tasks.values())
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        self._tasks.clear()
        self._warmup_tasks.clear()

    # ------------------------------------------------------------------
    # Public accessors
    # ------------------------------------------------------------------

    def get_fixtures(self, league: str) -> list[dict]:
        """Return fixtures for a league in the same shape as the REST path.

        The caller's ticker_lookup treats each fixture identically regardless
        of whether it came from REST or streaming.
        """
        state = self._states.get(league)
        if not state:
            return []
        # Deep-copy guard not needed because ticker_lookup is read-only.
        return list(state.fixtures.values())

    def is_connected(self, league: str) -> bool:
        state = self._states.get(league)
        return bool(state and state.connected)

    # ------------------------------------------------------------------
    # REST warmup — seeds fixture metadata (home/away/start_date) so the
    # stream rows can be attached to fully-formed fixtures.
    # ------------------------------------------------------------------

    async def _warmup_league(self, league: str) -> None:
        state = self._states[league]
        try:
            client = OpticClient(self.settings)
            try:
                merged = await client.get_league_moneyline(
                    league, self.settings.sharp_books_list
                )
            finally:
                await client.aclose()
        except Exception as e:
            log.warning("stream.warmup_failed", league=league, error=str(e))
            return

        if not merged:
            log.info("stream.warmup_empty", league=league)
            return

        for fixture in merged:
            fid = fixture.get("id")
            if not fid:
                continue
            state.fixtures[fid] = {
                "id": fid,
                "home_team_display": fixture.get("home_team_display"),
                "away_team_display": fixture.get("away_team_display"),
                "start_date": fixture.get("start_date"),
                "status": fixture.get("status"),
                "odds": list(fixture.get("odds") or []),
            }
        log.info("stream.warmup_done", league=league, fixtures=len(state.fixtures))

    # ------------------------------------------------------------------
    # SSE consumer
    # ------------------------------------------------------------------

    async def _run_league(
        self, league: str, sport: str, warmup: Optional[asyncio.Task]
    ) -> None:
        if warmup is not None:
            try:
                await warmup
            except asyncio.CancelledError:
                return
            except Exception:
                pass  # warmup failure is non-fatal; stream can still work

        backoff = 1.0
        max_backoff = 30.0
        state = self._states[league]

        while not self._stopped:
            params = [
                ("key", self.api_key),
                ("market", "Moneyline"),
                ("league", league),
                ("is_main", "true"),
            ]
            for book in self.settings.sharp_books_list + ["Kalshi"]:
                params.append(("sportsbook", book))
            if state.last_entry_id:
                params.append(("last_entry_id", state.last_entry_id))

            try:
                async with httpx.AsyncClient(timeout=None) as client:
                    log.info("stream.connecting", league=league)
                    async with aconnect_sse(
                        client,
                        "GET",
                        f"{self.base_url}/stream/odds/{sport}",
                        params=params,
                    ) as event_source:
                        backoff = 1.0  # reset on successful connect
                        async for sse in event_source.aiter_sse():
                            if self._stopped:
                                return
                            await self._handle_event(state, sse.event, sse.data)
            except asyncio.CancelledError:
                return
            except Exception as e:
                log.warning("stream.disconnect", league=league, error=str(e))
                state.connected = False

            if self._stopped:
                return
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, max_backoff)

    async def _handle_event(self, state: LeagueState, event: str, data: str) -> None:
        import time

        if event == "connected":
            state.connected = True
            state.last_event_at = time.time()
            log.info("stream.connected", league=state.league)
            return
        if event == "ping":
            state.last_event_at = time.time()
            return
        if event == "locked-odds":
            # Not handling locked markets in MVP — we just keep the last known
            # price. When fair value is stale, the updated_at timestamp shows it.
            state.last_event_at = time.time()
            return
        if event != "odds":
            return

        try:
            payload = json.loads(data)
        except (ValueError, TypeError):
            log.warning("stream.bad_json", league=state.league)
            return

        # Save entry_id for reconnect resume.
        entry_id = payload.get("entry_id")
        if entry_id:
            state.last_entry_id = entry_id

        rows = payload.get("data") or []
        if not isinstance(rows, list):
            return

        for row in rows:
            self._apply_row(state, row)
        state.last_event_at = time.time()

    def _apply_row(self, state: LeagueState, row: dict) -> None:
        """Update the fixture cache with one SSE row.

        Stream rows don't consistently carry home_team_display/away_team_display,
        so we expect the fixture to already exist from the REST warmup pass.
        For genuinely new fixtures that appeared after warmup, we create a
        placeholder and fill in metadata if the row happens to carry it.
        """
        fid = row.get("fixture_id") or row.get("id")
        if not fid:
            return

        fixture = state.fixtures.get(fid)
        if fixture is None:
            fixture = {
                "id": fid,
                "home_team_display": row.get("home_team_display"),
                "away_team_display": row.get("away_team_display"),
                "start_date": row.get("start_date"),
                "status": row.get("status"),
                "odds": [],
            }
            state.fixtures[fid] = fixture
        else:
            if row.get("home_team_display") and not fixture.get("home_team_display"):
                fixture["home_team_display"] = row["home_team_display"]
            if row.get("away_team_display") and not fixture.get("away_team_display"):
                fixture["away_team_display"] = row["away_team_display"]

        # Ensure the row is moneyline. Some stream events can be other markets
        # sharing the same connection filter — drop anything else defensively.
        market = (row.get("market") or row.get("market_id") or "").lower()
        if market and market not in ("moneyline",):
            return

        book = row.get("sportsbook")
        selection = row.get("selection")
        price = row.get("price")
        if book is None or selection is None or price is None:
            return

        # Replace any existing row for (book, selection) — this is the one
        # place where stream differs from REST: we keep only the latest.
        fixture["odds"] = [
            r for r in fixture["odds"]
            if not (r.get("sportsbook") == book and r.get("selection") == selection)
        ]

        new_row = {
            "sportsbook": book,
            "selection": selection,
            "price": price,
            "market": "moneyline",
            "is_main": row.get("is_main", True),
        }
        source_ids = row.get("source_ids")
        if source_ids:
            new_row["source_ids"] = source_ids
        fixture["odds"].append(new_row)


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

_manager: Optional[StreamManager] = None


def init_stream_manager(settings: Settings) -> StreamManager:
    global _manager
    _manager = StreamManager(settings)
    return _manager


def get_stream_manager() -> Optional[StreamManager]:
    return _manager


async def close_stream_manager() -> None:
    if _manager is not None:
        await _manager.stop()
