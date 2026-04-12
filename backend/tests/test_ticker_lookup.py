"""Tests for ticker_lookup against a synthetic Optic v3 /fixtures/odds response.

The fixture mirrors the shape documented in Optic_Odds_Lesson.md §3b — one
fixture with a mix of sharp-book and Kalshi rows, each Kalshi row carrying
source_ids.market_id set to the exact Kalshi ticker.
"""
from app.mapping.ticker_lookup import find_ticker


SHARP_BOOKS = ["Pinnacle", "Betcris", "BetOnline", "Circa Sports"]


def _bulk_fixture():
    return [
        {
            "id": "fixt_abc123",
            "home_team_display": "Chicago Cubs",
            "away_team_display": "Pittsburgh Pirates",
            "start_date": "2026-04-10T21:20:00Z",
            "status": "unplayed",
            "odds": [
                # --- Pinnacle ---
                {
                    "sportsbook": "Pinnacle",
                    "selection": "Chicago Cubs",
                    "price": -135,
                    "market": "moneyline",
                    "is_main": True,
                },
                {
                    "sportsbook": "Pinnacle",
                    "selection": "Pittsburgh Pirates",
                    "price": +125,
                    "market": "moneyline",
                    "is_main": True,
                },
                # --- Circa Sports ---
                {
                    "sportsbook": "Circa Sports",
                    "selection": "Chicago Cubs",
                    "price": -130,
                    "market": "moneyline",
                    "is_main": True,
                },
                {
                    "sportsbook": "Circa Sports",
                    "selection": "Pittsburgh Pirates",
                    "price": +120,
                    "market": "moneyline",
                    "is_main": True,
                },
                # --- Kalshi (mapping rows) ---
                {
                    "sportsbook": "Kalshi",
                    "selection": "Chicago Cubs",
                    "price": -140,
                    "market": "moneyline",
                    "is_main": True,
                    "source_ids": {"market_id": "KXMLBGAME-26APR101420PITCHC-CHC"},
                },
                {
                    "sportsbook": "Kalshi",
                    "selection": "Pittsburgh Pirates",
                    "price": +130,
                    "market": "moneyline",
                    "is_main": True,
                    "source_ids": {"market_id": "KXMLBGAME-26APR101420PITCHC-PIT"},
                },
            ],
        },
        # A second unrelated fixture to prove we skip non-matching fixtures.
        {
            "id": "fixt_other",
            "home_team_display": "Boston Red Sox",
            "away_team_display": "New York Yankees",
            "start_date": "2026-04-10T23:10:00Z",
            "status": "unplayed",
            "odds": [],
        },
    ]


def test_finds_yes_equals_home():
    hit = find_ticker(
        _bulk_fixture(),
        "KXMLBGAME-26APR101420PITCHC-CHC",
        SHARP_BOOKS,
    )
    assert hit is not None
    assert hit.fixture_id == "fixt_abc123"
    assert hit.yes_team == "Chicago Cubs"
    assert hit.no_team == "Pittsburgh Pirates"
    assert hit.yes_side == "home"
    assert set(hit.books_used) == {"Pinnacle", "Circa Sports"}
    # Simple_quotes are (yes, no) tuples
    yes_odds = [q[0] for q in hit.simple_quotes]
    assert -135 in yes_odds and -130 in yes_odds


def test_finds_yes_equals_away():
    hit = find_ticker(
        _bulk_fixture(),
        "KXMLBGAME-26APR101420PITCHC-PIT",
        SHARP_BOOKS,
    )
    assert hit is not None
    assert hit.yes_team == "Pittsburgh Pirates"
    assert hit.no_team == "Chicago Cubs"
    assert hit.yes_side == "away"
    # Pirates is the underdog, so YES odds should be positive on both books
    yes_odds = [q[0] for q in hit.simple_quotes]
    assert all(o > 0 for o in yes_odds)


def test_unknown_ticker_returns_none():
    hit = find_ticker(_bulk_fixture(), "KXMLBGAME-FAKE-FAKE", SHARP_BOOKS)
    assert hit is None


def test_skips_books_not_in_sharp_set():
    data = _bulk_fixture()
    # Inject a non-sharp row that should be ignored.
    data[0]["odds"].append({
        "sportsbook": "DraftKings",
        "selection": "Chicago Cubs",
        "price": -150,
        "market": "moneyline",
    })
    hit = find_ticker(data, "KXMLBGAME-26APR101420PITCHC-CHC", SHARP_BOOKS)
    assert hit is not None
    assert "DraftKings" not in hit.books_used


def test_drops_books_missing_one_side():
    data = _bulk_fixture()
    # Remove Pinnacle's Pirates row → Pinnacle should not appear.
    data[0]["odds"] = [
        row for row in data[0]["odds"]
        if not (row["sportsbook"] == "Pinnacle" and row["selection"] == "Pittsburgh Pirates")
    ]
    hit = find_ticker(data, "KXMLBGAME-26APR101420PITCHC-CHC", SHARP_BOOKS)
    assert hit is not None
    assert "Pinnacle" not in hit.books_used
    assert "Circa Sports" in hit.books_used
