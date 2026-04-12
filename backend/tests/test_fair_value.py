import math

import pytest

from app.fair_value import (
    american_to_implied,
    american_to_step,
    compute_fair_value,
    devig_multiplicative,
    implied_to_american,
    prob_to_cents,
    step_to_american,
)


def test_american_to_implied_negative():
    assert american_to_implied(-110) == pytest.approx(110 / 210)


def test_american_to_implied_positive():
    assert american_to_implied(+150) == pytest.approx(100 / 250)


def test_roundtrip_implied_american():
    for odds in (-250, -150, -110, +110, +150, +250):
        p = american_to_implied(odds)
        back = implied_to_american(p)
        assert back == pytest.approx(odds, abs=1)


def test_step_scale_symmetry():
    assert american_to_step(-110) == 90
    assert american_to_step(+110) == 110
    assert step_to_american(90) == -110
    assert step_to_american(110) == 110
    assert step_to_american(american_to_step(-200)) == -200
    assert step_to_american(american_to_step(+250)) == +250


def test_devig_multiplicative_basic():
    p_yes_raw = american_to_implied(-110)
    p_no_raw = american_to_implied(-110)
    res = devig_multiplicative(p_yes_raw, p_no_raw)
    assert res.p_yes == pytest.approx(0.5)
    assert res.p_no == pytest.approx(0.5)
    assert res.overround > 1.0


def test_prob_to_cents_clamps():
    assert prob_to_cents(0.0001) == 1
    assert prob_to_cents(0.9999) == 99
    assert prob_to_cents(0.534) == 53
    assert prob_to_cents(0.5) == 50


def test_compute_fair_value_two_books():
    # Book A: YES -120 / NO +110
    # Book B: YES -115 / NO +105
    fv = compute_fair_value([(-120, +110), (-115, +105)])
    assert fv is not None
    assert 0 < fv.yes_prob < 1
    assert math.isclose(fv.yes_prob + fv.no_prob, 1.0, abs_tol=1e-9)
    assert fv.yes_cents + fv.no_cents in (99, 100, 101)  # rounding slack
    assert fv.yes_cents > fv.no_cents  # YES is favored


def test_compute_fair_value_empty():
    assert compute_fair_value([]) is None
