from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Optional

Signal = Literal["playable", "near_fair", "avoid", "unknown"]


@dataclass(frozen=True)
class EdgeResult:
    yes_buy_cents: Optional[float]
    no_buy_cents: Optional[float]
    signal: Signal


def compute_edge(
    fair_yes_cents: int,
    fair_no_cents: int,
    best_ask_yes: Optional[int],
    best_ask_no: Optional[int],
    playable_threshold: float = 2.0,
    avoid_threshold: float = -2.0,
) -> EdgeResult:
    """Edge in cents for buying YES or NO at Kalshi's best ask.

    Positive edge means the ask is below fair (good for the buyer).
    Signal uses the best of the two edges — if at least one side is playable,
    the signal is playable.
    """
    yes_edge = (fair_yes_cents - best_ask_yes) if best_ask_yes is not None else None
    no_edge = (fair_no_cents - best_ask_no) if best_ask_no is not None else None

    edges = [e for e in (yes_edge, no_edge) if e is not None]
    if not edges:
        return EdgeResult(yes_edge, no_edge, "unknown")

    best = max(edges)
    worst = min(edges)

    if best >= playable_threshold:
        signal: Signal = "playable"
    elif worst <= avoid_threshold:
        signal = "avoid"
    else:
        signal = "near_fair"

    return EdgeResult(
        yes_buy_cents=yes_edge,
        no_buy_cents=no_edge,
        signal=signal,
    )
