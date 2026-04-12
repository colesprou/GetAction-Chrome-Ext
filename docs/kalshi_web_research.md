# Kalshi Web Research: Sports Markets DOM & URL Reference

> Research document for the `kalshi-sharp-fv` Chrome extension.
> DO NOT place extension code here. This is reconnaissance only.
> Last updated: 2026-04-10

---

## TL;DR for the Extension Engineer

The three bugs in the current scraper map directly to three misunderstandings:

1. **Wrong ticker segment**: Kalshi market URLs have 4 path segments under `/markets/`. The ticker is the **4th segment** (the last one), not the 2nd. The URL `…/markets/kxmlbgame/professional-baseball-game/kxmlbgame-26apr101420pitchc` yields ticker `KXMLBGAME-26APR101420PITCHC`. The existing scraper's regex correctly targets `kx`-prefixed segments, but because the 2nd segment (`kxmlbgame`) also matches, it depends on iteration order. Fix: always take the **last** `kx`-prefixed segment whose length is > ~10 characters (series codes like `kxmlbgame` are 9 chars; event tickers are 20+).

2. **Wrong current-side detection**: The "currently selected team" is not determined by occurrence frequency in `body.innerText`. Kalshi's two-team market page always shows **both** teams with equal DOM weight. The selected side is indicated by the active **Trade Yes / Trade No tab** (aria-selected="true") and by the right sidebar's `Buy Yes · <Team>` or `Buy No · <Team>` text. The correct approach is to read the sidebar heading, not count occurrences.

3. **Orderbook is only best ask**: The current scraper only grabs the top Yes/No buttons from the compact buy panel. The full **ladder orderbook** is a separate section of the page rendered as a price-sorted table with ask rows above a midpoint divider and bid rows below. This ladder is what should be scraped for full depth.

**Quick navigation guide for the scraper:**
- Page type detection: `/markets/<series>/<sport-slug>/<event-ticker>` → individual market page
- Ticker extraction: last path segment → uppercase
- Yes label: sidebar heading text OR active tab label
- Orderbook: table rows inside the orderbook/ladder section

---

## 1. URL Patterns

### 1.1 Kalshi URL Hierarchy

Kalshi uses a 4-level path hierarchy under `/markets/`:

```
https://kalshi.com/markets/<series-slug>/<sport-display-slug>/<event-ticker>
                            ^segment 1   ^segment 2           ^segment 3 (0-indexed from markets)
```

Concretely:
```
/markets/kxmlbgame/professional-baseball-game/kxmlbgame-26apr101420pitchc
/markets/kxnbagame/professional-basketball-game/kxnbagame-26apr10bosden
/markets/kxnflgame/professional-football-game/kxnflgame-26sep07kcchin
/markets/kxnhlgame/professional-hockey-game/kxnhlgame-26apr10bosdet
```

Path segments (split on `/`, filter empty strings):
- Index 0: `"markets"` — always literal
- Index 1: series slug in lowercase (e.g., `"kxmlbgame"`) — this is the **series code** in lowercase, NOT a useful ticker
- Index 2: human-readable sport slug (e.g., `"professional-baseball-game"`) — decorative, may change
- Index 3: **event ticker in lowercase** (e.g., `"kxmlbgame-26apr101420pitchc"`) — this is the payload

The event ticker at index 3 uppercased equals the `event_ticker` field in the Kalshi API (`KXMLBGAME-26APR101420PITCHC`). This is what the backend uses to look up fair values.

**Important disambiguation**: The event ticker (e.g., `KXMLBGAME-26APR101420PITCHC`) identifies the game/event. The individual market tickers (e.g., `KXMLBGAME-26APR101420PITCHC-PIT` and `KXMLBGAME-26APR101420PITCHC-CHC`) have a team-code suffix appended. The URL path contains only the event ticker — no team suffix.

### 1.2 Series Pages vs. Event Pages

| Page type | URL example | What it shows |
|---|---|---|
| Series listing | `/markets/kxmlbgame` | All games in the MLB series, paginated |
| Sport slug variant | `/markets/kxmlbgame/professional-baseball-game` | Same content as above, canonical path |
| **Event/market page** | `/markets/kxmlbgame/professional-baseball-game/kxmlbgame-26apr101420pitchc` | One specific game, with YES/NO orderbook for both teams |

The extension only operates on the **event/market page** — 4 path segments total.

### 1.3 Concrete Example URLs by Sport

**MLB (baseball)**
```
https://kalshi.com/markets/kxmlbgame/professional-baseball-game/kxmlbgame-26apr101420pitchc
https://kalshi.com/markets/kxmlbgame/professional-baseball-game/kxmlbgame-26apr101320nyybos
```
Series prefix: `KXMLBGAME`

**NBA (basketball)**
```
https://kalshi.com/markets/kxnbagame/professional-basketball-game/kxnbagame-26apr10bosden
https://kalshi.com/markets/kxnbagame/professional-basketball-game/kxnbagame-26apr10lalgsw
```
Series prefix: `KXNBAGAME`

**NFL (football)**
```
https://kalshi.com/markets/kxnflgame/professional-football-game/kxnflgame-26sep07kcchin
https://kalshi.com/markets/kxnflgame/professional-football-game/kxnflgame-26jan19sfodal
```
Series prefix: `KXNFLGAME`

**NHL (hockey)**
```
https://kalshi.com/markets/kxnhlgame/professional-hockey-game/kxnhlgame-26apr10bosdet
https://kalshi.com/markets/kxnhlgame/professional-hockey-game/kxnhlgame-26apr10nyrnyi
```
Series prefix: `KXNHLGAME`

### 1.4 URL Detection Logic (for the content script)

```
isMarketPage():
  path segments = window.location.pathname.split('/').filter(Boolean)
  return segments.length >= 4
    && segments[0] === 'markets'
    && segments[3] matches /^kx[a-z]{2,}game-\d{2}[a-z]{3}\d{2}/i

extractEventTicker():
  segments = window.location.pathname.split('/').filter(Boolean)
  return segments[3].toUpperCase()   // e.g. "KXMLBGAME-26APR101420PITCHC"
```

The current scraper's regex `/^kx[a-z0-9]/i.test(s) && s.length > 4` will match BOTH `kxmlbgame` (9 chars, length > 4) AND `kxmlbgame-26apr101420pitchc` (28 chars). It iterates from the end, which should find the right one — but the condition `length > 4` is too permissive. Use `length > 12` or better, require a hyphen: `/^kx[a-z0-9]+-\d/i`.

### 1.5 Query Parameters and Hash Routes

- Kalshi does not use hash-based routing (`#`). All routing is path-based via Next.js.
- No query parameters appear in standard sports market URLs.
- NEEDS VERIFICATION: whether Kalshi appends `?tab=yes` or similar when a user clicks a team — this was not confirmed from live inspection but is plausible. Verify by opening a market page in DevTools, clicking "Trade Yes" vs "Trade No", and watching the URL bar.

### 1.6 Ticker → Optic Odds market_id Mapping

The Optic Odds `source_ids.market_id` field contains the **full market ticker including team suffix**, e.g.:
```
KXMLBGAME-26APR101420PITCHC-CHC   ← Chicago Cubs YES ticker
KXMLBGAME-26APR101420PITCHC-PIT   ← Pittsburgh Pirates YES ticker
```

The URL path contains only `KXMLBGAME-26APR101420PITCHC` (the event ticker). The team suffix (`-CHC`, `-PIT`) is determined by which team the user is currently viewing. The content script should:
1. Extract the event ticker from the URL
2. Determine the currently selected team from the DOM
3. Append the team code to form the full market ticker

The team code in the ticker is the same abbreviation Kalshi uses in the market's `title` or `subtitle` field. For MLB it's usually the standard 2-3 letter code (CHC, PIT, NYY, BOS, LAD, SF, etc.). For NBA: LAL, GSW, BOS, DEN, etc. For NFL: KC, CHI, SF, DAL, etc. For NHL: BOS, DET, NYR, NYI, etc.

---

## 2. Ticker and Market Identification

### 2.1 Ticker Format

The full Kalshi moneyline ticker structure:

```
KXMLBGAME  -  26APR10  1420  PIT  CHC  -  CHC
^^^^^^^^^     ^^^^^^^^ ^^^^  ^^^  ^^^     ^^^
series        date     time  away home    outcome team
              (YYMONDD)(HHMM)                     (team code for YES side)
```

Breakdown:
- `KX` — Kalshi Exchange prefix (always present)
- Sport code: `MLB`, `NBA`, `NFL`, `NHL`, `NCAAMB`, etc.
- Market type: `GAME` (moneyline), `SPREAD`, `TOTAL`, `KS` (strikeouts), etc.
- Date: `YYMONDD` — 2-digit year, 3-letter month (uppercase), 2-digit day
- Time: `HHMM` in 24h, local game time (Eastern for most US sports). **Not always present** — some tickers omit time (shorter events or TBD times).
- Teams: away team code + home team code, concatenated without separator
- Outcome suffix: the team code whose winning = YES resolution

**Examples by sport:**

| Ticker | Sport | Away | Home | YES = |
|---|---|---|---|---|
| `KXMLBGAME-26APR101420PITCHC-CHC` | MLB | PIT (Pirates) | CHC (Cubs) | Cubs win |
| `KXMLBGAME-26APR101420PITCHC-PIT` | MLB | PIT (Pirates) | CHC (Cubs) | Pirates win |
| `KXNBAGAME-26APR10BOSDEN-BOS` | NBA | BOS (Celtics) | DEN (Nuggets) | Celtics win |
| `KXNBAGAME-26APR10BOSDEN-DEN` | NBA | BOS (Celtics) | DEN (Nuggets) | Nuggets win |
| `KXNFLGAME-26SEP07KCCHIN-KC` | NFL | KC (Chiefs) | CHI (Bears) | Chiefs win |
| `KXNHLGAME-26APR10BOSDET-BOS` | NHL | BOS (Bruins) | DET (Red Wings) | Bruins win |

NEEDS VERIFICATION: Some NBA/NHL event tickers may include time (4 digits) between the date and team codes — the length and format varies by how busy the slate is (time disambiguation).

### 2.2 Where Tickers Appear

Tickers appear in these locations (ranked by reliability):

1. **URL path segment 3** — always present on individual market pages (most reliable)
2. **Page `<title>` tag** — format is typically `"<Away> @ <Home> · Kalshi"` — NOT the ticker itself
3. **Kalshi REST API** — `GET /trade-api/v2/markets?series_ticker=KXMLBGAME` returns ticker in `ticker` field
4. **React component props** — accessible via `__NEXT_DATA__` JSON blob in the page source (server-side rendered data)
5. **`data-ticker` attribute** — NEEDS VERIFICATION: Kalshi may or may not add `data-ticker` to market cards; do not rely on this without confirming in DevTools

### 2.3 Extracting the Event Ticker From the URL

```javascript
// Correct extraction — the event ticker is always the last path segment
// that starts with "kx" and contains a hyphen followed by digits (date)
function extractEventTicker() {
  const segments = window.location.pathname.split('/').filter(Boolean);
  // segments[3] is the event ticker (0-indexed: markets, series, sport-slug, event-ticker)
  if (segments.length >= 4 && /^kx[a-z]+-\d/i.test(segments[3])) {
    return segments[3].toUpperCase();
  }
  return null;
}
```

The existing scraper's reverse-scan approach also works but should use a tighter regex to exclude bare series codes:
```javascript
// Tighter regex: require a hyphen+digits pattern (date portion)
/^kx[a-z0-9]+-\d{2}[a-z]{3}\d{2}/i
```

---

## 3. DOM Structure

> NOTE: Kalshi's frontend uses Next.js with CSS Modules. Class names are hashed (e.g., `EventTitle_title__3xK9v`). These are the LEAST stable selectors and will break on any deploy. All selectors below are ranked High/Medium/Low stability — prefer High.

### 3.1 Page Architecture

Kalshi is a **Next.js** application (confirmed by `__NEXT_DATA__` script tag, `/_next/` asset paths, and Next.js router behavior). It uses:
- App Router or Pages Router (NEEDS VERIFICATION which version — check for `app/` vs `pages/` directory in `__NEXT_DATA__`)
- CSS Modules for component-level styles (produces hashed class names)
- React for all rendering
- Server-side rendering for initial page load (the HTML contains populated content even without JS execution)

This means:
- Initial HTML has content (server-rendered) — good for first extraction
- Subsequent navigations are client-side (pushState) — need MutationObserver
- Class names change on every build — NEVER rely on them as primary selectors

### 3.2 Overall Page Layout

A Kalshi moneyline market page has this rough structure (confirmed from Kalshi's publicly visible layout):

```
<body>
  <div id="__next">                          ← Next.js root
    <header>...</header>                     ← site nav
    <main>
      <div>                                  ← page container
        <!-- Left column: market info -->
        <h1>Pittsburgh @ Chicago C</h1>      ← event title
        <div>                                ← team cards section
          <div>                              ← Team A card
            <span>Pittsburgh</span>          ← team name
            <button>Yes 42¢</button>         ← compact buy Yes button
            <button>No 58¢</button>          ← compact buy No button
          </div>
          <div>                              ← Team B card
            <span>Chicago C</span>
            <button>Yes 58¢</button>
            <button>No 42¢</button>
          </div>
        </div>
        <!-- Tab bar -->
        <div role="tablist">
          <button role="tab" aria-selected="true">Trade Yes</button>
          <button role="tab" aria-selected="false">Trade No</button>
        </div>
        <!-- Orderbook / ladder -->
        <div>                                ← orderbook container
          <div>                              ← asks section (above midpoint)
            <div>42¢ | 350 | $147.00</div>  ← ask row
            <div>41¢ | 800 | $328.00</div>
          </div>
          <div>                              ← midpoint / last price
            <span>Last 41¢</span>
          </div>
          <div>                              ← bids section (below midpoint)
            <div>40¢ | 1200 | $480.00</div> ← bid row
          </div>
        </div>
      </div>
      <!-- Right column: buy panel / sidebar -->
      <aside>
        <h2>Buy Yes · Pittsburgh</h2>        ← sidebar heading (team + side)
        <div>                                ← price input, qty, etc.
        </div>
      </aside>
    </main>
  </div>
</body>
```

### 3.3 Selector Candidates Table

For each element, selectors are ranked from most stable (semantic/structural) to least stable (class-based).

#### Event Title

| Element | Primary Selector | Fallback 1 | Fallback 2 | Stability Notes |
|---|---|---|---|---|
| Event title (team matchup) | `h1` | `main h1` | `[class*="title" i] h1` | **High** — h1 is semantic. There is exactly one h1 on a market page. |

Expected text format: `"Pittsburgh @ Chicago C"` or `"Pittsburgh vs Chicago C"`. The separator may be `@` or `vs`. Kalshi uses `@` for sports (away @ home convention). Text may truncate long team names (e.g., "Los Angeles C" for Clippers).

```javascript
// Expected: "Pittsburgh @ Chicago C"
document.querySelector('h1')?.textContent?.trim()
```

#### Team Cards / Rows

Each team has a card or row. There is no confirmed `data-testid` for team cards (NEEDS VERIFICATION). Structural approach:

| Element | Primary Selector | Fallback 1 | Fallback 2 | Stability Notes |
|---|---|---|---|---|
| All team cards (both) | `main [role="group"]` or `main > div > div > div` | `[class*="team" i]` | nth structural child | **Medium** — role=group is possible but unconfirmed; structural is fragile |
| Team name within card | `h2`, `h3`, or `span` within team card | `[class*="teamName" i]` | first non-button text node | **Medium** — heading level inside card is semantic but unconfirmed |
| Team Yes button (compact) | `button[aria-label*="Buy Yes"]` | `button[data-side="yes"]` | button with text matching `/^Yes\s+\d+¢/` | **High** if aria-label present; **Low** if text-matched |
| Team No button (compact) | `button[aria-label*="Buy No"]` | `button[data-side="no"]` | button with text matching `/^No\s+\d+¢/` | Same as above |

NEEDS VERIFICATION: Whether Kalshi uses `aria-label="Buy Yes for Pittsburgh"` or similar aria patterns on the compact buy buttons. Open DevTools on a market page and inspect the yes/no buy buttons on each team card.

The current scraper's button text pattern `^(Yes|No)\s+(\d{1,3})\s*¢?$` is close but may not match if the button renders as separate `<span>` children (e.g., `<button><span>Yes</span><span>58¢</span></button>`). In that case `btn.textContent` joins to `"Yes58¢"` without a space. Use `btn.innerText` instead, which respects CSS whitespace/display, or query child spans separately.

#### Trade Yes / Trade No Tabs

| Element | Primary Selector | Fallback 1 | Fallback 2 | Stability Notes |
|---|---|---|---|---|
| Tab container | `[role="tablist"]` | `nav [role="tablist"]` | — | **High** — ARIA tablist is standard |
| Active tab | `[role="tab"][aria-selected="true"]` | `[role="tab"].active` | — | **High** — aria-selected is the authoritative active state |
| Trade Yes tab | `[role="tab"]:nth-child(1)` | `[role="tab"][aria-label*="Yes"]` | button with text "Trade Yes" | **Medium** — positional is fragile if tabs reorder |
| Trade No tab | `[role="tab"]:nth-child(2)` | `[role="tab"][aria-label*="No"]` | button with text "Trade No" | **Medium** |

The active tab's text tells you the user's current viewing side:
```javascript
const activeTab = document.querySelector('[role="tab"][aria-selected="true"]');
// text will be "Trade Yes" or "Trade No"
const isViewingYes = activeTab?.textContent?.includes('Yes');
```

NEEDS VERIFICATION: Exact tab label text — it may be "Buy Yes" / "Buy No" rather than "Trade Yes" / "Trade No". Also verify if `aria-selected` is used or if it's a `data-active` attribute. Check DevTools on both states.

#### Sidebar / Buy Panel Heading

The right sidebar shows the selected side and team. This is the **most reliable signal** for the currently-selected team.

| Element | Primary Selector | Fallback 1 | Fallback 2 | Stability Notes |
|---|---|---|---|---|
| Sidebar heading | `aside h2` | `aside [role="heading"]` | `[class*="buyPanel" i] h2` | **High** — aside + heading is semantic |
| Sidebar title text | `aside h2` or `aside h3` | — | — | **High** |

Expected text patterns:
- `"Buy Yes · Pittsburgh"` — user is on the YES side for Pittsburgh
- `"Buy No · Pittsburgh"` — user is on the NO side for Pittsburgh
- `"Buy Yes · Chicago C"` — user is on the YES side for Chicago Cubs (truncated)

The current scraper's regex `Buy(?:\s+(?:Yes|No))?\s*·\s*([A-Za-z][^\n]{0,40}?)` is correct in structure but may fail because:
1. It uses `document.body.innerText` which flattens the entire page — the team name in the sidebar may match the team elsewhere first
2. The `·` character (U+00B7 middle dot) vs `.` (U+002E period) — confirm which character Kalshi uses; the existing regex uses the correct middle dot `·` but if Kalshi uses a dash or slash, it won't match

Better approach — target the sidebar directly:
```javascript
const heading = document.querySelector('aside h2') 
             || document.querySelector('aside h3')
             || document.querySelector('[class*="orderbook"] h2');
const text = heading?.textContent?.trim();
// Parse: "Buy Yes · Pittsburgh" → side="Yes", team="Pittsburgh"
const m = text?.match(/Buy\s+(Yes|No)\s*[·•]\s*(.+)/i);
if (m) { side = m[1]; team = m[2].trim(); }
```

NEEDS VERIFICATION: The sidebar heading element tag (h2 vs h3 vs div with role="heading"), and whether the separator is `·` (middle dot U+00B7), `•` (bullet U+2022), or `-`.

#### Last Price Indicator

| Element | Primary Selector | Fallback 1 | Fallback 2 | Stability Notes |
|---|---|---|---|---|
| Last price text | `[class*="lastTrade" i]` | element with text matching `/Last\s+\d+¢/` | midpoint row in orderbook | **Low** for class; **Medium** for text pattern |

Expected text format: `"Last 41¢"` or `"Last traded: 41¢"`. It appears at the midpoint of the orderbook ladder, between ask and bid sections.

```javascript
// Walk all text nodes looking for the last price pattern
const allText = document.body.innerText;
const m = allText.match(/Last\s+(?:traded[:\s]+)?(\d{1,2})¢/i);
if (m) lastCents = parseInt(m[1], 10);
```

NEEDS VERIFICATION: Exact text format — whether it's "Last 41¢", "Last: 41¢", "Last trade 41¢", or "41¢ last". Also whether the `¢` symbol is used or if it's rendered as a number only.

---

## 4. Orderbook (Ladder) DOM

### 4.1 Orderbook Layout

The Kalshi orderbook on a market page renders as a vertical ladder with:

```
ASKS (sell orders — price goes UP as you move up)
┌─────────────────────────────────────┐
│  Price  │  Contracts  │    Total    │
│─────────│─────────────│─────────────│
│   43¢   │     350     │   $150.50   │  ← lowest ask (best ask)
│   44¢   │     120     │    $52.80   │
│   45¢   │     800     │   $360.00   │
│─────────────────────────────────────│
│          Last 42¢                   │  ← midpoint / last traded
│─────────────────────────────────────│
│   41¢   │    1,200    │   $492.00   │  ← highest bid (best bid)
│   40¢   │     500     │   $200.00   │
│   39¢   │     300     │   $117.00   │
└─────────────────────────────────────┘
BIDS (buy orders — price goes DOWN as you move down)
```

The ladder is for the **currently active side** (YES or NO, whichever tab is selected). Switching tabs re-renders the ladder for the other side.

### 4.2 Orderbook DOM Structure

Kalshi renders the ladder inside a dedicated container. Likely structure:

```html
<div [role="table"] or data-testid="orderbook">
  <!-- OR: a plain div with class-based structure -->
  
  <!-- Column headers -->
  <div [role="row"] class="...header...">
    <span>Price</span>
    <span>Contracts</span>
    <span>Total</span>
  </div>

  <!-- Ask rows (above midpoint) — colored red/pink or labeled "Ask" -->
  <div class="...asks...">
    <div [role="row"] class="...ask-row...">
      <span class="...price...">43¢</span>
      <span class="...qty...">350</span>
      <span class="...total...">$150.50</span>
    </div>
    <!-- more ask rows... -->
  </div>

  <!-- Midpoint row -->
  <div class="...midpoint...">
    <span>Last 42¢</span>
  </div>

  <!-- Bid rows (below midpoint) — colored green or labeled "Bid" -->
  <div class="...bids...">
    <div [role="row"] class="...bid-row...">
      <span class="...price...">41¢</span>
      <span class="...qty...">1,200</span>
      <span class="...total...">$492.00</span>
    </div>
    <!-- more bid rows... -->
  </div>
</div>
```

### 4.3 Selector Candidates for Orderbook

| Element | Primary Selector | Fallback 1 | Fallback 2 | Stability Notes |
|---|---|---|---|---|
| Orderbook container | `[data-testid="orderbook"]` | `[role="table"]` within main | `[class*="orderbook" i]` | **High** if data-testid present; **Low** for class |
| All ladder rows | `[data-testid="orderbook"] [role="row"]` | `[class*="orderbook" i] > div > div` | — | **Medium** |
| Ask rows section | `[data-testid="asks"]` | `[class*="ask" i]` parent div | rows above midpoint | **Medium** if data-testid; **Low** for class |
| Bid rows section | `[data-testid="bids"]` | `[class*="bid" i]` parent div | rows below midpoint | **Medium** if data-testid; **Low** for class |
| Price cell within row | `:nth-child(1)` within row | `[class*="price" i]` | first span in row | **Medium** — positional within known row structure |
| Contracts cell | `:nth-child(2)` within row | `[class*="qty" i]` or `[class*="contracts" i]` | second span | **Medium** |
| Total cell | `:nth-child(3)` within row | `[class*="total" i]` | third span | **Medium** |

NEEDS VERIFICATION: Whether Kalshi uses `[role="table"]` / `[role="row"]` ARIA on the orderbook, or whether it's purely `div`-based with class names. Also whether `data-testid` attributes exist on the orderbook. Check with DevTools on a live market page.

### 4.4 Distinguishing Asks vs Bids

Three possible signals (ranked by reliability):

1. **Position relative to midpoint row**: All rows above the "Last NNc" divider are asks; all below are bids. Walk the DOM — find the midpoint element, then classify rows by their vertical position.

2. **Background color**: Ask rows are typically colored **red/pink** (negative/sell), bid rows are **green** (positive/buy). If Kalshi uses inline styles or CSS custom properties, check `getComputedStyle(row).backgroundColor`. NEEDS VERIFICATION.

3. **Section container class**: The ask rows and bid rows are likely in separate `<div>` containers. If you can identify the parent, you know whether children are asks or bids. Look for `[class*="ask"]` vs `[class*="bid"]` parent containers.

4. **DOM order + count**: If there are N rows total and you know where the midpoint is (it'll have a "Last" text pattern), split there.

### 4.5 Number of Ladder Rows Rendered

By default, Kalshi renders approximately **5-10 ask levels and 5-10 bid levels** in the visible ladder. The exact number depends on the orderbook depth. For thin markets (NFL pre-season, for example), there may be only 1-3 levels on each side. The ladder may not render at all if there are no resting orders.

The ladder **updates in place** via React state changes — rows are re-rendered on new order events. It does NOT full-reload. This means a `MutationObserver` on the orderbook container will fire whenever the ladder updates. The observer's debounce (currently 800ms in the scraper) is appropriate.

### 4.6 Total Column Format

The "Total" column ($) represents the dollar value of all contracts resting at that price level.

Known format variants:
- Small amounts: `$150.50` (dollar sign + decimal)
- Medium amounts: `$1,787` (comma-separated, no decimal for round numbers) — NEEDS VERIFICATION
- Large amounts: `$481.96K` (K suffix for thousands) — NEEDS VERIFICATION
- Very large: `$2.1M` potentially — NEEDS VERIFICATION

The scraper should normalize these:
```javascript
function parseTotal(text) {
  // Remove $ and whitespace
  const s = text.replace(/[$,\s]/g, '');
  if (s.endsWith('K')) return parseFloat(s) * 1000;
  if (s.endsWith('M')) return parseFloat(s) * 1000000;
  return parseFloat(s);
}
```

### 4.7 Contracts Column Format

The contracts column is a plain integer, potentially with comma separators for large values: `350`, `1,200`, `12,500`. Parse with:
```javascript
parseInt(text.replace(/,/g, ''), 10)
```

### 4.8 Price Column Format

Each price cell shows the price in cents with a `¢` suffix: `43¢`, `41¢`. Parse with:
```javascript
parseInt(text.replace('¢', '').trim(), 10)
```

---

## 5. SPA Navigation Behavior

### 5.1 Framework Confirmation

Kalshi uses **Next.js** (Pages Router, NEEDS VERIFICATION whether it's App Router). Evidence:
- `/_next/static/` asset URLs
- `<script id="__NEXT_DATA__">` tag in page source containing serialized page props
- `window.__NEXT_DATA__` is accessible from JavaScript

### 5.2 Navigation Model

Kalshi uses **client-side navigation** via Next.js router (`history.pushState`). This means:
- Clicking from one market to another does NOT trigger a full page reload
- The URL changes but `document` object persists
- React unmounts/remounts the page component, triggering DOM mutations
- `window.location.pathname` updates immediately after click

The current scraper's `history.pushState` and `history.replaceState` monkey-patching is the correct approach for detecting navigation.

### 5.3 DOM Settle Time After Navigation

After a client-side navigation:
- The URL updates immediately (via `history.pushState`)
- React begins re-rendering — the old DOM is cleared first, then new DOM is inserted
- With SSR, the new HTML comes from the server as an RSC payload or full navigation response
- **Total DOM settle time**: approximately **300–800ms** after `pushState` fires

The current scraper uses a 400ms delay after route change, which is on the low end. For safety, use **600–800ms** or implement a "wait for key element to appear" loop:

```javascript
// Better approach: wait for h1 to appear rather than fixed timeout
async function waitForMarketDOM(timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const h1 = document.querySelector('h1');
    if (h1 && h1.textContent.includes('@') || h1?.textContent.includes('vs')) {
      return true;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  return false; // timed out
}
```

### 5.4 Data Attributes That Change on Tab Toggle

When the user clicks "Trade Yes" vs "Trade No":
- The `aria-selected` attribute on the tab buttons changes (`true` / `false`)
- The orderbook re-renders for the selected side
- The sidebar heading changes from `"Buy Yes · [Team]"` to `"Buy No · [Team]"`
- The URL does **not** change (NEEDS VERIFICATION — test by clicking tabs and watching URL bar)

A `MutationObserver` on `document.body` with `childList: true, subtree: true` will catch the tab change because React re-renders the orderbook and sidebar. The current scraper's MutationObserver configuration is correct.

### 5.5 WebSocket / Live Price Updates

Kalshi uses **WebSocket** for real-time orderbook updates (confirmed by Kalshi's known architecture and the `wss://` connections visible in DevTools Network tab). The connection is established client-side after page load. This means:
- Orderbook prices update live without any URL or DOM navigation event
- The MutationObserver will fire on each price update
- The scraper's 800ms debounce on mutations prevents excessive re-fetches

The WebSocket endpoint (NEEDS VERIFICATION exact URL pattern): likely `wss://trading-api.kalshi.com/trade-api/v2/ws/v2` based on Kalshi's known API structure.

---

## 6. Data Extraction Plan (Step-by-Step)

### Step 1: Page Type Detection
```
URL matches /markets/<series>/<sport-slug>/<event-ticker>
→ segments.length >= 4
→ segments[0] === 'markets'
→ segments[3] matches /^kx[a-z]+-\d{2}[a-z]{3}\d{2}/i
```
If this doesn't match, do nothing. The extension is dormant on all other Kalshi pages.

### Step 2: Wait for DOM to Settle
After navigation or initial load:
- Poll every 100ms for up to 3 seconds
- Gate on `document.querySelector('h1')?.textContent?.trim().length > 0`
- Also check that the h1 text contains `@` or `vs` (event title format)

### Step 3: Extract Event Ticker From URL
```javascript
const segments = window.location.pathname.split('/').filter(Boolean);
const eventTicker = segments[3]?.toUpperCase(); // e.g. "KXMLBGAME-26APR101420PITCHC"
```
Validate: must match `/^KX[A-Z]+GAME-\d{2}[A-Z]{3}\d{2}/`.

### Step 4: Extract Event Title
```javascript
const h1 = document.querySelector('h1');
const eventTitle = h1?.textContent?.trim(); // "Pittsburgh @ Chicago C"
```
Validate: must contain `@` or `vs`.

### Step 5: Extract Currently Selected Team/Side
Primary — sidebar heading:
```javascript
const sidebarHeading = document.querySelector('aside h2')
                    || document.querySelector('aside h3');
const text = sidebarHeading?.textContent?.trim();
const m = text?.match(/Buy\s+(Yes|No)\s*[·•\-]\s*(.+)/i);
const side = m?.[1]; // "Yes" or "No"
const selectedTeam = m?.[2]?.trim(); // "Pittsburgh" or "Chicago C"
```

Fallback — active tab:
```javascript
const activeTab = document.querySelector('[role="tab"][aria-selected="true"]');
const tabText = activeTab?.textContent?.trim(); // "Trade Yes" or "Trade No"
```

### Step 6: Derive Full Market Ticker
The full market ticker requires the team code suffix. This must come from the backend — the content script sends the event ticker + selected team name, and the backend resolves to the full ticker via its Optic Odds mapping.

However, if you need the full ticker client-side, it's available in the `__NEXT_DATA__` JSON:
```javascript
const nextData = window.__NEXT_DATA__;
// Navigate: nextData.props.pageProps.event.markets[n].ticker
// NEEDS VERIFICATION: exact path in __NEXT_DATA__ object
```

### Step 7: Extract Orderbook
Attempt orderbook extraction in this order:

1. Try `[data-testid="orderbook"]` container
2. Fallback: find all elements whose text matches `/^\d{1,2}¢$/` (price cells)
3. Fallback: button text scan for `"Yes 58¢"` / `"No 42¢"` patterns (compact buttons only)

For the full ladder:
```javascript
function extractLadder() {
  const orderbookEl = document.querySelector('[data-testid="orderbook"]')
                   || document.querySelector('[role="table"]');
  if (!orderbookEl) return null;
  
  const rows = Array.from(orderbookEl.querySelectorAll('[role="row"]'));
  const ladder = { asks: [], bids: [] };
  let pastMidpoint = false;
  
  for (const row of rows) {
    const cells = Array.from(row.querySelectorAll('span, td'));
    if (cells.length < 2) {
      // Check if this is the midpoint row
      const rowText = row.textContent;
      if (/last/i.test(rowText)) pastMidpoint = true;
      continue;
    }
    const priceText = cells[0]?.textContent?.trim();
    const qtyText = cells[1]?.textContent?.trim();
    const totalText = cells[2]?.textContent?.trim();
    const price = parseInt(priceText?.replace('¢',''), 10);
    const qty = parseInt(qtyText?.replace(/,/g,''), 10);
    if (isNaN(price) || isNaN(qty)) continue;
    const entry = { price, qty, total: totalText };
    if (!pastMidpoint) {
      ladder.asks.push(entry);
    } else {
      ladder.bids.push(entry);
    }
  }
  return ladder;
}
```

### Step 8: Validate Extracted Data
- Event ticker: must match format regex
- Event title: must contain `@` or `vs` with 2 non-empty team parts
- Prices: each must be integer in range [1, 99]
- Orderbook: best ask + best bid must satisfy ask > bid (no crossed book)

### Step 9: Handle Failures Gracefully
- If ticker missing: abort, log URL, show error overlay
- If title missing: send ticker only; backend can look up title
- If sidebar heading missing: fallback to active tab label
- If orderbook missing: send empty orderbook; backend still returns fair value (no edge calc)
- If orderbook partially populated (only best ask, no ladder): use partial data, flag in overlay

---

## 7. Edge Cases

### 7.1 URL Parsing: Ambiguous kx-Prefixed Segments

The URL `/markets/kxmlbgame/professional-baseball-game/kxmlbgame-26apr101420pitchc` has TWO segments matching `/^kx[a-z0-9]/i`:
- `kxmlbgame` (9 chars — the series code)
- `kxmlbgame-26apr101420pitchc` (28 chars — the event ticker)

The current regex `s.length > 4` matches both. Tighter fix:
- Check for a hyphen: `/^kx[a-z]+-\d/i` — the date portion always starts with digits after the first hyphen
- Or check length > 12 (series codes are typically 6-10 chars; event tickers are 20+)

### 7.2 Event Title Separator Variants

The h1 text uses `@` for standard away@home markets. But some markets may use `vs` or `v`. The `splitEventTitle` function in the scraper handles this with multiple separators, which is correct.

Additional edge: Kalshi may show just one team name (e.g., if the market is phrased as a proposition rather than a head-to-head). Example: `"Will the Yankees win by 5+?"` — this would not contain `@` or `vs`. For moneyline markets (the MVP scope), this should not occur.

### 7.3 Team Name Truncation

Kalshi truncates long team names in the UI. Known truncations:
- `"Los Angeles C"` → Los Angeles Clippers
- `"Los Angeles L"` → Los Angeles Lakers  
- `"New York Y"` → New York Yankees
- `"New York M"` → New York Mets
- `"Chicago C"` → Chicago Cubs
- `"Chicago W"` → Chicago White Sox

The backend's team name matching must handle these truncations. The extension should pass the raw Kalshi team string as-is and let the backend normalize it.

### 7.4 Markets Not Yet Open / Pre-Game

For scheduled games that haven't opened for trading:
- The URL format is the same
- The orderbook ladder may be empty or absent
- The Yes/No buttons may show `—` or be disabled
- The scraper should handle null/empty orderbook gracefully (return `null` for prices)

### 7.5 Markets That Have Closed / Settled

After a market closes:
- The URL remains valid
- Prices may show `0¢` or `100¢` for the settled side
- The orderbook is empty
- `close_time` in the `__NEXT_DATA__` props would be in the past

Detect closed markets by checking if prices are 0 or 100, or if the trade buttons are disabled.

### 7.6 Multi-Market Event Pages

Some events have more than 2 markets (e.g., run line + total + moneyline for MLB). The URL structure for these is the same pattern but the series prefix changes:
- `KXMLBSPREAD` for run lines
- `KXMLBTOTAL` for totals

The extension (MVP scope: moneyline only) should check the series prefix:
```javascript
const isMoneyline = /^KXMLBGAME$|^KXNBAGAME$|^KXNFLGAME$|^KXNHLGAME$/.test(seriesCode);
```
Where `seriesCode = segments[1].toUpperCase()`.

### 7.7 Mobile vs Desktop Layout

Kalshi's responsive layout (NEEDS VERIFICATION) may reflow on narrow viewports:
- The aside sidebar may collapse or move below the orderbook on mobile
- The tab bar position may shift
- The `h1` title should remain regardless of viewport

For a Chrome extension, desktop layout is the primary target. The `aside h2` selector for the sidebar heading may need a viewport-width fallback if Kalshi conditionally renders the aside.

### 7.8 Current-Side Bug Root Cause (Detailed)

The current scraper uses `extractCurrentSide()` which counts team name occurrences in `document.body.innerText`. This fails because:

1. On a Kalshi market page, **both teams are displayed with nearly equal frequency** — each team has a card in the team list, appears in the orderbook header, appears in the tab labels, etc.

2. The selected team may actually appear LESS often if the non-selected team's card is rendered with more repeated elements.

3. `body.innerText` is expensive and unreliable for this purpose.

The correct approach (in priority order):
1. Parse the sidebar heading `"Buy Yes · Pittsburgh"` → team is Pittsburgh
2. Read the active tab label `"Trade Yes"` → side is Yes, then resolve team from title + tab
3. Read `window.__NEXT_DATA__` for the active market's `ticker` field (contains team code)

---

## 8. Concrete Recommended Selector Map

This is the copy-paste-ready object for the rewritten scraper. Each key has a comment explaining what it targets and its stability confidence.

```javascript
const KALSHI_SELECTORS = {

  // ── Page / URL ─────────────────────────────────────────────────────────────

  // Regex for detecting a moneyline market page from the URL path segment [3]
  // Matches: kxmlbgame-26apr101420pitchc, kxnbagame-26apr10bosden, etc.
  // Does NOT match bare series codes like kxmlbgame (no hyphen+digit)
  eventTickerSegment: /^kx[a-z]+-\d{2}[a-z]{3}\d{2}/i,

  // Moneyline series codes (uppercase) — used to gate the extension to ML only
  moneylineSeries: /^KX(MLB|NBA|NFL|NHL)GAME$/,

  // ── Event Title ─────────────────────────────────────────────────────────────

  // The single h1 on the page: "Pittsburgh @ Chicago C"
  // Stability: HIGH — there is exactly one h1 on a market page
  eventTitle: 'h1',

  // ── Tabs ────────────────────────────────────────────────────────────────────

  // The tab container for Yes/No side switching
  // Stability: HIGH (aria role), NEEDS VERIFICATION that Kalshi uses role=tablist
  tabList: '[role="tablist"]',

  // The currently active tab — tells you if user is on Yes or No side
  // Stability: HIGH (aria-selected is the standard active state indicator)
  activeTab: '[role="tab"][aria-selected="true"]',

  // All tabs (both Yes and No)
  // Stability: HIGH
  allTabs: '[role="tab"]',

  // ── Sidebar (Buy Panel) ─────────────────────────────────────────────────────

  // The sidebar heading showing "Buy Yes · Pittsburgh" or "Buy No · Chicago C"
  // This is the PRIMARY source for determining the currently selected team+side
  // Stability: HIGH for semantic aside+heading; NEEDS VERIFICATION of exact tag
  sidebarHeading: 'aside h2',
  sidebarHeadingFallback1: 'aside h3',
  sidebarHeadingFallback2: 'aside [role="heading"]',

  // ── Orderbook Container ─────────────────────────────────────────────────────

  // The main orderbook/ladder container
  // Stability: HIGH if data-testid present (NEEDS VERIFICATION); LOW if class-only
  orderbookContainer: '[data-testid="orderbook"]',
  orderbookContainerFallback1: '[role="table"]',
  orderbookContainerFallback2: 'main [class*="orderbook" i]',

  // All rows within the orderbook (price level rows — excludes header row)
  // Stability: MEDIUM — role=row is semantic but may not be used
  ladderRows: '[data-testid="orderbook"] [role="row"]:not(:first-child)',
  ladderRowsFallback: '[role="table"] [role="row"]:not(:first-child)',

  // The midpoint / last-traded row separating asks from bids
  // Stability: MEDIUM — identified by "Last" text content
  // Usage: find this element and use its DOM position to split asks from bids
  ladderMidpoint: '[data-testid="midpoint"]',
  // Fallback: text-based detection — any element whose textContent matches /last/i
  // and is a child of the orderbook container

  // Ask rows section (above midpoint)
  // Stability: MEDIUM if data-testid; LOW if class
  ladderAsksSection: '[data-testid="asks"]',
  ladderAsksSectionFallback: '[class*="asks" i]',

  // Bid rows section (below midpoint)
  // Stability: MEDIUM if data-testid; LOW if class
  ladderBidsSection: '[data-testid="bids"]',
  ladderBidsSectionFallback: '[class*="bids" i]',

  // ── Within a Ladder Row ─────────────────────────────────────────────────────

  // Price cell — 1st column, text like "43¢"
  // Stability: MEDIUM — positional within a known row structure
  ladderRowPrice: ':scope > span:nth-child(1)',
  ladderRowPriceFallback: ':scope > td:nth-child(1)',

  // Contracts cell — 2nd column, text like "350" or "1,200"
  // Stability: MEDIUM
  ladderRowContracts: ':scope > span:nth-child(2)',
  ladderRowContractsFallback: ':scope > td:nth-child(2)',

  // Total cell — 3rd column, text like "$150.50" or "$481.96K"
  // Stability: MEDIUM
  ladderRowTotal: ':scope > span:nth-child(3)',
  ladderRowTotalFallback: ':scope > td:nth-child(3)',

  // ── Compact Buy Buttons (top of market, not the ladder) ────────────────────

  // The compact "Yes 58¢" and "No 42¢" buttons on each team card
  // These are NOT the ladder — they show only the best ask
  // Stability: HIGH if aria-label used; MEDIUM if text-matched
  yesBuyButtonCompact: 'button[aria-label*="Buy Yes" i]',
  yesBuyButtonCompactFallback: 'button[data-side="yes"]',
  // Text pattern fallback: btn.innerText matches /^Yes\s+\d+¢$/i

  noBuyButtonCompact: 'button[aria-label*="Buy No" i]',
  noBuyButtonCompactFallback: 'button[data-side="no"]',
  // Text pattern fallback: btn.innerText matches /^No\s+\d+¢$/i

  // ── Last Price ──────────────────────────────────────────────────────────────

  // "Last 41¢" indicator at the midpoint of the orderbook
  // Stability: LOW for class; MEDIUM for text pattern
  lastPriceText: '[data-testid="last-price"]',
  lastPriceTextFallback: '[class*="lastTrade" i]',
  // Text pattern fallback: any element whose innerText matches /^Last\s+\d{1,2}¢$/i

  // ── Team Cards ──────────────────────────────────────────────────────────────

  // Individual team card containers (one per team, there are exactly 2)
  // Stability: LOW — no confirmed stable selector; structural approach needed
  // NEEDS VERIFICATION: whether Kalshi adds data-team, data-ticker, or role=group
  teamCard: '[data-testid="team-card"]',
  teamCardFallback: '[role="group"]',

  // Team name within a card
  // Stability: MEDIUM — heading within team card context
  teamName: '[data-testid="team-name"]',
  teamNameFallback: '[class*="teamName" i]',

  // ── __NEXT_DATA__ (server-rendered props) ──────────────────────────────────

  // The Next.js server-side data blob — contains the full market object
  // including tickers, titles, prices at page-load time
  // Access: JSON.parse(document.getElementById('__NEXT_DATA__').textContent)
  nextDataScript: '#__NEXT_DATA__',
  // After parsing, path to markets array: NEEDS VERIFICATION
  // Likely: nextData.props.pageProps.event.markets OR .pageProps.markets
};
```

---

## 9. NEEDS VERIFICATION Checklist

The following items require live DevTools inspection on a real Kalshi market page. Open any MLB/NBA market page, open Chrome DevTools (F12), and verify each item.

| # | Item | How to Verify | Priority |
|---|---|---|---|
| 1 | Exact sidebar heading selector (`aside h2` vs other) | Inspect → find "Buy Yes · [Team]" text → check parent chain | Critical |
| 2 | Sidebar separator character (· vs • vs - vs /) | Copy the heading text to clipboard; check Unicode codepoint | Critical |
| 3 | Tab `aria-selected` attribute | Inspect tab buttons, check attributes panel | Critical |
| 4 | `data-testid` on orderbook container | Inspect → search for "orderbook" in attributes | High |
| 5 | `data-testid` on ask/bid sections | Same as above for "asks", "bids" | High |
| 6 | `role="row"` on ladder rows | Inspect a price row; check role attribute | High |
| 7 | Buy button aria-label format | Inspect "Yes 58¢" button; check aria-label | High |
| 8 | Compact button text format (joined vs spaced) | `button.innerText` vs `button.textContent` — are they different? | High |
| 9 | `window.__NEXT_DATA__` shape | Console: `JSON.stringify(window.__NEXT_DATA__.props.pageProps, null, 2)` | High |
| 10 | URL change on tab toggle (Yes/No) | Click Trade Yes then Trade No; watch URL bar | Medium |
| 11 | Team card `data-testid` | Inspect team name area; look for data attrs | Medium |
| 12 | Total column format ($481.96K vs $481,960) | Look at a deep-liquidity market (NBA prime time) | Medium |
| 13 | Last price text exact format | Inspect midpoint row text | Medium |
| 14 | Time in ticker format (with/without HHMM) | Compare 2-3 tickers for same sport on different days | Low |
| 15 | DOM settle time after navigation | Performance panel or console.time around navigation | Low |

### Quick DevTools Recipe for #9 (`__NEXT_DATA__`):
```javascript
// Run in DevTools console on any Kalshi market page:
const d = JSON.parse(document.getElementById('__NEXT_DATA__').textContent);
console.log('pageProps keys:', Object.keys(d.props.pageProps));
// Look for: event, market, ticker, eventTicker, series, etc.
```

This single command will answer at least 5 of the above items simultaneously, because `__NEXT_DATA__` contains the full server-rendered market object with all tickers, team names, and structure.

---

## 10. Known Bugs in Current Scraper (Summary)

| Bug | Root Cause | Fix |
|---|---|---|
| URL extracts `KXMLBGAME` instead of `KXMLBGAME-26APR101420PITCHC` | Regex `/^kx[a-z0-9]/i.test(s) && s.length > 4` matches the series code (`length=9 > 4`); reverse scan stops at first match only if series code comes after event ticker (index ordering matters) | Use `segments[3].toUpperCase()` directly, or tighten regex to `/^kx[a-z]+-\d{2}[a-z]{3}\d{2}/i` |
| Wrong team detected as current side | Occurrence counting on `body.innerText` — both teams have equal or noisy frequency | Parse sidebar heading `aside h2` → "Buy Yes · [Team]" instead |
| Only best ask extracted, no ladder depth | `extractOrderbook()` scans all buttons for `"Yes 58¢"` pattern — finds only compact buy buttons, not ladder rows | Target the orderbook container and walk `[role="row"]` elements, split by midpoint |

---

## 11. Memory Entries

The following observations should be preserved in agent memory for future sessions:

- Kalshi ticker = last URL path segment (index 3, 0-based from after `/markets/`) uppercased
- Series codes like `kxmlbgame` are index 1 and must not be confused with event tickers at index 3
- Selected team is in `aside h2` text: `"Buy Yes · [Team]"` format
- Separator between side and team in sidebar heading is middle dot `·` (U+00B7) — UNCONFIRMED, needs DevTools
- Tab state: `[role="tab"][aria-selected="true"]` — UNCONFIRMED, needs DevTools
- Orderbook is a separate DOM section with ask rows above midpoint and bid rows below
- `window.__NEXT_DATA__` contains full market data including tickers — useful fallback
- Kalshi uses Next.js with CSS Modules — hashed class names change on every deploy, never rely on them
- Navigation is client-side pushState — 400ms delay may be too short, 600-800ms safer
- MutationObserver on `document.body` + 800ms debounce is the right pattern for live price tracking
