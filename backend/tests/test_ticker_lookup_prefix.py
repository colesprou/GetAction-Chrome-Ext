"""Prefix-matching tests (the URL-ticker case — Kalshi URLs lack the outcome suffix)."""
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
                {"sportsbook": "Pinnacle", "selection": "Chicago Cubs", "price": -135, "market": "moneyline", "is_main": True},
                {"sportsbook": "Pinnacle", "selection": "Pittsburgh Pirates", "price": +125, "market": "moneyline", "is_main": True},
                {"sportsbook": "Circa Sports", "selection": "Chicago Cubs", "price": -130, "market": "moneyline", "is_main": True},
                {"sportsbook": "Circa Sports", "selection": "Pittsburgh Pirates", "price": +120, "market": "moneyline", "is_main": True},
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
    ]


def test_event_prefix_without_label_defaults_to_home():
    hit = find_ticker(
        _bulk_fixture(),
        "KXMLBGAME-26APR101420PITCHC",  # no -CHC or -PIT
        SHARP_BOOKS,
    )
    assert hit is not None
    assert hit.yes_team == "Chicago Cubs"  # home default
    assert hit.yes_side == "home"


def test_event_prefix_with_label_picks_matching_side():
    hit = find_ticker(
        _bulk_fixture(),
        "KXMLBGAME-26APR101420PITCHC",
        SHARP_BOOKS,
        yes_label="Pittsburgh Pirates",
    )
    assert hit is not None
    assert hit.yes_team == "Pittsburgh Pirates"
    assert hit.yes_side == "away"


def test_event_prefix_with_truncated_label_still_matches():
    # Kalshi shows "Chicago C" in the sidebar — our matcher should handle it
    hit = find_ticker(
        _bulk_fixture(),
        "KXMLBGAME-26APR101420PITCHC",
        SHARP_BOOKS,
        yes_label="Chicago C",
    )
    assert hit is not None
    assert hit.yes_team == "Chicago Cubs"


def test_exact_still_works():
    hit = find_ticker(
        _bulk_fixture(),
        "KXMLBGAME-26APR101420PITCHC-PIT",
        SHARP_BOOKS,
    )
    assert hit is not None
    assert hit.yes_team == "Pittsburgh Pirates"
