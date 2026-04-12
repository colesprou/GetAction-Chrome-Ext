from typing import Optional

from pydantic import BaseModel, Field


class Orderbook(BaseModel):
    best_bid_yes: Optional[int] = None
    best_ask_yes: Optional[int] = None
    best_bid_no: Optional[int] = None
    best_ask_no: Optional[int] = None


class FairValueRequest(BaseModel):
    ticker: str = Field(..., description="Kalshi market ticker, e.g. KXNBAGAME-26APR10LALORL-LAL")
    title: Optional[str] = None
    subtitle: Optional[str] = None
    event_start: Optional[str] = Field(
        default=None, description="ISO8601 UTC event start time, best-effort from DOM"
    )
    teams: Optional[list[str]] = None
    yes_label: Optional[str] = Field(
        default=None, description="Human-readable team that Kalshi YES refers to"
    )
    orderbook: Optional[Orderbook] = None
    books_override: Optional[dict[str, list[str]]] = Field(
        default=None,
        description="Per-league book overrides from user settings. Keys are league strings, values are book name lists.",
    )
