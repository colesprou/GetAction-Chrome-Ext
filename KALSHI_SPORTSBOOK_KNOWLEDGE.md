# Kalshi × Sportsbook Odds: Knowledge Base

Foundational reference for mapping sportsbook odds to Kalshi prediction markets, computing fair value, and reasoning about edge.

---

## 1. Kalshi System Overview

**Kalshi** is a CFTC-regulated event contract exchange. Users trade binary contracts on real-world outcomes (sports, elections, weather, economics). Unlike a sportsbook, Kalshi is a **two-sided exchange** — users trade against each other, not the house. Kalshi earns revenue through fees, not vig.

### Binary Contract Structure

Every Kalshi market is a **binary YES/NO contract** that settles at either **$1.00** (100¢) or **$0.00** (0¢) at expiration:

- If the event occurs, **YES** contracts pay out $1.00
- If the event does not occur, **NO** contracts pay out $1.00
- The two sides are complementary: `YES_price + NO_price = 100¢` (approximately, modulo spread)

### Prices as Probabilities

Because contracts settle at $1.00 or $0.00, the **current price equals the implied probability**:

- A YES contract trading at **63¢** implies a 63% probability the event occurs
- A NO contract trading at **37¢** implies a 37% probability the event does not occur
- Prices are quoted in whole cents (1¢ to 99¢). 0¢ and 100¢ represent settled states

This is the core mental model: **cents = probability percentage**.

### Orderbook Mechanics

Kalshi runs a traditional central limit order book (CLOB):

- **Bid** = the highest price someone is willing to pay to buy
- **Ask** = the lowest price someone is willing to sell at
- **Spread** = Ask − Bid (narrower spreads indicate more liquid markets)
- **Depth** = total quantity of contracts resting at each price level

A crucial quirk: Kalshi has **two separate orderbooks per market** — one for YES and one for NO. Because `YES + NO = 100`, a YES bid at 63¢ is functionally equivalent to a NO ask at 37¢. Most UIs derive one side from the other.

### How Traders Interact

Two order types dominate:

- **Maker orders**: rest in the book, earn maker rebates (or lower fees), but carry queue/execution risk
- **Taker orders**: cross the spread immediately, pay taker fees, get filled now

Kalshi's fee structure favors makers (often ~0.875% of notional for maker fills vs. higher for takers), so **resting orders at favorable prices** is the dominant strategy for edge-seeking traders.

### Key Definitions

| Term | Meaning |
|---|---|
| **Event** | A real-world happening (e.g., "NBA Game: Lakers @ Nuggets, 2026-03-15") |
| **Market** | A specific YES/NO contract tied to an event (e.g., "Lakers win" or "Total points > 220.5") |
| **Ticker** | Unique ID for a market (e.g., `KXNBAGAME-26MAR15LALDEN-LAL`) |
| **Contract** | A single binary position that pays $1.00 or $0.00 |
| **Series** | A repeating market family (e.g., NBA game winners) |

### YES vs NO Framing

One event can produce multiple phrasings:

- Kalshi may list: "Will the Lakers win?" — YES = Lakers win, NO = Nuggets win
- The inverse market is implicit: buying NO Lakers = betting Nuggets
- **Spread markets** are usually phrased from one side only: "Will the Lakers win by more than 5.5?" — YES = Lakers cover -5.5, NO = Nuggets cover +5.5

The phrasing determines which sportsbook side corresponds to YES. Getting this mapping wrong inverts the probability and produces nonsense fair values.

---

## 2. Kalshi Market Structure (Technical View)

### Ticker Conventions

Kalshi tickers encode sport, series, event date/matchup, and outcome:

```
KXNBAGAME-26MAR15LALDEN-LAL
│  │      │               │
│  │      │               └─ outcome suffix (team code)
│  │      └────────────────── event identifier (date + teams)
│  └──────────────────────── series (NBA game winner)
└────────────────────────── Kalshi Exchange prefix
```

For a head-to-head matchup, Kalshi typically creates **two tickers** (one per team) — `-LAL` and `-DEN`. Both are live markets; you can make bids on either. The YES side of `-LAL` corresponds to "Lakers win"; the YES side of `-DEN` corresponds to "Nuggets win".

Spread and total markets use a different pattern:

```
KXNBASPREAD-26MAR15LALDEN-LAL-5    # Lakers cover -5.5
KXNBATOTAL-26MAR15LALDEN-225       # Over 225.5 total points
```

### Event Grouping

Kalshi groups related markets into **events**:

- One event ≈ one real-world game
- Under that event: moneyline markets (2 tickers), spread markets (N tickers for different lines), total markets (N tickers for different totals)
- The `event_ticker` is the shared prefix (e.g., `KXNBAGAME-26MAR15LALDEN`)

### Pricing Internals

Kalshi's API returns prices in two forms:

- **Integer cents**: `yes_price: 63` (legacy)
- **Dollar strings**: `yes_price_dollars: "0.6300"` (post-2026 migration, fixed-point precision)

Orders must include both `count` (int) and `count_fp` (string) fields. Queue positions and quantities are returned as `*_fp` strings.

### Data Needed to Work With a Market

To uniquely identify and price a Kalshi market, you need:

1. **ticker** — unique ID
2. **event_ticker** — parent event grouping
3. **title/subtitle** — human-readable outcome description (critical for mapping to sportsbook sides)
4. **current orderbook** — best bid/ask per side
5. **last trade price** — for context, not pricing
6. **open interest / volume** — liquidity indicators
7. **close_time** — when the market stops trading

Best bid/ask are the actionable numbers. Mid-price (`(bid + ask) / 2`) is a rough fair proxy but usually biased by market microstructure.

---

## 3. Sportsbook Odds Fundamentals

### American Odds

The dominant US odds format. Two forms:

- **Negative** (favorite): `-150` means you bet $150 to win $100
- **Positive** (underdog): `+130` means you bet $100 to win $130
- `-100` and `+100` both represent even money (50%)
- There is a "gap" between -100 and +100 — no value exists between them; odds jump from -100 directly to +100

### Implied Probability from American Odds

| Sign | Formula |
|---|---|
| Negative (`-O`) | `|O| / (|O| + 100)` |
| Positive (`+O`) | `100 / (O + 100)` |

Example:
- `-150` → `150 / 250 = 0.600` → 60.0%
- `+130` → `100 / 230 = 0.4348` → 43.5%
- Sum = 103.5% — the extra 3.5% is **vig** (house edge)

### Market Types

| Market | Description | Structure |
|---|---|---|
| **Moneyline (ML)** | Which team wins outright | 2-sided (home/away) |
| **Spread** | Which team covers the point spread | 2-sided, one line (e.g., -5.5/+5.5) |
| **Total (O/U)** | Combined score vs. a line | 2-sided (over/under, one number) |
| **Player props** | Individual stat lines | N-sided, market-dependent |

### Moneyline as MVP Focus

Moneyline is the simplest to map because:

- Exactly 2 outcomes (matches binary Kalshi structure)
- No line variance between books (all books price the same binary outcome)
- Direct team-to-team correspondence
- Devig math is straightforward

Spread and total introduce **line shopping** — different books post different spread/total numbers, requiring normalization (covered later).

### Sportsbook Pricing Differences

Not all books are priced equally:

- **Sharp books** (Pinnacle, Circa, BetCRIS, BetOnline) have narrow margins and react to information fast. Their prices are the closest to true probability
- **Recreational books** (DraftKings, FanDuel, BetMGM) have wider margins, slower to move, often shade lines to balance action from casual bettors
- **Exchanges** (Novig, ProphetX) expose user-placed orders — data is orderbook-based, not book-posted lines

For fair value, **sharp books are the signal**; everything else is noise or lagging.

---

## 4. Optic Odds System Overview

**Optic Odds** is a normalized odds aggregator. It scrapes or integrates with 30+ sportsbooks and exchanges and returns unified, structured odds data via a single API.

### What It Provides

- **Event discovery**: list upcoming games per league with book coverage metadata
- **Per-event odds**: all markets (ML, spread, total, props) across all books in one response
- **Line history**: some endpoints expose historical movement
- **Orderbook depth**: for exchanges that expose it (Kalshi, Polymarket, Novig, ProphetX)
- **Real-time WebSocket stream** for live odds updates

### Event and Market Structure

Optic Odds returns data hierarchically:

```
event
├── event_id (stable, hashed identifier)
├── away_team / home_team (display names)
├── event_start (ISO timestamp)
└── market_categories[]
    └── offers[]
        ├── market ("Moneyline", "Spread", "Total")
        ├── line (null for ML, 5.5 for spread, 225.5 for total)
        └── books[]
            └── selections[]
                ├── book ("pinnacle", "draftkings", etc.)
                ├── side ("home" / "away" / "over" / "under")
                ├── odds_american
                ├── odds_decimal
                └── is_alt (alternate line flag)
```

### Normalization Benefits

- **Single API** replaces 30+ scrapers
- **Normalized schemas** — no need to parse each book's idiosyncratic format
- **Team name standardization** — mostly consistent (e.g., "Los Angeles Lakers" across all books)
- **Market type unification** — "Moneyline" means the same thing everywhere

### Caveats

- **`is_alt` semantics vary**: exchange books (Kalshi, Polymarket, ProphetX) always mark selections as `is_alt: true`. Traditional books use `is_alt: true` to mean "not the main line" (alternate spread). Filtering `is_alt` indiscriminately drops all exchange data
- **Event IDs are hashed**, not semantic — a single real-world game may have multiple Optic event_ids (one per book or cluster of books). Always prefer the event with the most book coverage when matching
- **Team names are display strings**, not stable IDs. Matching still requires normalization

---

## 5. Mapping Between Kalshi and Sportsbooks

The hardest problem in this system. Getting it wrong produces silent corruption — wrong fair values that look plausible.

### A. Matching the Event

Start by finding the same real-world game in both systems.

**Signals to use:**

1. **League** (NBA, NFL, NHL, MLB, NCAAMB, etc.) — Kalshi has league metadata in the series name; Optic uses explicit league slugs
2. **Team names** (home + away) — the most reliable but messiest signal
3. **Event time** (start time or date) — ±1 hour tolerance handles timezone/scheduling slippage
4. **Home/away designation** — usually consistent but occasionally inverted

**Team name normalization**:

- Strip punctuation and case (`St. John's` → `st johns`)
- Handle abbreviations (`LA Clippers` vs. `Los Angeles Clippers`)
- Handle city-only vs. city+mascot (`Dallas` vs. `Dallas Mavericks`)
- Handle truncation (Kalshi sometimes truncates display names like "Los Angeles C")
- Watch for college suffixes: `Michigan State` vs. `Michigan St.` vs. `Mich St`

**Matching algorithm** (in order of preference):

1. Exact normalized match on both teams
2. Substring match in either direction
3. Token-based fuzzy match (e.g., Jaro-Winkler or Levenshtein with a threshold)
4. First-word (city) match as a last resort

### B. Matching the Market Type

Kalshi's series prefix usually tells you:

- `KXNBAGAME` → moneyline
- `KXNBASPREAD` → spread
- `KXNBATOTAL` → total

Optic's `market` field: `"Moneyline"`, `"Spread"`, `"Total"`.

**MVP rule: start with moneyline only.** Spread and total introduce line normalization, which is a separate problem (covered below).

### C. Matching the Outcome (YES Side)

For moneyline, each Kalshi market has a team suffix in the ticker (e.g., `-LAL`). The YES side corresponds to "that team wins". Map the suffix to the correct sportsbook side:

- Parse the suffix → team abbreviation
- Match the abbreviation to `home_team` or `away_team` in Optic
- YES price on Kalshi `-LAL` = `away` (Optic) if Lakers are away, else `home`

**The subtitle field** on Kalshi markets is authoritative for determining YES framing. Always read it rather than assuming from ticker structure.

### D. Common Mapping Challenges

| Challenge | Example | Mitigation |
|---|---|---|
| **Truncated names** | Kalshi: `Los Angeles C`, Optic: `Los Angeles Clippers` | Substring / prefix matching |
| **Duplicate events** | Same game has 3 Optic event_ids | Pick the one with most books |
| **Timezone drift** | Game at 10 PM local vs. 2 AM UTC next day | Match on date window, not exact timestamp |
| **Rescheduled games** | Kalshi updates, Optic doesn't (or vice versa) | Time tolerance + team confirmation |
| **Ambiguous abbreviations** | `LAL` could be Lakers or any LA team | Resolve via full team name |
| **Tournament naming** | Kalshi: "Final Four", Optic: "NCAA Tournament" | League-level handling, not event-level |
| **Rain delays / neutral sites** | Game time and location shift | Rely on teams, not venue |
| **Game has started** | Lines pulled from sharp books; only exchanges remain | Detect live state; fall back to remaining books |

### E. Suggested Matching Strategy

A layered approach, each tier more lenient than the last:

1. **Exact ID match** — if both systems expose a common identifier (rare)
2. **Structured match** — normalized teams (away + home) + date window
3. **Normalized string match** — Jaccard/Levenshtein on concatenated teams
4. **Fuzzy match with safeguards** — require league match, require date within ±1 day, require minimum string similarity

At every tier, emit a **confidence score**. Low-confidence matches should either be dropped or flagged to the UI, never silently used to compute fair value.

---

## 6. Converting Sportsbook Odds to Probability

Given American odds `O`:

- **Negative** (`O ≤ -100`): `p = |O| / (|O| + 100)`
- **Positive** (`O ≥ +100`): `p = 100 / (O + 100)`
- **Even** (`±100`): `p = 0.50`

Worked examples:

| American | Formula | Implied Probability |
|---|---|---|
| `-200` | `200 / 300` | 66.7% |
| `-150` | `150 / 250` | 60.0% |
| `-110` | `110 / 210` | 52.4% |
| `+100` | `100 / 200` | 50.0% |
| `+130` | `100 / 230` | 43.5% |
| `+250` | `100 / 350` | 28.6% |

Always validate: for a two-sided market, `p_home + p_away` should be `1.00 + vig` (typically 1.02 to 1.08).

---

## 7. Removing Vig (Devigging)

### What Is Vig?

Vig (vigorish) is the sportsbook's margin. Because implied probabilities from posted odds sum to **more than 100%**, the extra is the book's edge. A fair market would sum to exactly 100%.

### Why Devig?

Raw implied probabilities from a single book **overestimate** the true probability because they include the book's cut. To compute fair value you must normalize.

### Simple Multiplicative Devig (Two-Sided)

Given raw probabilities `p_a` and `p_b`:

```
s = p_a + p_b           # overround (total implied probability)
q_a = p_a / s           # fair probability for A
q_b = p_b / s           # fair probability for B
```

`q_a + q_b` now sums to exactly 1.00.

### Worked Example

Home: `-150` → `p_home = 0.600`
Away: `+130` → `p_away = 0.4348`

`s = 1.0348` (3.48% overround)

`q_home = 0.600 / 1.0348 = 0.5798` → 57.98% (fair)
`q_away = 0.4348 / 1.0348 = 0.4202` → 42.02% (fair)

Equivalent fair American odds:
- Home: `-138`
- Away: `+138`

### Better Devig Methods

The multiplicative method is simple but assumes vig is distributed proportionally. More accurate methods:

- **Additive**: subtracts a constant from each probability
- **Power**: raises each probability to a power chosen so they sum to 1
- **Shin**: models insider trading — good when one side has sharp information
- **Probit**: maps to the normal distribution, inverts, shifts, re-maps. Accurate for close-to-50/50 markets

For production, **probit is a strong default** for moneyline. Multiplicative is acceptable as a baseline.

### Multi-Book Devig Strategy

Devig each sharp book individually, then **average the fair probabilities**. Averaging raw American odds across books is mathematically invalid (odds are not linear around the -100/+100 gap). Always average on the probability scale or use a step-scale representation.

---

## 8. Converting to Kalshi Fair Value

Once you have a fair probability `q` (as a decimal, e.g., `0.58`):

```
fair_yes_cents = q * 100
fair_no_cents  = (1 - q) * 100
```

Example:

Fair probability of home team winning = 57% → `q = 0.57`

- Fair YES price on Kalshi `-HOME` market: **57¢**
- Fair NO price on Kalshi `-HOME` market: **43¢**
- Equivalently, fair YES on Kalshi `-AWAY` market: **43¢**

This is the quantity to compare against live Kalshi prices to detect edge.

---

## 9. Edge Calculation

### The Core Question

Given:

- Fair probability `q` (from devigged sharp books)
- Current Kalshi YES price `p_kalshi` (in cents)

Is it profitable to buy?

### Edge in Cents

```
edge_cents = (q * 100) - p_kalshi
```

- **Positive edge** = Kalshi is underpricing → buying has positive expected value
- **Zero edge** = Kalshi matches fair → no edge
- **Negative edge** = Kalshi is overpricing → don't buy

### Edge as Expected Value Per Contract

Each contract settles at 100¢ (YES wins) or 0¢ (YES loses). Buying at `p_kalshi`:

```
EV_per_contract = q * (100 - p_kalshi) - (1 - q) * p_kalshi
                = 100 * q - p_kalshi
```

This is **identical to edge_cents**. A 3¢ edge on 100 contracts = $3.00 expected profit (before fees).

### Worked Examples

**Fair probability = 60%, Kalshi YES asking at 55¢:**
- Fair cents = 60, Kalshi = 55
- Edge = +5¢ per contract → buy
- 100 contracts → $5.00 EV

**Fair probability = 60%, Kalshi YES asking at 62¢:**
- Fair cents = 60, Kalshi = 62
- Edge = −2¢ per contract → don't buy
- Wait for a bid to be hit, or look at the NO side (fair NO = 40¢; if Kalshi NO is at 38¢, edge = +2¢ on NO)

### Edge Relative to Thresholds

Real trading requires accounting for:

- **Fees** (Kalshi maker fee ~0.875%, taker fee higher)
- **Slippage** (moving the market as you fill)
- **Variance** (one bet isn't the long run)

A common rule: **require at least 2-3¢ edge after fees** before placing a bid. Less than that and the signal-to-noise ratio is too poor.

### Edge Tiers (Grading System)

Common grading labels seen in practice:

- **Better than vigged line** (MBA+): beating the raw sharp-book average — the strongest signal
- **Better than devigged fair** (VF+): positive EV but smaller edge
- **Near fair**: roughly at fair value — neutral
- **Worse than fair**: negative EV — avoid

---

## 10. Latency and Real-Time Considerations

### Different Cadences

- **Sportsbook odds** (sharp books): update within seconds of new information (injuries, lineups, weather, bettor action)
- **Kalshi orderbook**: updates on every order placement/cancellation, continuously
- **Optic Odds API**: polling typically updates every 1-10 seconds; WebSocket is real-time

Sharp book movements **lead** Kalshi by seconds to minutes. If fair value updates faster than Kalshi does, edge appears and disappears quickly.

### Pre-Game vs. Live

- **Pre-game**: sharp books post lines up to hours in advance. Lines are stable except around news events. Fair value is reliable
- **Live (in-progress)**: sharp books often **pull their lines** during active play, leaving only exchanges and slower traditional books. Fair value becomes unreliable or unavailable. Kalshi continues trading. **Do not trust pre-game fair value once a game goes live**

Always check the game state before using fair value.

### Caching Strategy

- Cache Optic Odds responses server-side (1-10 second TTL)
- Do **not** let the browser extension hit Optic directly: API keys would leak, rate limits would blow up, consistency would suffer
- Route all odds queries through a backend service
- Cache fair values per-event, invalidate on price change events
- Use WebSocket subscriptions where possible for push updates

### Why Per-User Fetching Is Wrong

If 100 users all open the same game:
- 100 duplicate API calls to Optic per poll cycle
- 100× the rate limit consumption
- Inconsistent state (some users see stale data)
- Keys exposed if done client-side

The correct architecture is **one shared backend subscription per event**, broadcast to all connected clients.

---

## 11. System Design Implications

### Mapping Must Be Reliable

A wrong team match produces a wrong fair value that looks plausible. There is no downstream signal to detect it. Invest in:

- Normalization logic tested against known edge cases
- Confidence scoring on matches
- Explicit logging when matches fall back to fuzzy modes
- Manual override capability for persistent mismatches

### Backend Aggregation Is Required

The extension should never:

- Call Optic Odds directly (API key exposure, rate limits)
- Compute devig client-side (logic drift across versions)
- Match events client-side (browser can't see all games at once)

The extension should:

- Receive pre-computed fair values from backend (by Kalshi ticker)
- Display, compare, and render edge
- Send user-initiated actions (trade placement) with explicit auth

### Derived Data, Not Raw

The extension consumes:

- `fair_yes_cents`, `fair_no_cents` — derived from sharp books
- `mba_yes_cents`, `mba_no_cents` — average of sharp books with vig (before devigging)
- `edge_cents` (computed server-side against current Kalshi price)
- `confidence` (match quality indicator)
- `books_used` (transparency)
- `last_updated` (staleness check)

Raw per-book odds can be provided for debugging but should not drive UI decisions.

### Recommended Backend Endpoints

- `GET /fair/{kalshi_ticker}` → latest fair value for one market
- `GET /fair?league=nba` → bulk fair values for all live markets in a league
- `WebSocket /fair/stream` → push updates as they change

---

## 12. Limitations and Edge Cases

### Markets That Cannot Be Mapped

- **Non-sports Kalshi markets**: weather, elections, economic indicators — Optic has no equivalent
- **Obscure sports**: certain leagues/tournaments have no sharp coverage
- **Exotic markets**: player props, first-scorer, exact score — mapping is much harder than moneyline
- **Asian handicaps with quarter lines**: `−5.25` in sportsbook land doesn't directly exist on Kalshi

For these: display the Kalshi market without fair value, explicitly signal "no fair value available".

### Partial Matches

Sometimes only one team name matches confidently. Options:

- Reject the match entirely (safer)
- Accept with a low-confidence flag and degraded display

Err on the side of rejection. False positives are worse than missing data.

### Stale Odds

If the last Optic update was more than a few minutes ago, fair value is stale. Display a staleness indicator (e.g., "odds from 4m ago") or suppress the value entirely.

### Low Liquidity

If the Kalshi orderbook is thin (e.g., best ask is 2000 contracts away from last trade), the quoted price isn't actionable. Compute edge against the best bid you can actually get filled on, not the top of the book.

### Sharp Books Not Available

During live games or for niche markets, sharp books may have no odds. Fallbacks:

1. Use next-best books (BetMGM, Caesars, DraftKings averaged)
2. Use exchange prices (Novig, ProphetX) as a secondary signal
3. Report "no fair value" rather than compute from noisy sources

Always tell the user which books were used.

### Line Mismatches (Spread/Total)

Kalshi spread markets are binary (either you cover -5.5 or you don't). Sportsbooks post multiple lines. To map:

- Find the sportsbook offering at or nearest to Kalshi's line
- If no exact match, use a **step model** to convert odds from the sportsbook's line to Kalshi's line (each half-point of spread is approximately 9 "steps" on a linear scale derived from American odds, where the -100/+100 gap is collapsed)
- Expect accuracy to degrade as the line gap grows; more than 2 half-points of difference is marginal

Moneyline has none of this friction — prefer it for MVP.

### Failing Gracefully

- Never show a fair value you don't trust
- Prefer "unknown" to "wrong"
- Log every fallback and mismatch for later analysis
- Surface confidence to the user; let them decide when to act

---

## 13. Mental Model Summary

```
Sportsbooks                   Optic Odds                Kalshi
(30+ books, vigged)           (normalized aggregator)   (binary prediction exchange)
│                             │                         │
│                             │                         │
└─────── scrape / feed ──────▶│                         │
                              │                         │
                              │                         │
                              ▼                         │
            ┌──────────────────────────┐                │
            │   Your backend service    │                │
            │                          │                │
            │  1. Fetch sharp odds     │                │
            │  2. Devig (probit/etc.)  │                │
            │  3. Match Kalshi events  │◀──── fetch ────┤
            │  4. Compute fair value   │                │
            │  5. Compare to Kalshi    │                │
            │     orderbook            │                │
            │  6. Emit edge            │                │
            └──────────────────────────┘                │
                              │                         │
                              │                         │
                              ▼                         │
                      ┌──────────────┐                  │
                      │   Chrome     │                  │
                      │   Extension  │─── trade ───────▶│
                      │              │                  │
                      │   (display)  │                  │
                      └──────────────┘                  │
```

**Three core concepts:**

1. **Kalshi is a probability market**: prices are probabilities in cents
2. **Sportsbooks are vigged**: raw probabilities sum to > 100%; devig to get truth
3. **Fair value lives in sharp book consensus**: average the best books, devig, and you have a number worth trading against

**The pipeline in one line:**

> Sharp sportsbook odds → devig → match to Kalshi ticker → compare to Kalshi price → compute edge → decide to trade.

Everything in this system is either data movement, normalization, math, or the mapping problem. The mapping problem is the hardest and most important. Get it right, test it obsessively, and the rest is mechanical.
