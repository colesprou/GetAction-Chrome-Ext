"""Tests for the lenient team name matcher."""
from app.mapping.ticker_lookup import team_matches


def test_exact_match():
    assert team_matches("Kansas City Royals", "Kansas City Royals")


def test_case_insensitive():
    assert team_matches("KANSAS CITY ROYALS", "kansas city royals")


def test_kalshi_prefix():
    assert team_matches("Kansas City", "Kansas City Royals")


def test_kalshi_mascot_only():
    assert team_matches("Cubs", "Chicago Cubs")
    assert team_matches("Lakers", "Los Angeles Lakers")


def test_kalshi_initial_after_city():
    assert team_matches("Chicago C", "Chicago Cubs")


def test_kalshi_multi_letter_initial():
    # The actual bug: "Chicago WS" vs "Chicago White Sox"
    assert team_matches("Chicago WS", "Chicago White Sox")


def test_kalshi_three_letter_initial():
    assert team_matches("New York RB", "New York Red Bulls")


def test_no_false_positive_different_city():
    assert not team_matches("Kansas City", "New York Yankees")
    assert not team_matches("Chicago WS", "Los Angeles Lakers")


def test_no_false_positive_different_mascot():
    assert not team_matches("Chicago WS", "Chicago Cubs")


def test_empty_inputs():
    assert not team_matches("", "Chicago Cubs")
    assert not team_matches("Chicago", "")
    assert not team_matches(None, "Chicago Cubs")


def test_single_word_appears_in_sel():
    assert team_matches("Cavaliers", "Cleveland Cavaliers")
