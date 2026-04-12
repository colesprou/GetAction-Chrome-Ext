# Deployment Notes

## Local dev

```bash
cd backend
cp .env.example .env
# Paste your Optic Odds key into ODDSJAM_API_KEY (legacy env name).
python3.11 -m venv .venv
.venv/bin/pip install -e ".[dev]"
.venv/bin/pytest
.venv/bin/uvicorn app.main:app --reload
```

Redis is optional locally — the cache falls back to an in-memory dict.

## Docker (local or VPS)

```bash
cd infra
echo "ODDSJAM_API_KEY=..." > .env
docker compose up --build
```

## Railway (easiest MVP deploy)

1. Create a new Railway project
2. Add service from repo, root = `backend/`
3. Add the Railway Redis plugin → auto-sets `REDIS_URL`
4. Set env vars:
   - `ODDSJAM_API_KEY`
   - `EXTENSION_SHARED_TOKEN` (generate a random string)
   - `DEFAULT_SHARP_BOOKS` = `Pinnacle,Betcris,BetOnline,Circa Sports`
5. Railway autodetects the Dockerfile and deploys
6. Copy the public URL into the extension popup

## Render

Same pattern — Web Service from repo, Dockerfile at `backend/Dockerfile`, add
the Redis add-on, set the env vars above.

## Post-deploy smoke tests

```bash
curl $URL/health

# Real ticker check — replace with a live MLB moneyline ticker
curl -X POST $URL/fair-value \
  -H "Content-Type: application/json" \
  -H "X-Extension-Token: $EXTENSION_SHARED_TOKEN" \
  -d '{"ticker":"KXMLBGAME-26APR101420PITCHC-CHC"}'
```

Expected statuses:
- `ok` — fair value computed
- `unmapped` / `ticker_not_in_optic_response` — Optic doesn't have this game
  in the sharp-book slice yet (game too far out, or sharp books haven't posted)
- `unmapped` / `insufficient_sharp_books_N` — fewer than `MIN_SHARP_BOOKS` had
  both sides quoted
