"""Side-by-side comparison of REST and stream modes for the /fair-value pipeline.

Runs two in-process pipelines:
  1. REST: fresh OpticClient.get_league_moneyline → find_ticker → fair value
  2. Stream: StreamManager.get_fixtures (after warmup) → find_ticker → fair value

Prints per-ticker:
  - REST fair, books
  - Stream fair, books
  - Deltas (if any)

Usage: .venv/bin/python scripts/compare_rest_vs_stream.py [league] [warmup_seconds]
Default: MLB, 25s warmup.
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import get_settings  # noqa: E402
from app import fair_value as fv  # noqa: E402
from app.mapping.ticker_lookup import find_ticker  # noqa: E402
from app.odds import cache  # noqa: E402
from app.odds.optic_client import OpticClient  # noqa: E402
from app.odds.stream import StreamManager  # noqa: E402


async def main(league: str, warmup_seconds: int) -> int:
    settings = get_settings()
    if not settings.oddsjam_api_key:
        print("ERROR: ODDSJAM_API_KEY not set", file=sys.stderr)
        return 2

    await cache.init_cache(settings.redis_url)

    # --- REST pass ---
    print(f"=== REST pass ({league}) ===")
    client = OpticClient(settings)
    rest_fixtures = await client.get_league_moneyline(
        league, settings.sharp_books_list
    )
    if not rest_fixtures:
        print("REST returned no fixtures; bailing.")
        await client.aclose()
        return 1
    print(f"REST fixtures: {len(rest_fixtures)}")

    # Collect the first ~6 distinct tickers from the REST response
    tickers: list[str] = []
    for fixture in rest_fixtures:
        for row in fixture.get("odds") or []:
            if row.get("sportsbook") == "Kalshi":
                sid = (row.get("source_ids") or {}).get("market_id")
                if sid and sid not in tickers:
                    tickers.append(sid)
        if len(tickers) >= 6:
            break
    print(f"test tickers: {len(tickers)}")

    rest_results: dict[str, dict] = {}
    for ticker in tickers:
        hit = find_ticker(rest_fixtures, ticker, settings.sharp_books_list)
        if hit is None or len(hit.book_quotes) < settings.min_sharp_books:
            rest_results[ticker] = {"status": "unmapped", "books": []}
            continue
        r = fv.compute_fair_value(hit.simple_quotes)
        if r is None:
            rest_results[ticker] = {"status": "devig_failed", "books": hit.books_used}
            continue
        rest_results[ticker] = {
            "status": "ok",
            "yes_cents": r.yes_cents,
            "no_cents": r.no_cents,
            "books": hit.books_used,
        }

    # --- Stream pass ---
    print(f"\n=== Stream pass ({league}, warming up {warmup_seconds}s) ===")
    stream = StreamManager(settings)
    stream.start([league])
    await asyncio.sleep(warmup_seconds)
    stream_fixtures = stream.get_fixtures(league)
    print(f"stream fixtures in cache: {len(stream_fixtures)}")

    stream_results: dict[str, dict] = {}
    for ticker in tickers:
        if not stream_fixtures:
            stream_results[ticker] = {"status": "no_fixtures", "books": []}
            continue
        hit = find_ticker(stream_fixtures, ticker, settings.sharp_books_list)
        if hit is None:
            stream_results[ticker] = {"status": "not_found", "books": []}
            continue
        if len(hit.book_quotes) < settings.min_sharp_books:
            stream_results[ticker] = {
                "status": "insufficient_books",
                "books": hit.books_used,
            }
            continue
        r = fv.compute_fair_value(hit.simple_quotes)
        if r is None:
            stream_results[ticker] = {
                "status": "devig_failed",
                "books": hit.books_used,
            }
            continue
        stream_results[ticker] = {
            "status": "ok",
            "yes_cents": r.yes_cents,
            "no_cents": r.no_cents,
            "books": hit.books_used,
        }

    await stream.stop()
    await client.aclose()
    await cache.close_cache()

    # --- Comparison ---
    print("\n=== Comparison ===")
    print(f"{'TICKER':<42}  {'REST':<24}  {'STREAM':<24}")
    print("-" * 92)
    for t in tickers:
        r = rest_results.get(t, {})
        s = stream_results.get(t, {})
        rest_str = _fmt(r)
        stream_str = _fmt(s)
        marker = ""
        if r.get("status") == "ok" and s.get("status") == "ok":
            dy = s["yes_cents"] - r["yes_cents"]
            dn = s["no_cents"] - r["no_cents"]
            if dy == 0 and dn == 0:
                marker = "match"
            else:
                marker = f"diff y{dy:+d} n{dn:+d}"
        print(f"{t:<42}  {rest_str:<24}  {stream_str:<24}  {marker}")

    # Summary
    rest_ok = sum(1 for v in rest_results.values() if v.get("status") == "ok")
    stream_ok = sum(1 for v in stream_results.values() if v.get("status") == "ok")
    print(f"\nsummary: REST {rest_ok}/{len(tickers)} ok, "
          f"stream {stream_ok}/{len(tickers)} ok")
    return 0


def _fmt(r: dict) -> str:
    if r.get("status") == "ok":
        return f"{r['yes_cents']}/{r['no_cents']} ({len(r['books'])})"
    return r.get("status", "?")


if __name__ == "__main__":
    league = sys.argv[1] if len(sys.argv) > 1 else "MLB"
    warmup = int(sys.argv[2]) if len(sys.argv) > 2 else 25
    sys.exit(asyncio.run(main(league, warmup)))
