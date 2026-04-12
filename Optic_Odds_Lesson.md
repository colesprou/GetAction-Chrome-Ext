# Optic Odds: Complete Integration Lesson

# Optic Odds — Complete Lesson

Everything this repo has learned about Optic Odds: endpoints, auth, market
naming, sharp-book selection, Kalshi ticker mapping, and the gotchas we've
hit in production.

> **Vendor docs:** the raw SSE stream docs live in [stream_odds.md](stream_odds.md).
> This file is the *applied* guide — how we actually use Optic Odds against Kalshi.

---

## 1. The 30-second mental model

Optic Odds is our source of **sharp sportsbook odds**. We use those odds to
compute a **fair probability** for each Kalshi market. The fair price is the
reference we quote against, seed against, and measure CLV against.

```
Optic Odds  ───►  Sharp book odds (Pinnacle, Circa, BetOnline, Betcris, …)
                  │
                  ▼
              devig two-way (multiplicative)
                  │
                  ▼
              fair_home_prob, fair_away_prob  (0–1)
                  │
                  ▼
              compare vs Kalshi yes/no prices  ─►  EV, seed levels, nudges
```

Kalshi is also listed as a "sportsbook" in Optic Odds — **but we don't use its
prices for fair.** We only read the `source_ids.market_id` field off the
Kalshi rows to learn the mapping from Optic fixture/selection → Kalshi ticker.

---

## 2. Auth & base URL

```
Base URL:  https://api.opticodds.com/api/v3
Auth:      x-api-key: <KEY>            (REST)
           ?key=<KEY>                  (SSE — query param, not header)
Env var:   ODDSJAM_API_KEY             (legacy name, never renamed)
```

Both the backend and the seeder load the same key:

- [backend/app/optic_odds.py:36](backend/app/optic_odds.py#L36) — `settings.oddsjam_api_key` → `x-api-key` header
- [seeder/config.py:65](seeder/config.py#L65) — `SeederConfig.optic_odds_api_key`
- [seeder/pricing.py:249](seeder/pricing.py#L249) — passed as `?key=` for the stream

Never hardcode it. If you see `ODDSJAM_API_KEY` referenced, that *is* the
Optic Odds key — the name is historical (Optic Odds used to be OddsJam).

---

## 3. The three endpoints you need

| Endpoint | Method | Purpose | When to use |
|---|---|---|---|
| `/fixtures` | GET | Discover games in a league/date window | Warmup, scheduler, pre-game window checks |
| `/fixtures/odds` | GET | Odds for one or many fixtures, one market | One-shot lookups, periodic REST refresh, fallback when stream lags |
| `/stream/odds/{sport}` | GET (SSE) | Real-time push of odds updates | Primary fair-price feed during live trading |

The `sport` path parameter on the stream endpoint is the **sport family**
(`hockey`, `baseball`, `basketball`, `football`, `soccer`, `tennis`), not the
league. Leagues go in the `league` query param.

### 3a. `/fixtures` — game discovery

```python
GET /api/v3/fixtures
  ?league=MLB
  &limit=50
  &start_date_after=2026-04-10T00:00:00Z
  &start_date_before=2026-04-11T00:00:00Z
```

Used in [seeder/pricing.py:396](seeder/pricing.py#L396) during warmup and
polling fallback.

**Response shape (the fields we care about):**
```json
{
  "data": [
    {
      "id": "abc123",                        // fixture_id — the key
      "home_team_display": "Chicago Cubs",
      "away_team_display": "Pittsburgh Pirates",
      "start_date": "2026-04-10T21:20:00Z",
      "status": "unplayed" | "live" | "completed"
    }
  ]
}
```

Default window if you pass no dates: the backend service defaults to "from 1
day ago" ([backend/app/optic_odds.py:80-83](backend/app/optic_odds.py#L80-L83))
so in-progress games aren't lost. The seeder uses an explicit
`[-6h, +pre_game_window+1h]` window ([seeder/pricing.py:389-391](seeder/pricing.py#L389-L391)).

### 3b. `/fixtures/odds` — the workhorse

Two shapes:

**By fixture (scoped, small):**
```python
GET /api/v3/fixtures/odds
  ?fixture_id=abc123
  &market=moneyline
  &is_main=true
  &sportsbook=Pinnacle
  &sportsbook=Circa%20Sports
  &sportsbook=Kalshi
```

**By league (bulk, avoids N+1):**
```python
GET /api/v3/fixtures/odds
  ?league=NHL
  &market=moneyline
  &is_main=true
  &sportsbook=Pinnacle&sportsbook=Kalshi&...
```

- `sportsbook` is a **repeated query param**, not comma-separated. `httpx`
  and `requests` handle this automatically when you pass a list.
- `is_main=true` keeps you on main lines only — crucial for moneyline,
  spread, total. Don't set it for alt-line player props if you want every
  strike/run line.
- Prefer `league=` over per-fixture calls when you need the whole slate —
  it's one request for N games. See [backend/app/optic_odds.py:156](backend/app/optic_odds.py#L156).

**Response shape:**
```json
{
  "data": [
    {
      "id": "abc123",
      "home_team_display": "...",
      "odds": [
        {
          "sportsbook": "Pinnacle",
          "selection": "Chicago Cubs",
          "selection_line": "over" | "under" | null,   // only for props/totals
          "price": -135,                                 // American odds
          "points": 6.5,                                 // only for props/totals
          "market": "moneyline",
          "is_main": true,
          "limits": {"max": 5000, "max_stake": 5000},   // Pinnacle/Circa have these
          "source_ids": {
            "market_id": "KXMLBGAME-26APR101420PITCHC-CHC"   // ← Kalshi ticker!
          }
        }
      ]
    }
  ]
}
```

The critical field is `source_ids.market_id` — present on **Kalshi** rows and
contains the exact Kalshi ticker. That's our mapping edge.

### 3c. `/stream/odds/{sport}` — SSE firehose

```python
GET /api/v3/stream/odds/baseball
  ?key=<api_key>
  &sportsbook=Pinnacle&sportsbook=Circa%20Sports&sportsbook=Kalshi&...
  &market=Moneyline
  &league=MLB
  &is_main=true
  &last_entry_id=<resume_from>     # optional, for reconnect
```

Note: auth is `?key=`, not the `x-api-key` header (the header works too but
our code uses the query param for streams — [seeder/pricing.py:249](seeder/pricing.py#L249)).

Use the `sseclient-py` library (not `sseclient` — different package). Events
we handle:

| Event name | Meaning | What we do |
|---|---|---|
| `connected` | Initial handshake | Set `_connected = True` |
| `odds` | Live odds update | Parse, update in-memory game, recompute fair, fire callback |
| `locked-odds` | Market locked (can't bet) | Clear the price (set to None), keep tracking |
| `ping` | Heartbeat (every few seconds) | Ignore or log at DEBUG |
| `fixture-status` | Status change (unplayed→live→completed) | Log, optional cleanup |

Every `odds` event carries an `entry_id`. **Save it** and pass as
`last_entry_id` on reconnect so you don't miss updates during a blip.
See [seeder/pricing.py:255](seeder/pricing.py#L255) and [stream_odds.py:428](backend/app/stream_odds.py#L428).

**Stream event shape** (one row per book×selection, streamed independently):
```json
{
  "entry_id": "01H...",
  "fixture_id": "abc123",
  "home_team_display": "Chicago Cubs",
  "away_team_display": "Pittsburgh Pirates",
  "start_date": "2026-04-10T21:20:00Z",
  "sportsbook": "Pinnacle",
  "selection": "Chicago Cubs",
  "price": -135,
  "limits": {"max": 5000},
  "source_ids": {"market_id": "KXMLBGAME-..."}
}
```

---

## 4. League → Sport mapping

The stream endpoint wants the **sport family** in the path. Internal league
names → Optic sport:

```python
# seeder/config.py:164
LEAGUE → SPORT
  NHL    → hockey
  NBA    → basketball
  NCAAB  → basketball
  NCAAW  → basketball
  MLB    → baseball
  NFL    → football
  ATP    → tennis
  WTA    → tennis
  SOCCER → soccer
```

Canonical sources:
- [seeder/config.py:164-172](seeder/config.py#L164-L172) — `_league_optic_sport`
- [backend/app/stream_odds.py:30-39](backend/app/stream_odds.py#L30-L39) — `LEAGUE_SPORT_MAP`

### Special case: soccer has *many* leagues under one sport

Soccer isn't one `league` value — it's ~40 regional league IDs passed as a
list. See [backend/app/stream_odds.py:42-84](backend/app/stream_odds.py#L42-L84)
for the full `SOCCER_OPTIC_LEAGUES` array (EPL, La Liga, Bundesliga, …). For
soccer, pass the whole list as repeated `league=` params.

Tennis is similar: `ATP`, `WTA`, `ATP Challenger` under sport `tennis`.

Best practice: group up to ~10 leagues per stream connection (vendor's advice
in [stream_odds.md:15](stream_odds.md#L15)).

---

## 5. Market names — they are not consistent

The `market` query param uses **display-case** strings, and MLB has overrides
because "spread" in football ≠ "run line" in baseball.

Canonical table from [seeder/pricing.py:489-506](seeder/pricing.py#L489-L506):

```python
MARKET_TYPE_MAP = {
    "moneyline":       "moneyline",
    "spread":          "Point Spread",
    "total":           "Total Points",
    "strikeouts":      "Player Strikeouts",
    "hits_runs_rbis":  "Player Hits + Runs + RBIs",
    "yrfi_nrfi":       "No Runs First Inning",
    "hits":            "Player Hits",
    "total_bases":     "Player Bases",
    "home_runs":       "Player Home Runs",
    "1h_moneyline":    "1st Half Moneyline",
    "1h_spread":       "1st Half Point Spread",
    "1h_total":        "1st Half Total Points",
}

# MLB overrides — the same "spread"/"total" keys map to different markets
MLB_MARKET_OVERRIDES = {
    "spread": "Run Line",
    "total":  "Total Runs",
}
```

**Stream endpoint quirk:** the stream takes `market=Moneyline` (capital M),
REST takes `market=moneyline` (lowercase). Both work in most cases but match
the existing code's casing for consistency.

---

## 6. Sharp books — pick the right set for the market

Not every book is sharp for every market. Books are grouped by purpose:

```python
# Moneyline / spread / total devig
ML_BOOKS       = ["Pinnacle", "Betcris", "BetOnline", "Circa Sports"]
ML_EXTRA_BOOKS = ["BetAmapola", "Kalshi"]   # Kalshi for ticker mapping, not devig

# Player props (strikeouts, hits, HR, etc.)
PROP_BOOKS       = ["Pinnacle", "DraftKings", "Blue Book", "BetMGM"]
PROP_EXTRA_BOOKS = ["Caesars", "Props Builder"]

# YRFI / NRFI
RFI_BOOKS       = ["Pinnacle", "DraftKings", "Blue Book", "BetMGM"]
RFI_EXTRA_BOOKS = ["Caesars", "Props Builder", "FanDuel"]
```

Source: [seeder/pricing.py:509-514](seeder/pricing.py#L509-L514).

### The 4-book-per-request limit

Optic Odds will return **400 errors** if you ask for too many sportsbooks in
one `/fixtures/odds` request. Our solution: batch the book list into chunks
of ~4 and merge the responses client-side.

Reference: [seeder/prop_pricing.py:101](seeder/prop_pricing.py#L101):
```python
book_batches = [books[:4], books[4:]] if len(books) > 4 else [books]
```

And the moneyline version at [seeder/pricing.py:572](seeder/pricing.py#L572):
```python
for book_batch in [primary_books + ["Kalshi"], extra_books]:
```

Always append `"Kalshi"` to the **first** batch so the ticker mapping comes
back in the same call as primary sharp books.

---

## 7. Devig math (two-way)

The fair price is the vig-free midpoint of sharp book lines. We use the
**multiplicative** method: divide each book's implied prob by the total of
that book's probs (removes the overround), then average across books.

```python
# seeder/pricing.py:31
def american_to_probability(american: int) -> float:
    return (-american) / (-american + 100) if american < 0 else 100 / (american + 100)

# Multiplicative two-way devig, averaged across books
def devig_two_way(odds, books, weights, min_books=2):
    home_probs, away_probs = [], []
    for book in books:
        h, a = odds[book]["home"], odds[book]["away"]
        ph, pa = american_to_probability(h), american_to_probability(a)
        total = ph + pa                                    # > 1.0 (the vig)
        home_probs.append((ph / total, weights[book]))     # normalize
        away_probs.append((pa / total, weights[book]))
    if len(home_probs) < min_books:
        return None
    w = sum(w for _, w in home_probs)
    return (sum(p*w for p,w in home_probs) / w,
            sum(p*w for p,w in away_probs) / w)
```

Three-way (soccer) works the same way — divide by `home+draw+away`. See
[backend/app/stream_odds.py:135-174](backend/app/stream_odds.py#L135-L174).

Weights default to 1.0 for every book; they're in the config so you can
over-weight Pinnacle later if you want ([seeder/config.py:119](seeder/config.py#L119)).

### Two-sided prop devig (over/under)

Same math but per `(player, line)` or `(game, total_points)` tuple:
1. Group odds by `(selection, points)` — e.g. `("Blake Snell", 6.5)`
2. For each group, average `over_prob / (over_prob + under_prob)` across
   sharp books → `over_fair`.
3. `under_fair = 1 - over_fair`.

Reference: [seeder/prop_pricing.py:155-206](seeder/prop_pricing.py#L155-L206).

---

## 8. Kalshi ticker mapping — three strategies

This is the whole reason we use Optic Odds against Kalshi: the same fixture
needs to be identified in both systems. Three strategies, in order of
preference:

### Strategy A — `source_ids.market_id` off the Kalshi row (PREFERRED)

When you include `"Kalshi"` in the `sportsbook` param, Optic Odds returns
Kalshi rows with `source_ids.market_id` populated to the exact Kalshi ticker.
One row per side (YES on each outcome).

```python
# seeder/pricing.py:338-345 (stream version)
if sportsbook == "Kalshi":
    source_ids = data.get("source_ids") or {}
    market_id = source_ids.get("market_id")
    if market_id and selection:
        if selection == game.home_team:
            game.home_kalshi_ticker = market_id
        elif selection == game.away_team:
            game.away_kalshi_ticker = market_id
```

For props, the Kalshi row's `selection_line == "over"` is the one that maps
to the Kalshi YES ticker:
```python
# seeder/prop_pricing.py:145
if sb == "Kalshi" and market_id and sel_line == "over":
    kalshi_tickers[(player, pts)] = market_id
```

**Strategy A fails when:** Optic Odds hasn't linked that specific Kalshi
market yet (common for obscure props or newly listed games). Fall back to B.

### Strategy B — name-based fallback against Kalshi series

Query Kalshi directly for all markets in a series, then match by
`(player_last_name, threshold)` or `(teams, threshold)`:

```python
# seeder/prop_pricing.py:216-252  (strikeouts example)
markets = await kalshi.get_markets_by_series("KXMLBKS", status="open", limit=200)
# yes_sub_title looks like "Blake Snell: 7+"
lookup = {}
for m in markets:
    sub = m["yes_sub_title"]                 # "Blake Snell: 7+"
    name_part = sub.split(":")[0].strip()    # "Blake Snell"
    threshold = int(sub.split(":")[1].strip().replace("+", ""))
    last_name = name_part.split()[-1].lower()  # "snell"
    lookup[(last_name, threshold)] = m["ticker"]

# Then for each devigged line:
last_name = line.player_name.split()[-1].lower()
line.kalshi_ticker = lookup.get((last_name, line.threshold))
```

For totals: Kalshi threshold lives at the **end of the ticker**, e.g.
`KXMLBTOTAL-26MAR281415TBSTL-8` is "8 or more runs" (so it matches Optic's
"Over 7.5" line). Parse `int(ticker.split("-")[-1])` and compare
against `int(optic_points + 0.5)` — [seeder/prop_pricing.py:404-435](seeder/prop_pricing.py#L404-L435).

### Strategy C — team-name matching across responses

When warming up from REST and you don't have a clean Kalshi row, match games
by `(home_team, away_team)` across the two datasets. Used in the warmup path
at [backend/app/stream_odds.py:615-620](backend/app/stream_odds.py#L615-L620).

### The line-mismatch filter (totals / props)

If the sharp consensus line is **Over 7.5** but Kalshi only lists a "7+" or
"9+" market, **don't seed** — the fair price you computed doesn't apply.
[seeder/prop_pricing.py:334-348](seeder/prop_pricing.py#L334-L348) explicitly
skips when there's no exact threshold match. Cheap bugs hide here.

---

## 9. REST vs. Stream — when to use which

| Situation | Use |
|---|---|
| Warmup on startup | REST `/fixtures` + `/fixtures/odds` |
| Main live fair-price feed | `/stream/odds/{sport}` |
| Some books go stale mid-stream (Circa is the worst offender) | Periodic REST refresh every 30s alongside the stream |
| One-off dashboard / lookup | REST, with a wide time window |
| Seeder pre-game discovery | REST per poll interval |

The backend runs both: a stream thread **and** a periodic REST refresh thread
that backfills books Circa/Betcris don't push frequently. See
[backend/app/stream_odds.py:502-613](backend/app/stream_odds.py#L502-L613)
for the refresh loop.

---

## 10. Production gotchas we've hit

1. **Circa Sports goes stale on the stream.** Circa pushes SSE events much
   less often than Pinnacle. If you rely on stream-only, Circa's last price
   is minutes old. The fix: the 30-second periodic REST refresh on the
   backend. Seeder currently tolerates this because it averages across books
   and requires `min_books >= 2`.

2. **`>4 sportsbooks → HTTP 400`** on `/fixtures/odds`. Always batch.

3. **`stream/odds` vs `stream/odds/{sport}`** — the sport path is required.
   Don't pass `league=MLB` to `stream/odds/football` or you'll get empty
   streams and no error.

4. **`market` casing on the stream** — use `"Moneyline"` on the stream,
   `"moneyline"` on REST. Mixing them works but our code is consistent.

5. **`selection_line` is lowercase.** Optic sends `"Over"` or `"over"`
   depending on endpoint — always `.lower()` it before comparing.
   See [seeder/pricing.py:604](seeder/pricing.py#L604).

6. **Selection strings for player props can drift.** "Blake Snell" vs
   "B. Snell" vs "Snell, Blake". The Strategy B fallback uses **last name
   only**. If two pitchers share a last name (rare), this breaks silently.

7. **Kalshi `selection_line`** on Optic rows is `"over"` for the YES ticker,
   `"under"` for the NO ticker. YRFI/NRFI uses `"yes"` / `"no"` instead —
   see [seeder/pricing.py:707-711](seeder/pricing.py#L707-L711) for the
   special-casing.

8. **`limits.max`** is only populated for Pinnacle and Circa. BetOnline /
   Betcris usually return `null`. Don't treat missing limits as zero —
   treat as unknown. [seeder/pricing.py:354-356](seeder/pricing.py#L354-L356).

9. **`is_main=true` is critical** for moneyline/spread/total or you'll get
   a deluge of alt-line rows. Omit it only when you specifically want every
   line for a prop.

10. **Reconnect with `last_entry_id`** or you lose updates during the gap.
    It's a string, not an int — store it verbatim.

11. **Devig with `min_books >= 2`.** One-book fair is not sharp enough —
    Pinnacle alone is fine mathematically but has no redundancy check.
    [seeder/config.py:125](seeder/config.py#L125).

---

## 11. End-to-end example: MLB moneyline seeder path

Here's how the seeder actually does it, top to bottom:

```
1. seeder/main.py startup
   └─ PricingEngine.poll_once()                [REST warmup]
      └─ GET /fixtures?league=MLB&start_date_after=...&start_date_before=...
      └─ for each fixture:
          GET /fixtures/odds?fixture_id=<id>
              &sportsbook=Pinnacle&sportsbook=Circa+Sports&...&sportsbook=Kalshi
              &market=moneyline&is_main=true
          └─ Process each odd:
             - sportsbook == "Kalshi" → extract source_ids.market_id → map ticker
             - sportsbook in sharp_books → store price in sharp_odds dict
             - store limits.max

2. PricingEngine.start_stream()
   └─ Thread per league → GET /stream/odds/baseball?key=...&sportsbook=...&market=Moneyline&league=MLB
      └─ SSE events:
         - "connected" → set connected=True
         - "odds" → _process_odds_event:
             - Update game's sharp_odds
             - last_entry_id = event.entry_id
             - Fire callback(fixture_id, home_fair, away_fair) if sharp book
         - "locked-odds" → price = None
      └─ On disconnect: reconnect with last_entry_id

3. Seeder strategy loop
   └─ For each tracked game:
      - fair_yes, _, ts = pricing_engine.get_fair_price(kalshi_ticker)
      - EV% = (fair_no * (100-P) - fair_yes * P) / P * 100    # buying No
      - If EV% >= min_ev_pct and !stale(ts):
          → place seed at P cents
```

---

## 12. Quick reference — code you'll actually edit

| Need | File | Function |
|---|---|---|
| Add a new league | [seeder/config.py:164](seeder/config.py#L164) | `_league_optic_sport` |
| Add a new market type | [seeder/pricing.py:489](seeder/pricing.py#L489) | `MARKET_TYPE_MAP` |
| Change sharp books for a market | [seeder/pricing.py:509](seeder/pricing.py#L509) | `ML_BOOKS` / `PROP_BOOKS` |
| Change devig weights | [seeder/config.py:119](seeder/config.py#L119) | `book_weights` |
| Change min books | [seeder/config.py:125](seeder/config.py#L125) | `SEEDER_MIN_BOOKS` env |
| Tune stream reconnect | [seeder/pricing.py:242](seeder/pricing.py#L242) | `_run_stream` |
| Add a new prop type | [seeder/prop_pricing.py](seeder/prop_pricing.py) | `fetch_*_lines` |
| Map props by name fallback | [seeder/prop_pricing.py:216](seeder/prop_pricing.py#L216) | `_match_kalshi_*_tickers` |
| Backend fair price service | [backend/app/optic_odds.py](backend/app/optic_odds.py) | `OpticOddsService` |
| Backend streaming service | [backend/app/stream_odds.py](backend/app/stream_odds.py) | `StreamOddsService` |

---

## 13. Cheat sheet — curl to sanity-check

```bash
# API key from your .env
export OO_KEY="$ODDSJAM_API_KEY"

# 1. Any MLB games today?
curl -s -H "x-api-key: $OO_KEY" \
  "https://api.opticodds.com/api/v3/fixtures?league=MLB&limit=5" \
  | jq '.data[] | {id, home_team_display, away_team_display, start_date}'

# 2. Moneyline odds for one fixture, with Kalshi mapping
curl -s -H "x-api-key: $OO_KEY" \
  "https://api.opticodds.com/api/v3/fixtures/odds?fixture_id=<ID>&market=moneyline&is_main=true&sportsbook=Pinnacle&sportsbook=Circa%20Sports&sportsbook=Kalshi" \
  | jq '.data[0].odds[] | {sportsbook, selection, price, ticker: .source_ids.market_id}'

# 3. Stream test (will run forever — Ctrl-C)
curl -N "https://api.opticodds.com/api/v3/stream/odds/baseball?key=$OO_KEY&sportsbook=Pinnacle&sportsbook=Kalshi&market=Moneyline&league=MLB&is_main=true"
```
