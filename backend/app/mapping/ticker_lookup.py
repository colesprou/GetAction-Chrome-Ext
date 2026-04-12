"""Find a Kalshi ticker inside a bulk Optic Odds response.

The new mapping strategy (see Optic_Odds_Lesson.md §8 Strategy A):
  1. Each Kalshi sportsbook row in an Optic /fixtures/odds response carries
     `source_ids.market_id` equal to the exact Kalshi ticker.
  2. To map ticker → fixture + sharp quotes, we scan the bulk response for a
     Kalshi row matching our ticker, then collect the sharp-book rows on that
     same fixture and figure out which team is YES.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Optional

from ..logging import log


@dataclass
class MappingHit:
    fixture_id: str
    home_team: str
    away_team: str
    start_date: Optional[str]
    yes_team: str
    no_team: str
    yes_side: Literal["home", "away"]
    is_three_way: bool = False
    # Sharp-book quotes as (yes_american, no_american) tuples for two-way,
    # or (yes_american, no_american, draw_american) for three-way.
    book_quotes: list[tuple] = field(default_factory=list)

    @property
    def books_used(self) -> list[str]:
        return [q[0] for q in self.book_quotes]

    @property
    def simple_quotes(self) -> list[tuple[float, float]]:
        """Two-way quotes only (for backward compat)."""
        return [(q[1], q[2]) for q in self.book_quotes]

    @property
    def simple_three_way_quotes(self) -> list[tuple[float, float, float]]:
        """Three-way quotes: (home, away, draw)."""
        return [(q[1], q[2], q[3]) for q in self.book_quotes if len(q) >= 4]


def find_ticker(
    fixtures: list[dict],
    ticker: str,
    sharp_books: list[str],
    yes_label: Optional[str] = None,
) -> Optional[MappingHit]:
    """Return the mapping hit for `ticker` or None.

    Matching strategy:
      1. Exact match on source_ids.market_id (full ticker like
         KXMLBGAME-26APR101420PITCHC-CHC).
      2. Prefix match on source_ids.market_id (event prefix from Kalshi URL
         like KXMLBGAME-26APR101420PITCHC — no outcome suffix). Among the
         matching rows, pick the one whose Kalshi selection matches
         `yes_label` if provided, otherwise the HOME team's row.

    `fixtures` is the merged response from OpticClient.get_league_moneyline.
    """
    if not fixtures or not ticker:
        return None

    target = ticker.strip().upper()
    sharp_set = {b for b in sharp_books}

    # --- Strategy 1: exact match ---
    for fixture in fixtures:
        kalshi_row = _find_kalshi_row_exact(fixture, target)
        if kalshi_row is not None:
            return _build_hit(fixture, kalshi_row, sharp_set, target)

    # --- Strategy 2: prefix match ---
    prefix = target + "-"
    for fixture in fixtures:
        matching_rows = _find_kalshi_rows_by_prefix(fixture, prefix)
        if not matching_rows:
            continue

        # Choose which row's selection is our YES side.
        chosen = _pick_row_by_yes_label(
            matching_rows, fixture, yes_label
        )
        if chosen is None:
            continue
        return _build_hit(fixture, chosen, sharp_set, target)

    return None


def _build_hit(
    fixture: dict,
    kalshi_row: dict,
    sharp_set: set[str],
    target_ticker: str,
) -> Optional[MappingHit]:
    home = fixture.get("home_team_display") or ""
    away = fixture.get("away_team_display") or ""
    yes_team = kalshi_row.get("selection") or ""
    if not yes_team:
        return None

    # Handle "Draw" / "Tie" selections — these are soccer markets, not
    # team wins. If the Kalshi row's selection is "Draw"/"Tie", treat this
    # as a three-way draw-side lookup. yes_team = "Draw", yes_side = "home"
    # is a misnomer but the field is only used for response labeling; the
    # fair value pipeline knows it's three-way from is_three_way=True.
    sel_lower = yes_team.strip().lower()
    is_draw_side = sel_lower in ("draw", "tie")

    if is_draw_side:
        yes_side: Literal["home", "away"] = "home"  # placeholder
        no_team = away  # not meaningful for draw
    elif yes_team == home:
        yes_side = "home"
        no_team = away
    elif yes_team == away:
        yes_side = "away"
        no_team = home
    else:
        log.warning(
            "ticker_lookup.selection_mismatch",
            ticker=target_ticker,
            selection=yes_team,
            home=home,
            away=away,
        )
        return None

    # Detect three-way market: any odds row has "Draw" or "Tie" selection.
    odds_rows = fixture.get("odds") or []
    is_three_way = any(
        str(r.get("selection", "")).strip().lower() in ("draw", "tie")
        for r in odds_rows
    )

    if is_three_way:
        # Three-way: collect as (home, away, draw) — the fair-value endpoint
        # re-orients to the user's side (home/away/draw) from these.
        book_quotes = _collect_sharp_quotes(
            odds_rows, home, away, sharp_set, is_three_way=True,
        )
    else:
        # Two-way: collect as (yes_team, no_team) so quotes are oriented to
        # the side the user asked about.
        book_quotes = _collect_sharp_quotes(
            odds_rows, yes_team, no_team, sharp_set, is_three_way=False,
        )

    # For three-way markets, the book_quotes are (book, home, away, draw).
    # We need to re-orient so that "yes" is the side the user asked about.
    # For a home-team ticker: yes=home, no=away (draw is separate).
    # For a draw ticker: the caller will use the draw fair from ThreeWayFairValue.

    return MappingHit(
        fixture_id=fixture.get("id") or "",
        home_team=home,
        away_team=away,
        start_date=fixture.get("start_date"),
        is_three_way=is_three_way,
        yes_team=yes_team,
        no_team=no_team,
        yes_side=yes_side,
        book_quotes=book_quotes,
    )


def _find_kalshi_row_exact(fixture: dict, target_ticker: str) -> Optional[dict]:
    for row in fixture.get("odds") or []:
        if str(row.get("sportsbook") or "").lower() != "kalshi":
            continue
        source_ids = row.get("source_ids") or {}
        mid = source_ids.get("market_id")
        if mid and str(mid).strip().upper() == target_ticker:
            return row
    return None


def _find_kalshi_rows_by_prefix(fixture: dict, prefix: str) -> list[dict]:
    out: list[dict] = []
    for row in fixture.get("odds") or []:
        if str(row.get("sportsbook") or "").lower() != "kalshi":
            continue
        source_ids = row.get("source_ids") or {}
        mid = source_ids.get("market_id")
        if mid and str(mid).strip().upper().startswith(prefix):
            out.append(row)
    return out


def _pick_row_by_yes_label(
    rows: list[dict],
    fixture: dict,
    yes_label: Optional[str],
) -> Optional[dict]:
    """Pick which of the matching Kalshi rows is our YES side.

    Preference:
      1. Row whose selection matches yes_label via team_matches() — handles
         Kalshi-style abbreviations like "Chicago WS" ↔ "Chicago White Sox".
      2. Row whose selection == fixture's home_team_display.
      3. First row.
    """
    if not rows:
        return None

    if yes_label:
        for row in rows:
            sel = str(row.get("selection") or "")
            if sel and team_matches(yes_label, sel):
                return row

    # Fallback to home team.
    home = (fixture.get("home_team_display") or "").strip()
    if home:
        for row in rows:
            if str(row.get("selection") or "").strip() == home:
                return row

    return rows[0]


def team_matches(needle: str, sel: str) -> bool:
    """Lenient team name matching between Kalshi-style and Optic full names.

    Handles several Kalshi truncation patterns:
      - Full city prefix: "Kansas City" ↔ "Kansas City Royals"
      - Mascot suffix:    "Cubs" ↔ "Chicago Cubs"
      - Single-letter initial: "Chicago C" ↔ "Chicago Cubs"
      - Multi-letter mascot initials: "Chicago WS" ↔ "Chicago White Sox"
      - Exact equality (case-insensitive)
    """
    if not needle or not sel:
        return False
    n = str(needle).strip().lower()
    s = str(sel).strip().lower()

    # Known aliases that can't be derived algorithmically.
    ALIASES = {
        "a's": {"athletics", "oakland athletics", "oakland a's"},
        "athletics": {"a's", "oakland athletics", "oakland a's"},
        "philly": {"philadelphia", "philadelphia 76ers", "philadelphia eagles", "philadelphia phillies"},
        "nats": {"nationals", "washington nationals"},
        "sox": {"white sox", "red sox"},
    }
    n_aliases = ALIASES.get(n, set())
    if s in n_aliases or n in ALIASES.get(s, set()):
        return True

    # Strip punctuation for comparison (handles "A's" → "as", "St." → "st").
    n_clean = n.replace("'", "").replace(".", "").replace("-", " ")
    s_clean = s.replace("'", "").replace(".", "").replace("-", " ")
    if not n_clean or not s_clean:
        return False
    if n_clean == s_clean or n == s:
        return True
    # Prefix/suffix containment at word boundaries.
    if s_clean.startswith(n_clean + " ") or s_clean.endswith(" " + n_clean):
        return True
    if n_clean.startswith(s_clean + " ") or n_clean.endswith(" " + s_clean):
        return True
    # Also check original forms for prefix/suffix.
    if s.startswith(n + " ") or s.endswith(" " + n):
        return True
    if n.startswith(s + " ") or n.endswith(" " + s):
        return True

    n_words = n_clean.split()
    s_words = s_clean.split()
    if not n_words or not s_words:
        return False

    # Needle words are a prefix of sel words: "kansas city" vs "kansas city royals"
    if len(n_words) <= len(s_words) and n_words == s_words[: len(n_words)]:
        return True

    # Single-word needle appears as any sel word: "cubs" vs "chicago cubs"
    if len(n_words) == 1 and n_words[0] in s_words:
        return True

    # Short needle is a prefix of any sel word: "as" (from "A's") vs
    # "athletics" in "oakland athletics". Only for ≤3-char needles to
    # avoid false positives on longer strings.
    if len(n_words) == 1 and len(n_words[0]) <= 3:
        for sw in s_words:
            if sw.startswith(n_words[0]) and len(sw) > len(n_words[0]):
                return True

    # Abbreviation pattern: first k-1 words match exactly, and the last
    # needle word is the concatenated initial letters of the remaining sel
    # words. Example: needle="chicago ws" vs sel="chicago white sox":
    #   first 1 word matches ("chicago"), last needle word "ws" matches
    #   initials of ["white", "sox"] → "ws".
    if len(n_words) >= 2 and len(n_words) <= len(s_words):
        prefix_len = len(n_words) - 1
        if n_words[:prefix_len] == s_words[:prefix_len]:
            last = n_words[-1]
            remaining = s_words[prefix_len:]
            if 1 <= len(last) <= 4 and len(last) <= len(remaining):
                initials = "".join(w[0] for w in remaining[: len(last)])
                if initials == last:
                    return True

    return False


def _collect_sharp_quotes(
    odds_rows: list[dict],
    yes_team: str,
    no_team: str,
    sharp_books: set[str],
    is_three_way: bool = False,
) -> list[tuple]:
    """Collect sharp-book quotes for a fixture.

    Returns list of (book, yes_american, no_american) for two-way markets,
    or (book, yes_american, no_american, draw_american) for three-way (soccer).
    """
    # book -> {"yes": price, "no": price, "draw": price}
    by_book: dict[str, dict[str, float]] = {}
    for row in odds_rows:
        book = row.get("sportsbook")
        if not book or book not in sharp_books:
            continue
        sel = row.get("selection")
        price = row.get("price")
        if sel is None or price is None:
            continue
        try:
            price_f = float(price)
        except (TypeError, ValueError):
            continue
        slot = by_book.setdefault(book, {})
        if sel == yes_team:
            slot["yes"] = price_f
        elif sel == no_team:
            slot["no"] = price_f
        elif is_three_way and str(sel).lower() in ("draw", "tie"):
            slot["draw"] = price_f

    out: list[tuple] = []
    for book, prices in by_book.items():
        if "yes" not in prices or "no" not in prices:
            continue
        if is_three_way:
            if "draw" not in prices:
                continue
            out.append((book, prices["yes"], prices["no"], prices["draw"]))
        else:
            out.append((book, prices["yes"], prices["no"]))
    return out
