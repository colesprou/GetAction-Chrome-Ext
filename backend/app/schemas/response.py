from typing import Literal, Optional

from pydantic import BaseModel

Signal = Literal["playable", "near_fair", "avoid", "unknown"]
Status = Literal["ok", "low_confidence", "unmapped", "error"]


class MappingInfo(BaseModel):
    strategy: str
    confidence: float
    confidence_label: Literal["high", "medium", "low"]
    books_used: list[str]
    optic_event_id: Optional[str] = None
    market_type: str = "moneyline"
    yes_side: Optional[Literal["home", "away"]] = None


class BookOdds(BaseModel):
    book: str
    yes_american: float
    no_american: float
    draw_american: Optional[float] = None


class SportsbookBlock(BaseModel):
    yes_american: Optional[float] = None
    no_american: Optional[float] = None
    yes_implied: Optional[float] = None
    no_implied: Optional[float] = None
    per_book: list[BookOdds] = []


class FairBlock(BaseModel):
    yes_prob: float
    no_prob: float
    yes_cents: int
    no_cents: int
    yes_american: float
    no_american: float
    # Three-way (soccer): all three outcome probabilities. Null for binary.
    is_three_way: bool = False
    draw_prob: Optional[float] = None
    draw_cents: Optional[int] = None
    draw_american: Optional[float] = None
    home_prob: Optional[float] = None
    home_cents: Optional[int] = None
    away_prob: Optional[float] = None
    away_cents: Optional[int] = None


class EdgeBlock(BaseModel):
    yes_buy_cents: Optional[float] = None
    no_buy_cents: Optional[float] = None
    signal: Signal = "unknown"


class CacheInfo(BaseModel):
    hit: bool
    age_ms: int = 0


class FairValueResponse(BaseModel):
    status: Status
    reason: Optional[str] = None
    warning: Optional[str] = None
    mapping: Optional[MappingInfo] = None
    sportsbook: Optional[SportsbookBlock] = None
    fair: Optional[FairBlock] = None
    edge: Optional[EdgeBlock] = None
    updated_at: Optional[str] = None
    cache: Optional[CacheInfo] = None


class ErrorResponse(BaseModel):
    status: Literal["error"] = "error"
    code: str
    message: str
