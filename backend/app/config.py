from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Optic Odds (api.opticodds.com). The env var keeps its legacy name.
    oddsjam_api_key: str = Field(default="")
    optic_odds_base_url: str = "https://api.opticodds.com/api/v3"

    # Redis
    redis_url: str = "redis://localhost:6379/0"

    # Server
    host: str = "0.0.0.0"
    port: int = 8000
    log_level: str = "INFO"

    # Auth
    extension_shared_token: str = "dev-local-token"

    # Default sharp books for moneyline devig (Optic display-case names).
    # These are used as a fallback when a league doesn't have a more specific
    # entry in per_league_books below. 4-book limit per request → client
    # batches these automatically.
    default_sharp_books: str = "Pinnacle,Betcris,BetOnline,Circa Sports"

    # Per-league overrides. Optic's coverage differs wildly by league:
    #   - MLB & NHL: full sharp coverage (Pinnacle + Betcris + BetOnline + Circa)
    #   - NBA: Pinnacle/Circa/etc. don't post early → use the best available
    #          retail books as the devig source
    #   - NFL: seasonal; when active, sharp coverage is strong
    # Format is JSON-like: "LEAGUE:Book1,Book2,Book3|LEAGUE2:..."
    # Empty string → use default_sharp_books for every league.
    per_league_books: str = (
        "NBA:DraftKings,Caesars,FanDuel,Fanatics"
    )

    edge_playable_cents: float = 2.0
    edge_avoid_cents: float = -2.0

    # Minimum number of sharp books required to publish a fair value.
    min_sharp_books: int = 2

    # Cache TTLs (seconds)
    cache_ttl_fixtures_odds: int = 7
    cache_ttl_fair: int = 3

    # Data source mode.
    #   "rest"   — poll /fixtures + /fixtures/odds on every request (cached).
    #   "stream" — maintain SSE streams per league and read from an in-memory
    #              cache. Requires STREAM_LEAGUES to be set.
    odds_source: str = "rest"
    stream_leagues: str = "MLB,NBA,NHL"

    @property
    def stream_leagues_list(self) -> list[str]:
        return [s.strip().upper() for s in self.stream_leagues.split(",") if s.strip()]

    @property
    def sharp_books_list(self) -> list[str]:
        return [b.strip() for b in self.default_sharp_books.split(",") if b.strip()]

    @property
    def per_league_books_map(self) -> dict[str, list[str]]:
        """Parse the per_league_books env string into a map.

        Format: "LEAGUE1:BookA,BookB|LEAGUE2:BookC,BookD"
        Returns uppercase-league-keyed dict of book lists.
        """
        out: dict[str, list[str]] = {}
        if not self.per_league_books:
            return out
        for chunk in self.per_league_books.split("|"):
            chunk = chunk.strip()
            if not chunk or ":" not in chunk:
                continue
            league, books_str = chunk.split(":", 1)
            league = league.strip().upper()
            books = [b.strip() for b in books_str.split(",") if b.strip()]
            if league and books:
                out[league] = books
        return out

    def books_for_league(self, league: str) -> list[str]:
        """Return the sharp-book list to use for a given league."""
        if not league:
            return self.sharp_books_list
        return self.per_league_books_map.get(league.upper(), self.sharp_books_list)


@lru_cache
def get_settings() -> Settings:
    return Settings()
