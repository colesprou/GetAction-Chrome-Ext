"""One-shot live probe of the Optic Odds API + our pipeline.

Usage:
    .venv/bin/python scripts/probe_optic.py [LEAGUE]

Defaults to MLB. Walks the full stack:
  1. GET /fixtures/odds?league=X&market=moneyline (via our OpticClient)
  2. Prints how many fixtures came back, book coverage, any Kalshi rows
  3. Picks the first fixture with a Kalshi source_ids.market_id
  4. Runs our ticker_lookup + fair_value pipeline on it
  5. Prints the result we'd return to the extension
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

# Make `app` importable when running from backend/
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import get_settings  # noqa: E402
from app.edge import compute_edge  # noqa: E402
from app import fair_value as fv  # noqa: E402
from app.mapping.kalshi_parser import extract_league  # noqa: E402
from app.mapping.ticker_lookup import find_ticker  # noqa: E402
from app.odds import cache  # noqa: E402
from app.odds.optic_client import OpticClient  # noqa: E402


async def main(league: str) -> int:
    settings = get_settings()
    if not settings.oddsjam_api_key:
        print("ERROR: ODDSJAM_API_KEY not set", file=sys.stderr)
        return 2

    await cache.init_cache(settings.redis_url)
    client = OpticClient(settings)

    print(f"=== Probing league={league} ===")
    print(f"Sharp books: {settings.sharp_books_list}")
    fixtures = await client.get_league_moneyline(league, settings.sharp_books_list)

    if fixtures is None:
        print("FAIL: client returned None (all batches failed or 404)")
        await client.aclose()
        await cache.close_cache()
        return 1

    print(f"fixtures returned: {len(fixtures)}")

    # Book coverage summary
    book_counts: dict[str, int] = {}
    kalshi_rows = 0
    mapped_tickers: list[tuple[str, str]] = []  # (ticker, fixture_id)
    for fixture in fixtures:
        for row in fixture.get("odds") or []:
            book = row.get("sportsbook") or "unknown"
            book_counts[book] = book_counts.get(book, 0) + 1
            if book == "Kalshi":
                kalshi_rows += 1
                sid = (row.get("source_ids") or {}).get("market_id")
                if sid:
                    mapped_tickers.append((sid, fixture.get("id", "")))

    print("book row counts:")
    for b, c in sorted(book_counts.items(), key=lambda kv: -kv[1]):
        print(f"  {b:<20} {c}")

    print(f"Kalshi rows with source_ids.market_id: {len(mapped_tickers)}")
    if not mapped_tickers:
        print("No Kalshi ticker mappings found. "
              "Either no games active, or Optic hasn't linked them yet.")
        await client.aclose()
        await cache.close_cache()
        return 0

    # Print a sample of tickers
    print("sample tickers:")
    for ticker, fid in mapped_tickers[:5]:
        print(f"  {ticker}  (fixture {fid})")

    # Pick the first ticker and run the full pipeline
    test_ticker = mapped_tickers[0][0]
    print(f"\n=== Running full pipeline on {test_ticker} ===")

    derived_league = extract_league(test_ticker)
    print(f"extract_league: {derived_league}")

    mapping = find_ticker(fixtures, test_ticker, settings.sharp_books_list)
    if mapping is None:
        print("FAIL: find_ticker returned None")
        await client.aclose()
        await cache.close_cache()
        return 1

    print(f"fixture:   {mapping.fixture_id}")
    print(f"home:      {mapping.home_team}")
    print(f"away:      {mapping.away_team}")
    print(f"yes_team:  {mapping.yes_team}  ({mapping.yes_side})")
    print(f"books:     {mapping.books_used}")
    print("quotes:")
    for book, yes, no in mapping.book_quotes:
        print(f"  {book:<20} YES {yes:+}  NO {no:+}")

    if len(mapping.book_quotes) < settings.min_sharp_books:
        print(f"WARN: {len(mapping.book_quotes)} < min_sharp_books ({settings.min_sharp_books})")
        print("Would return status=unmapped")
        await client.aclose()
        await cache.close_cache()
        return 0

    result = fv.compute_fair_value(mapping.simple_quotes)
    if result is None:
        print("FAIL: compute_fair_value returned None")
        await client.aclose()
        await cache.close_cache()
        return 1

    print("\nfair value:")
    print(f"  yes_prob:       {result.yes_prob:.4f}")
    print(f"  no_prob:        {result.no_prob:.4f}")
    print(f"  yes_cents:      {result.yes_cents}")
    print(f"  no_cents:       {result.no_cents}")
    print(f"  yes_american:   {result.yes_american:+.0f}")
    print(f"  no_american:    {result.no_american:+.0f}")
    print(f"  raw avg YES:    {result.yes_raw_avg_american:+.1f}")
    print(f"  raw avg NO:     {result.no_raw_avg_american:+.1f}")

    edge = compute_edge(
        fair_yes_cents=result.yes_cents,
        fair_no_cents=result.no_cents,
        best_ask_yes=None,
        best_ask_no=None,
    )
    print(f"\nedge (no orderbook provided): signal={edge.signal}")

    await client.aclose()
    await cache.close_cache()
    return 0


if __name__ == "__main__":
    league = sys.argv[1] if len(sys.argv) > 1 else "MLB"
    exit_code = asyncio.run(main(league))
    sys.exit(exit_code)
