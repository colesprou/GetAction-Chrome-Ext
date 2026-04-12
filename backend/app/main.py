from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api import fair_value, health, resolve_event
from .config import get_settings
from .logging import configure_logging, log
from .odds.cache import close_cache, init_cache
from .odds.optic_client import close_optic_client, init_optic_client
from .odds.stream import close_stream_manager, init_stream_manager


@asynccontextmanager
async def lifespan(_app: FastAPI):
    settings = get_settings()
    configure_logging(settings.log_level)
    await init_cache(settings.redis_url)
    init_optic_client(settings)
    stream_manager = None
    if settings.odds_source == "stream":
        stream_manager = init_stream_manager(settings)
        stream_manager.start(settings.stream_leagues_list)
    log.info(
        "backend.started",
        sharp_books=settings.sharp_books_list,
        odds_source=settings.odds_source,
        stream_leagues=settings.stream_leagues_list if stream_manager else [],
    )
    try:
        yield
    finally:
        if stream_manager is not None:
            await close_stream_manager()
        await close_optic_client()
        await close_cache()
        log.info("backend.stopped")


app = FastAPI(title="Kalshi Chrome Backend", version="0.1.0", lifespan=lifespan)

# Chrome extensions call from chrome-extension://<id> origins.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(fair_value.router)
app.include_router(resolve_event.router)
