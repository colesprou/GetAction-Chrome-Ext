"""Pure fair-value math. No I/O, no dependencies outside stdlib."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


# ---------------------------------------------------------------------------
# American <-> implied probability
# ---------------------------------------------------------------------------

def american_to_implied(odds: float) -> float:
    """Convert American odds to implied probability (with vig)."""
    if odds == 0:
        raise ValueError("American odds cannot be 0")
    if odds < 0:
        return (-odds) / (-odds + 100.0)
    return 100.0 / (odds + 100.0)


def implied_to_american(p: float) -> float:
    """Convert a probability [0,1] to American odds. Rounded to nearest int."""
    if not 0 < p < 1:
        raise ValueError(f"Probability must be in (0, 1), got {p}")
    if p >= 0.5:
        return round(-100.0 * p / (1.0 - p))
    return round(100.0 * (1.0 - p) / p)


# ---------------------------------------------------------------------------
# American <-> step scale (Optic Odds lesson §12 / §13)
# Continuous number line that collapses the -100/+100 gap.
# -110 -> 90 ; +110 -> 110 ; ±100 -> 100
# ---------------------------------------------------------------------------

def american_to_step(odds: float) -> float:
    if odds <= -100:
        return odds + 200
    # treat +100 and anything above as positive side
    return odds


def step_to_american(step: float) -> float:
    if step <= 100:
        return step - 200
    return step


# ---------------------------------------------------------------------------
# Aggregation across books
# ---------------------------------------------------------------------------

def average_probability(odds_list: list[float]) -> float:
    """Average implied probabilities. Safer than averaging American odds directly."""
    if not odds_list:
        raise ValueError("Empty odds list")
    probs = [american_to_implied(o) for o in odds_list]
    return sum(probs) / len(probs)


def average_step(odds_list: list[float]) -> float:
    """Average on the step scale (EZarb-style)."""
    if not odds_list:
        raise ValueError("Empty odds list")
    steps = [american_to_step(o) for o in odds_list]
    return sum(steps) / len(steps)


# ---------------------------------------------------------------------------
# Devig (multiplicative, two-way). Transparent for MVP.
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class DevigResult:
    p_yes: float
    p_no: float
    p_yes_raw: float  # pre-devig
    p_no_raw: float
    overround: float  # p_yes_raw + p_no_raw


def devig_multiplicative(p_yes_raw: float, p_no_raw: float) -> DevigResult:
    total = p_yes_raw + p_no_raw
    if total <= 0:
        raise ValueError("Sum of implied probs must be > 0")
    return DevigResult(
        p_yes=p_yes_raw / total,
        p_no=p_no_raw / total,
        p_yes_raw=p_yes_raw,
        p_no_raw=p_no_raw,
        overround=total,
    )


# ---------------------------------------------------------------------------
# Fair prob -> Kalshi cents
# ---------------------------------------------------------------------------

def prob_to_cents(p: float) -> int:
    """Round fair probability to Kalshi integer cents in [1, 99]."""
    c = round(p * 100)
    if c < 1:
        return 1
    if c > 99:
        return 99
    return int(c)


# ---------------------------------------------------------------------------
# Full pipeline helper: list of (yes_american, no_american) per book -> fair
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class FairValue:
    yes_prob: float
    no_prob: float
    yes_cents: int
    no_cents: int
    yes_american: float
    no_american: float
    yes_raw_avg_american: float  # vigged MBA
    no_raw_avg_american: float


def compute_fair_value(book_quotes: list[tuple[float, float]]) -> Optional[FairValue]:
    """Given [(yes_american, no_american), ...] across sharp books, return fair value.

    Uses probability-scale averaging (Optic lesson §13 Option A) then multiplicative devig.
    Returns None if no valid quotes.
    """
    if not book_quotes:
        return None

    yes_probs_raw: list[float] = []
    no_probs_raw: list[float] = []
    yes_steps: list[float] = []
    no_steps: list[float] = []

    for yes_odds, no_odds in book_quotes:
        try:
            yp = american_to_implied(yes_odds)
            np_ = american_to_implied(no_odds)
        except ValueError:
            continue
        yes_probs_raw.append(yp)
        no_probs_raw.append(np_)
        yes_steps.append(american_to_step(yes_odds))
        no_steps.append(american_to_step(no_odds))

    if not yes_probs_raw:
        return None

    p_yes_raw = sum(yes_probs_raw) / len(yes_probs_raw)
    p_no_raw = sum(no_probs_raw) / len(no_probs_raw)
    devig = devig_multiplicative(p_yes_raw, p_no_raw)

    yes_raw_american = step_to_american(sum(yes_steps) / len(yes_steps))
    no_raw_american = step_to_american(sum(no_steps) / len(no_steps))

    return FairValue(
        yes_prob=devig.p_yes,
        no_prob=devig.p_no,
        yes_cents=prob_to_cents(devig.p_yes),
        no_cents=prob_to_cents(devig.p_no),
        yes_american=implied_to_american(devig.p_yes),
        no_american=implied_to_american(devig.p_no),
        yes_raw_avg_american=yes_raw_american,
        no_raw_avg_american=no_raw_american,
    )


# ---------------------------------------------------------------------------
# Three-way fair value (soccer: home / away / draw)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class ThreeWayFairValue:
    home_prob: float
    away_prob: float
    draw_prob: float
    home_cents: int
    away_cents: int
    draw_cents: int
    home_american: float
    away_american: float
    draw_american: float


def compute_three_way_fair(
    book_quotes: list[tuple[float, float, float]],
) -> Optional[ThreeWayFairValue]:
    """Given [(home_american, away_american, draw_american), ...], return fair.

    Same multiplicative devig as two-way, but divides by sum of three
    implied probs: p_fair_i = p_raw_i / (p_raw_home + p_raw_away + p_raw_draw).
    """
    if not book_quotes:
        return None

    home_probs: list[float] = []
    away_probs: list[float] = []
    draw_probs: list[float] = []

    for home_odds, away_odds, draw_odds in book_quotes:
        try:
            hp = american_to_implied(home_odds)
            ap = american_to_implied(away_odds)
            dp = american_to_implied(draw_odds)
        except ValueError:
            continue
        home_probs.append(hp)
        away_probs.append(ap)
        draw_probs.append(dp)

    if not home_probs:
        return None

    n = len(home_probs)
    h_raw = sum(home_probs) / n
    a_raw = sum(away_probs) / n
    d_raw = sum(draw_probs) / n
    total = h_raw + a_raw + d_raw

    if total <= 0:
        return None

    h_fair = h_raw / total
    a_fair = a_raw / total
    d_fair = d_raw / total

    return ThreeWayFairValue(
        home_prob=h_fair,
        away_prob=a_fair,
        draw_prob=d_fair,
        home_cents=prob_to_cents(h_fair),
        away_cents=prob_to_cents(a_fair),
        draw_cents=prob_to_cents(d_fair),
        home_american=implied_to_american(h_fair),
        away_american=implied_to_american(a_fair),
        draw_american=implied_to_american(d_fair),
    )
