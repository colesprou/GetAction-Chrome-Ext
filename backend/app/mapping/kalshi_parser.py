"""Kalshi ticker parsing — reduced scope.

With the new pipeline we only need to extract the Kalshi *league* from the
ticker so we know which Optic league bucket to fetch. Everything else
(fixture identity, team names, YES-side orientation) comes from the Optic
response via source_ids.market_id.

Tennis note: Optic exposes ATP, WTA, and ATP_CHALLENGER as SEPARATE league
strings (verified via live probe 2026-04-11). Using `tennis` as a league
returns 0 fixtures. Each Kalshi tour must map to its specific Optic league.
"""
from __future__ import annotations

from typing import Optional

# Kalshi ticker prefix -> Optic league query value (display case).
# Longest match wins, so KXATPCHALLENGERMATCH beats KXATPMATCH beats KXATP.
KALSHI_LEAGUE_PREFIXES: dict[str, str] = {
    # Team sports — game moneylines
    "KXMLBGAME": "MLB",
    "KXNBAGAME": "NBA",
    "KXNHLGAME": "NHL",
    "KXNFLGAME": "NFL",
    "KXNCAAMBGAME": "NCAAB",
    "KXNCAABGAME": "NCAAB",
    "KXNCAAWBGAME": "NCAAW",
    "KXNCAAWGAME": "NCAAW",
    "KXNCAAFGAME": "NCAAF",
    # Tennis tours — each Kalshi series maps to a specific Optic league.
    # KXATPCHALLENGERMATCH must come BEFORE KXATPMATCH in longest-match order
    # (and the extract_league function sorts by length descending anyway).
    "KXATPCHALLENGERMATCH": "ATP_CHALLENGER",
    "KXATPMATCH": "ATP",
    "KXWTAMATCH": "WTA",
    # Soccer — three-way markets (home/away/draw). Each Kalshi league maps
    # to a specific Optic league string (verified via live probe 2026-04-12).
    "KXEPLGAME": "England - Premier League",
    "KXUCLGAME": "UEFA Champions League",
    # Fallback: short prefixes for legacy/non-game tickers (backup).
    "KXMLB": "MLB",
    "KXNBA": "NBA",
    "KXNHL": "NHL",
    "KXNFL": "NFL",
    "KXNCAAMB": "NCAAB",
    "KXNCAAB": "NCAAB",
    "KXNCAAWB": "NCAAW",
    "KXNCAAW": "NCAAW",
    "KXNCAAF": "NCAAF",
}


def extract_league(ticker: str) -> Optional[str]:
    """Return the Optic league string for a Kalshi ticker, or None."""
    if not ticker:
        return None
    t = ticker.strip().upper()
    for prefix in sorted(KALSHI_LEAGUE_PREFIXES.keys(), key=len, reverse=True):
        if t.startswith(prefix):
            return KALSHI_LEAGUE_PREFIXES[prefix]
    return None
