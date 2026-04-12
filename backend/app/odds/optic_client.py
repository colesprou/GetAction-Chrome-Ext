"""Optic Odds v3 HTTP client (api.opticodds.com).

Real API shape (verified against live probe, 2026-04-10):

  1. `/fixtures/odds?league=X` DOES NOT WORK. Optic returns 400:
       "you must provide at least one of fixture_id, player_id, or team_id"
  2. Two-step flow is required:
       a. GET /fixtures?league=X&start_date_after=...&start_date_before=...
          → list of fixtures with ids, teams, start_date, status
       b. GET /fixtures/odds?fixture_id=a&fixture_id=b&...
                  &market=moneyline&is_main=true
                  &sportsbook=Pinnacle&sportsbook=...
          → per-fixture odds arrays
  3. `fixture_id` is a repeated query param. Multiple IDs per request work.
  4. `sportsbook` is also repeated. Optic 400s on > 4 sportsbooks per call,
     so we batch books into chunks of 4 and merge responses client-side.
  5. Always include "Kalshi" in the first sportsbook batch so source_ids.market_id
     (the Kalshi ticker) arrives with the sharp-book quotes.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import httpx

from ..config import Settings
from ..logging import log
from . import cache

_client: Optional["OpticClient"] = None

# Optic requires "Kalshi" to be in the sportsbook list for source_ids.market_id
# to come back on Kalshi rows.
KALSHI_BOOK = "Kalshi"

# Hard server-side limit: Optic 400s on > 5 total fixture_id/player_id/team_id
# in one /fixtures/odds call. Verified against live API 2026-04-10.
MAX_FIXTURES_PER_REQUEST = 5


def init_optic_client(settings: Settings) -> None:
    global _client
    _client = OpticClient(settings)


async def close_optic_client() -> None:
    if _client is not None:
        await _client.aclose()


def get_optic_client() -> "OpticClient":
    if _client is None:
        raise RuntimeError("Optic client not initialized. Call init_optic_client().")
    return _client


class OpticClient:
    def __init__(self, settings: Settings) -> None:
        self.base_url = settings.optic_odds_base_url.rstrip("/")
        self.api_key = settings.oddsjam_api_key
        self.ttl_fixtures_odds = settings.cache_ttl_fixtures_odds
        self._http = httpx.AsyncClient(
            base_url=self.base_url,
            headers={"x-api-key": self.api_key},
            timeout=httpx.Timeout(connect=3.0, read=8.0, write=3.0, pool=3.0),
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    # ------------------------------------------------------------------
    # Raw GET
    # ------------------------------------------------------------------

    async def _get(
        self, path: str, params: Optional[list[tuple[str, str]]] = None
    ) -> Optional[dict]:
        try:
            r = await self._http.get(path, params=params or [])
        except httpx.HTTPError as e:
            log.warning("optic.http_error", path=path, error=str(e))
            return None
        if r.status_code == 404:
            log.info("optic.not_found", path=path)
            return None
        if r.status_code != 200:
            log.warning(
                "optic.bad_status",
                path=path,
                status=r.status_code,
                body=r.text[:500],
            )
            return None
        try:
            return r.json()
        except ValueError:
            log.warning("optic.bad_json", path=path)
            return None

    # ------------------------------------------------------------------
    # /fixtures — list candidate fixtures for a league
    # ------------------------------------------------------------------

    async def list_fixtures(
        self,
        league: str,
        *,
        hours_past: int = 6,
        hours_future: int = 48,
        limit: int = 100,
        only_active: bool = True,
    ) -> list[dict]:
        """Return fixture dicts for a league in a rolling window.

        `only_active=True` drops completed games, which is what the fair-value
        pipeline wants. For debugging, pass False.
        """
        now = datetime.now(timezone.utc)
        after = (now - timedelta(hours=hours_past)).strftime("%Y-%m-%dT%H:%M:%SZ")
        before = (now + timedelta(hours=hours_future)).strftime("%Y-%m-%dT%H:%M:%SZ")

        cache_key = f"fixtures:{league}:{after}:{before}:{limit}"
        hit = await cache.get_json(cache_key)
        if hit is not None:
            data, _ = hit
        else:
            params: list[tuple[str, str]] = [
                ("league", league),
                ("limit", str(limit)),
                ("start_date_after", after),
                ("start_date_before", before),
            ]
            payload = await self._get("/fixtures", params)
            if payload is None:
                return []
            data = payload.get("data") or []
            # Cache the raw list for a short window — same TTL as odds.
            await cache.set_json(cache_key, data, self.ttl_fixtures_odds)

        if only_active:
            data = [f for f in data if (f.get("status") or "") != "completed"]
        return data

    # ------------------------------------------------------------------
    # /fixtures/odds — moneyline odds for a set of fixture_ids
    # ------------------------------------------------------------------

    async def get_moneyline_odds(
        self,
        fixture_ids: list[str],
        sharp_books: list[str],
    ) -> Optional[list[dict]]:
        """Fetch moneyline odds for a set of fixture_ids across sharp + Kalshi.

        Handles:
          - 4-book batching
          - fixture_id chunking (MAX_FIXTURES_PER_REQUEST per call)
          - merging responses by fixture id

        Returns a list of fixture dicts with a merged `odds` array, or None if
        every batch failed.
        """
        if not fixture_ids:
            return []

        book_batches = _batch_books_for_moneyline(sharp_books)
        fixture_chunks = _chunk(list(fixture_ids), MAX_FIXTURES_PER_REQUEST)

        merged: dict[str, dict] = {}
        any_success = False

        for fixture_chunk in fixture_chunks:
            for batch in book_batches:
                params: list[tuple[str, str]] = [
                    ("market", "moneyline"),
                    ("is_main", "true"),
                ]
                for fid in fixture_chunk:
                    params.append(("fixture_id", fid))
                for b in batch:
                    params.append(("sportsbook", b))

                payload = await self._get("/fixtures/odds", params)
                if payload is None:
                    log.info(
                        "optic.batch_failed",
                        books=batch,
                        n_fixtures=len(fixture_chunk),
                    )
                    continue
                any_success = True

                for fixture in payload.get("data") or []:
                    fid = fixture.get("id")
                    if not fid:
                        continue
                    existing = merged.get(fid)
                    if existing is None:
                        merged[fid] = {
                            "id": fid,
                            "home_team_display": fixture.get("home_team_display"),
                            "away_team_display": fixture.get("away_team_display"),
                            "start_date": fixture.get("start_date"),
                            "status": fixture.get("status"),
                            "odds": list(fixture.get("odds") or []),
                        }
                    else:
                        existing["odds"].extend(fixture.get("odds") or [])

        if not any_success:
            return None
        return list(merged.values())

    # ------------------------------------------------------------------
    # High-level: league → merged moneyline slate (cached)
    # ------------------------------------------------------------------

    async def get_league_moneyline(
        self, league: str, sharp_books: list[str]
    ) -> Optional[list[dict]]:
        """End-to-end: list fixtures for a league, fetch odds, merge, cache."""
        cache_key = f"fixtures_odds:ml:{league}"
        hit = await cache.get_json(cache_key)
        if hit is not None:
            data, _ = hit
            return data

        fixtures = await self.list_fixtures(league)
        if not fixtures:
            return []

        fixture_ids = [f["id"] for f in fixtures if f.get("id")]
        merged = await self.get_moneyline_odds(fixture_ids, sharp_books)
        if merged is None:
            return None

        await cache.set_json(cache_key, merged, self.ttl_fixtures_odds)
        return merged

    # ------------------------------------------------------------------
    # Passthrough for future expansion (/stream, other markets)
    # ------------------------------------------------------------------

    async def raw_get(
        self, path: str, params: Optional[list[tuple[str, str]]] = None
    ) -> Optional[Any]:
        return await self._get(path, params)


# ---------------------------------------------------------------------------
# Batching helpers
# ---------------------------------------------------------------------------

def _batch_books_for_moneyline(sharp_books: list[str]) -> list[list[str]]:
    """Split sharp book list into batches of <=4, always putting Kalshi in batch 0."""
    books = [b for b in sharp_books if b and b.lower() != "kalshi"]
    if not books:
        return [[KALSHI_BOOK]]
    first = books[:3] + [KALSHI_BOOK]
    batches = [first]
    rest = books[3:]
    for i in range(0, len(rest), 4):
        batches.append(rest[i : i + 4])
    return batches


def _chunk(items: list, n: int) -> list[list]:
    if n <= 0:
        return [items]
    return [items[i : i + n] for i in range(0, len(items), n)]
