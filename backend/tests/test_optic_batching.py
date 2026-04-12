from app.odds.optic_client import _batch_books_for_moneyline


def test_kalshi_in_first_batch_with_three_sharps():
    batches = _batch_books_for_moneyline(["Pinnacle", "Betcris", "BetOnline", "Circa Sports"])
    # First batch must contain Kalshi and be size <= 4
    assert "Kalshi" in batches[0]
    for b in batches:
        assert len(b) <= 4
    # All non-Kalshi sharp books must appear across batches
    flat = [b for batch in batches for b in batch if b != "Kalshi"]
    assert set(flat) == {"Pinnacle", "Betcris", "BetOnline", "Circa Sports"}


def test_empty_still_includes_kalshi():
    batches = _batch_books_for_moneyline([])
    assert batches == [["Kalshi"]]


def test_ignores_duplicate_kalshi_in_input():
    batches = _batch_books_for_moneyline(["Kalshi", "Pinnacle"])
    # Should dedupe — exactly one Kalshi across all batches
    flat = [b for batch in batches for b in batch]
    assert flat.count("Kalshi") == 1
    assert "Pinnacle" in flat


def test_many_books_are_split_into_fours():
    books = ["Pinnacle", "Betcris", "BetOnline", "Circa Sports", "BetAmapola", "BookA", "BookB"]
    batches = _batch_books_for_moneyline(books)
    for b in batches:
        assert len(b) <= 4
    # Every input book + Kalshi appears exactly once
    flat = [b for batch in batches for b in batch]
    assert sorted(flat) == sorted(books + ["Kalshi"])
