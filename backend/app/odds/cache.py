"""Thin Redis wrapper with graceful fallback to an in-memory dict.

The in-memory path keeps local dev working without Redis running, but Redis is
the intended target for any shared deployment so multiple processes/users hit
the same cached Optic responses.
"""
from __future__ import annotations

import json
import time
from typing import Any, Optional

try:
    import redis.asyncio as aioredis
except ImportError:  # pragma: no cover
    aioredis = None  # type: ignore

from ..logging import log

_client: Optional["aioredis.Redis"] = None  # type: ignore[name-defined]
_memory: dict[str, tuple[float, str]] = {}  # key -> (expires_at, json_value)


async def init_cache(redis_url: str) -> None:
    global _client
    if aioredis is None:
        log.warning("cache.redis_unavailable_using_memory")
        return
    try:
        _client = aioredis.from_url(redis_url, decode_responses=True)
        await _client.ping()
        log.info("cache.redis_connected", url=redis_url)
    except Exception as e:  # pragma: no cover
        log.warning("cache.redis_connect_failed_using_memory", error=str(e))
        _client = None


async def close_cache() -> None:
    global _client
    if _client is not None:
        try:
            await _client.aclose()
        except Exception:  # pragma: no cover
            pass
        _client = None


async def get_json(key: str) -> Optional[tuple[Any, int]]:
    """Return (value, age_ms) or None on miss."""
    now = time.time()
    if _client is not None:
        try:
            raw = await _client.get(key)
            ts_raw = await _client.get(f"{key}:ts")
            if raw is not None:
                age_ms = 0
                if ts_raw is not None:
                    try:
                        age_ms = int((now - float(ts_raw)) * 1000)
                    except ValueError:
                        age_ms = 0
                return json.loads(raw), age_ms
        except Exception as e:  # pragma: no cover
            log.warning("cache.get_failed", key=key, error=str(e))
        return None

    entry = _memory.get(key)
    if not entry:
        return None
    expires_at, raw = entry
    if now >= expires_at:
        _memory.pop(key, None)
        return None
    # Best-effort: we don't track written-at in memory mode, return 0.
    return json.loads(raw), 0


async def set_json(key: str, value: Any, ttl_seconds: int) -> None:
    raw = json.dumps(value, default=str)
    if _client is not None:
        try:
            await _client.set(key, raw, ex=ttl_seconds)
            await _client.set(f"{key}:ts", str(time.time()), ex=ttl_seconds)
            return
        except Exception as e:  # pragma: no cover
            log.warning("cache.set_failed", key=key, error=str(e))
    _memory[key] = (time.time() + ttl_seconds, raw)


async def delete(key: str) -> None:
    if _client is not None:
        try:
            await _client.delete(key, f"{key}:ts")
        except Exception:  # pragma: no cover
            pass
    _memory.pop(key, None)
