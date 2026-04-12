from app.edge import compute_edge


def test_edge_playable_yes_side():
    res = compute_edge(
        fair_yes_cents=55, fair_no_cents=45,
        best_ask_yes=50, best_ask_no=52,
    )
    assert res.yes_buy_cents == 5
    assert res.no_buy_cents == -7
    assert res.signal == "playable"


def test_edge_near_fair():
    res = compute_edge(
        fair_yes_cents=50, fair_no_cents=50,
        best_ask_yes=51, best_ask_no=51,
    )
    assert res.signal == "near_fair"


def test_edge_avoid_when_both_bad():
    res = compute_edge(
        fair_yes_cents=40, fair_no_cents=60,
        best_ask_yes=60, best_ask_no=65,
    )
    # yes_edge = -20, no_edge = -5 -> worst <= -2 and best < +2
    assert res.signal == "avoid"


def test_edge_unknown_when_no_orderbook():
    res = compute_edge(50, 50, None, None)
    assert res.signal == "unknown"
