"""Tests for per-league book routing in Settings."""
from app.config import Settings


def test_default_per_league_has_nba_override():
    s = Settings()
    nba = s.books_for_league("NBA")
    assert "DraftKings" in nba
    assert "Pinnacle" not in nba


def test_mlb_falls_back_to_default_sharps():
    s = Settings()
    mlb = s.books_for_league("MLB")
    assert "Pinnacle" in mlb
    assert "Circa Sports" in mlb


def test_nhl_falls_back_to_default_sharps():
    s = Settings()
    nhl = s.books_for_league("NHL")
    assert "Pinnacle" in nhl


def test_books_for_unknown_league_returns_default():
    s = Settings()
    assert s.books_for_league("FAKE") == s.sharp_books_list


def test_books_for_empty_league_returns_default():
    s = Settings()
    assert s.books_for_league("") == s.sharp_books_list


def test_parsing_multi_league_overrides():
    s = Settings(
        per_league_books="NBA:DraftKings,FanDuel|NCAAB:Caesars,BetMGM"
    )
    assert s.books_for_league("NBA") == ["DraftKings", "FanDuel"]
    assert s.books_for_league("NCAAB") == ["Caesars", "BetMGM"]
    # Unlisted leagues fall through to default.
    assert "Pinnacle" in s.books_for_league("MLB")


def test_parsing_empty_per_league_string():
    s = Settings(per_league_books="")
    assert s.per_league_books_map == {}
    # Every league falls through to default.
    assert s.books_for_league("NBA") == s.sharp_books_list
