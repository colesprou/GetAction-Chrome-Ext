# Kalshi Sharp Fair Value — Chrome Extension + Backend

Overlays sharp-book (Pinnacle / Betcris / BetOnline / Circa Sports) devigged
fair value on top of Kalshi sports markets. MVP targets **pregame moneylines**.

## Repo layout

```
backend/            FastAPI service (Optic Odds v3 client + ticker lookup + fair value)
extension/          Chrome Manifest V3 extension (vanilla JS, no build step)
infra/              docker-compose + deploy notes
KALSHI_SPORTSBOOK_KNOWLEDGE.md   product spec
Optic_Odds_Lesson.md             Optic Odds API reference (read this first)
```

## Quickstart

### 1. Run the backend locally

```bash
cd backend
cp .env.example .env
# Paste your Optic Odds key into ODDSJAM_API_KEY (legacy name kept for parity
# with the rest of the stack).
python3.11 -m venv .venv
.venv/bin/pip install -e ".[dev]"
.venv/bin/pytest                            # 26 tests
.venv/bin/uvicorn app.main:app --reload     # http://localhost:8000
```

Redis is optional in dev — the cache falls back to an in-memory dict.

Smoke test:
```bash
curl http://localhost:8000/health
curl -X POST http://localhost:8000/fair-value \
  -H 'Content-Type: application/json' \
  -H 'X-Extension-Token: dev-local-token' \
  -d '{"ticker":"KXMLBGAME-26APR101420PITCHC-CHC"}'
```

### 2. Load the Chrome extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select the `extension/` folder
4. Click the extension icon → set **Backend URL** to `http://localhost:8000`
5. Visit a Kalshi sports market page — the overlay appears bottom-right

### 3. Deploy the backend (Railway, simplest path)

See `infra/deploy-notes.md`. Once deployed, update the backend URL in the
extension popup.

## Architecture

```
[Kalshi page]  content script extracts {ticker, orderbook}
      │
      ▼
[FastAPI /fair-value]
      │  1. extract Kalshi league from ticker prefix
      │  2. Optic GET /fixtures/odds?league=X&market=moneyline&is_main=true
      │       └── batched by 4 sportsbooks, Kalshi always in first batch
      │  3. scan merged fixtures for the Kalshi row with
      │       source_ids.market_id == ticker
      │  4. collect sharp-book (YES, NO) quotes on that same fixture
      │  5. require ≥ MIN_SHARP_BOOKS quotes
      │  6. probability-scale average + multiplicative devig
      │  7. edge vs. Kalshi best ask + signal
      ▼
{ fair: {yes_cents, no_cents, ...}, edge: {...}, signal: "playable" }
```

## Why this pipeline is short

The **killer feature** of Optic Odds for this use case: when `"Kalshi"` is in
your sportsbook list, every Kalshi row's response carries
`source_ids.market_id` set to the exact Kalshi ticker. That means we never
have to normalize team names, fuzzy-match fixtures, or maintain alias tables —
we look the ticker up directly in the bulk response.

Kalshi's YES-side orientation comes from the same row: the Kalshi row's
`selection` is the team that corresponds to YES. Match it against
`home_team_display` / `away_team_display` to get `yes_side`.

## Key design decisions (all anchored in `Optic_Odds_Lesson.md`)

- **Display-case sportsbook names**: `Pinnacle`, `Betcris`, `BetOnline`, `Circa Sports`
- **Repeated `sportsbook=` query params**, not comma-separated
- **4-book batch limit** on `/fixtures/odds` → client splits and merges
- **Always include Kalshi in the first batch** so ticker mapping and sharp quotes
  arrive together whenever possible
- **`is_main=true`** for moneyline/spread/total — avoids alt-line deluge
- **`min_sharp_books=2`** before publishing fair — one-book fair isn't sharp
- **Probability-scale averaging** then **multiplicative devig**
- **`x-api-key`** header auth for REST
- **MV3 extension has no build step** — single IIFE content script

## API

### `POST /fair-value`

Request headers: `X-Extension-Token: <token>`

```json
{
  "ticker": "KXMLBGAME-26APR101420PITCHC-CHC",
  "orderbook": {
    "best_ask_yes": 54,
    "best_ask_no": 48
  }
}
```

(The `title`, `yes_label`, `teams` fields still exist for forward-compat but
are no longer used by the pipeline — Optic's response is the source of truth.)

Responses: `ok` | `unmapped` | `error`.

```json
{
  "status": "ok",
  "mapping": {
    "strategy": "source_ids_market_id",
    "confidence": 0.99,
    "confidence_label": "high",
    "books_used": ["Pinnacle", "Circa Sports"],
    "optic_event_id": "fixt_abc123",
    "market_type": "moneyline",
    "yes_side": "home"
  },
  "sportsbook": {"yes_american": -132, "no_american": 122, ...},
  "fair": {
    "yes_prob": 0.568, "no_prob": 0.432,
    "yes_cents": 57, "no_cents": 43,
    "yes_american": -132, "no_american": 132
  },
  "edge": {"yes_buy_cents": 3, "no_buy_cents": -5, "signal": "playable"},
  "updated_at": "2026-04-10T18:23:01Z",
  "cache": {"hit": false, "age_ms": 0}
}
```

## Known limits (MVP)

- **Moneyline only.** Spreads/totals need the lesson §12 line conversion
  plumbing (not built).
- **Pregame only.** In-play is covered by the same endpoint but the fair is
  less reliable because sharp books drop lines.
- **`ticker_not_in_optic_response`** means Optic hasn't linked that Kalshi
  market yet. This is expected for newly listed games; retry in a few minutes.
- **Scraper selectors are guesses.** Kalshi's DOM will change; update
  `SELECTORS` in `extension/src/content/content.js`.

## Extending

- **Add a league**: add a prefix to `KALSHI_LEAGUE_PREFIXES` in
  `app/mapping/kalshi_parser.py` and make sure Optic returns that league name.
- **Swap/adjust sharp books**: `DEFAULT_SHARP_BOOKS` env var.
- **Swap devig method**: replace `devig_multiplicative` in `app/fair_value.py`.
- **SSE streaming**: add a background task that subscribes to
  `/stream/odds/{sport}` and pushes fixture updates into the same cache key
  (`fixtures_odds:ml:<league>`). Everything downstream stays the same.
- **Spreads/totals**: branch in `get_league_moneyline` by market and apply the
  lesson §12 step-scale line conversion when the Kalshi line differs from the
  sharp book line.
