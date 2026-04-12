# Kalshi Portfolio / Positions Tab — Research Document

> Reconnaissance for extending the `kalshi-sharp-fv` Chrome extension to annotate open positions with unrealized fair EV%.
> This is a DOM research document. No extension code lives here.
> Last updated: 2026-04-10
>
> **Verification status legend:**
> - VERIFIED — confirmed from live DOM observation or Kalshi public API docs
> - INFERRED — derived from Kalshi patterns, the resting orders research, and known Next.js / React behavior; high confidence but not confirmed with DevTools
> - NEEDS VERIFICATION — must be confirmed by opening the page in a logged-in DevTools session before relying on it

**Companion docs:**
- `docs/kalshi_portfolio_research.md` — resting orders tab; read this first; the positions tab is structurally parallel
- `docs/kalshi_web_research.md` — individual market pages

---

## TL;DR for the Extension Engineer

The positions tab lives at `/portfolio?tab=positions`. Its rows describe **filled holdings** the user currently holds, in contrast to resting orders (unfilled bids/asks). The key structural differences from the resting orders tab are:

1. **No `<input>` for price.** Resting orders have an editable limit-price `<input>` (the cell is an inline editor). Positions show a **static text** average cost basis — parse it the same way as the current-price cell on the resting tab.
2. **Side may not be "Buy Yes / Buy No".** Resting orders always link to a "Buy Yes - TeamName" or "Buy No - TeamName" text. Positions likely show side as a standalone "Yes" or "No" label (text or a colored chip) and team name separately — the link may be just the event name, not the action. **This is the biggest NEEDS VERIFICATION item.** The existing `extractRestingOrders()` filter `/^Buy\s+(Yes|No)\b/i` will not match position rows and cannot be reused directly.
3. **No cancel button column.** Positions have no action column for the resting-orders trash icon — the last column is likely P&L or a Close/Sell action.
4. **Ticker extraction is identical.** Each row's market link uses the same `/markets/<series>/<sport-slug>/<event-ticker>` href pattern. Extract with `segments[3].toUpperCase()` exactly as in `extractEventTickerFromHref()`.
5. **Moneyline filter is the same.** `MONEYLINE_SERIES_RE` (`/^KX(MLB|NBA|NHL|NFL|NCAAMB|NCAAB|NCAAFB|NCAAF)GAME-/i`) applies unchanged.
6. **EV formula differs from resting orders.** Resting orders compare fair vs. limit price (edge on a prospective fill). Positions compare fair vs. average cost basis (unrealized edge on a holding already filled). The direction signal is: if `fair > costBasis`, the user should hold or add (position is in-the-money vs. fair); if `fair < costBasis`, the position is underwater vs. fair.
7. **Badge injection point.** Use the same floating-overlay approach already used for resting orders (`PORTFOLIO_BADGE_CLASS`, left gutter of row). The existing infrastructure in `content.js` can be reused with minimal extension.

---

## 1. URL / Page Detection

### 1.1 Exact URL

INFERRED (confirmed by the resting orders research doc, which lists this tab explicitly):

```
https://kalshi.com/portfolio?tab=positions
```

The `tab` parameter value is `positions` (plural), consistent with the resting orders research doc's listing at section 1.5. Do **not** use `tab=position` (singular) — Kalshi's nav links in the resting orders research doc quote the plural form.

NEEDS VERIFICATION: Navigate to the portfolio page, click the "Positions" tab in the nav, and inspect `window.location.search` in the console. Confirm it reads `?tab=positions` (not `?tab=position`, `?tab=holdings`, or `?tab=portfolio`).

### 1.2 SPA Navigation Behavior

VERIFIED (from resting orders research, section 4.4): Tab switching within the portfolio fires `history.pushState` or `history.replaceState` — not a full page reload. The URL changes from `/portfolio?tab=resting` to `/portfolio?tab=positions` (or any other tab) without a navigation request for HTML.

The existing `history.pushState` / `history.replaceState` monkey-patch in `content.js` (`watchRouteChanges()`) already handles this. Adding the positions tab requires only updating `isPortfolioPage()` — currently it checks `params.get("tab") === "resting"` — to also trigger on `tab=positions`.

### 1.3 Stable JS Page-Detection Check

```
isPositionsPage():
  window.location.pathname === '/portfolio'
  AND new URLSearchParams(window.location.search).get('tab') === 'positions'
```

Combined portfolio-page check (covers both tabs):

```
isPortfolioTabPage():
  window.location.pathname === '/portfolio'
  AND ['resting', 'positions'].includes(
        new URLSearchParams(window.location.search).get('tab')
      )
```

NEEDS VERIFICATION: Confirm the default tab when the user navigates to bare `/portfolio` (no `tab` param). If the default tab is positions, the absence of a `tab` param is also a trigger condition. Check: navigate to `https://kalshi.com/portfolio` (no query string) and observe (a) which tab is active in the UI and (b) whether a `tab` param appears in the URL after the page settles.

### 1.4 Authentication

VERIFIED (by logic): `/portfolio?tab=positions` is auth-gated identically to the resting orders tab. An unauthenticated user sees either a redirect to `/login` or an in-page auth wall. The same "no rows found = logged out or empty" no-op strategy applies.

---

## 2. DOM Structure of the Positions List

### 2.1 Page Layout

INFERRED (parallel to resting orders, section 2.1):

```
<body>
  <div id="__next">
    <header>...</header>
    <main>
      <div>                              ← portfolio page container
        <nav> or <div role="tablist">
          <a href="/portfolio?tab=positions">Positions</a>
          <a href="/portfolio?tab=resting">Resting Orders</a>
          <a href="/portfolio?tab=history">History</a>
          ...
        </nav>

        <!-- Positions content area — only rendered when tab=positions -->
        <div>                            ← tab content panel
          <table> or <div role="table">
            <thead>
              <tr>
                <th>Market</th>
                <th>Side</th>            ← NEEDS VERIFICATION: may be "Yes/No" not "Side"
                <th>Quantity</th>        ← contracts held
                <th>Avg cost</th>        ← average fill price in cents
                <th>Current price</th>   ← current market best ask/bid
                <th>P&L</th>             ← unrealized profit/loss
                ...                      ← NEEDS VERIFICATION: other columns
              </tr>
            </thead>
            <tbody>
              <!-- Rows may or may not be grouped by event -->
              <tr>
                <td>
                  <a href="/markets/kxmlbgame/professional-baseball-game/kxmlbgame-26apr12...">
                    San Diego vs Colorado   ← event name, NOT "Buy Yes - San Diego"
                  </a>
                </td>
                <td>Yes</td>             ← or a colored chip
                <td>400</td>             ← quantity
                <td>38c</td>             ← avg cost basis
                <td>36c</td>             ← current price
                <td>-$8.00</td>          ← unrealized P&L
              </tr>
              ...
            </tbody>
          </table>
        </div>
      </div>
    </main>
  </div>
</body>
```

NEEDS VERIFICATION: The entire column layout above is inferred from common prediction-market UI patterns and Kalshi's visual design language. Before implementing any nth-child selectors, open DevTools on the live positions tab and confirm every column header text and column count.

### 2.2 Table vs. Div Layout

INFERRED: Based on the resting orders research, Kalshi most likely uses a semantic `<table>/<thead>/<tbody>/<tr>/<td>` structure for portfolio data, not a `<div role="table">` ARIA table. Both are possible; the resting orders container-detection code already tries both (`main table` then `main [role="table"]`).

The same multi-strategy container detection used in `extractRestingOrders()` should apply unchanged:
1. `document.querySelector("main table")`
2. `document.querySelector('main [role="table"]')`
3. `document.querySelector("table")` (page-wide fallback)
4. Heuristic: smallest common ancestor of elements whose text matches the position row pattern

NEEDS VERIFICATION: Inspect the positions tab in DevTools Elements panel. Look at the tag name of the container and the row elements.

### 2.3 Row Grouping

INFERRED: Two possible grouping strategies — grouped by event (same as resting orders) or flat (ungrouped, one row per position).

**Flat (more likely for positions):** The resting orders tab groups by event because a user may have multiple open orders on the same game (different prices, different sides). For positions, after fills consolidate, a user typically holds one YES position and/or one NO position per market — the grouping reason is less compelling. A flat list is the more common UI pattern for holdings pages.

**Grouped by event (possible):** If a user holds both a YES and a NO position on the same game (e.g., as a hedge), Kalshi might group them under the same event header.

NEEDS VERIFICATION: Do any group-header rows appear in the positions table? In DevTools, look for any `<tr>` with a `colspan` attribute or a `<td>` that contains only event-name text. If none exist, it's a flat list.

### 2.4 Column Order and Headers

The exact column layout is NEEDS VERIFICATION. The most probable column set based on standard portfolio UI for prediction markets:

| Column Index (INFERRED) | Header Text (INFERRED) | Content Example | Notes |
|---|---|---|---|
| 1 | Market | Link: "San Diego vs Colorado" or "Buy Yes - San Diego" | NEEDS VERIFICATION: is it the event name or the order-action format? |
| 2 | Side | "Yes" or "No" (or a colored chip) | May be part of the Market cell, not its own column |
| 3 | Quantity | "400" | Integer, contracts held |
| 4 | Avg cost | "38c" or "38¢" | Average fill price in cents |
| 5 | Current price | "36c" or "36¢" | Current best bid/ask for this side |
| 6 | P&L | "-$8.00" or "-5.3%" | Unrealized gain/loss |

NEEDS VERIFICATION for each: (a) does the column exist, (b) exact header text, (c) whether "Side" is its own column or embedded in the Market cell link text, (d) whether P&L is dollars, percent, or both, (e) whether there are additional columns (e.g., "Value", "Close" button).

The column order is the single most important thing to verify before writing any `nth-child` selectors.

### 2.5 The Market Cell: Position Rows vs. Resting Order Rows

This is the critical structural difference. On the resting orders tab, the Market cell link text is `"Buy Yes - San Diego"` — the action verb is embedded in the link text itself, making it easy to detect and parse with `/^Buy\s+(Yes|No)\b/i`.

On the positions tab, the likely format is one of:

**Pattern A (most probable): Event name link + separate Side column**
```html
<tr>
  <td><a href="/markets/kxmlbgame/.../kxmlbgame-26apr12...">San Diego vs Colorado</a></td>
  <td>Yes</td>
  <td>400</td>
  ...
</tr>
```

Detection strategy: rows where `td:first-child a[href*="/markets/kx"]` exists AND a sibling `<td>` contains exactly "Yes" or "No".

**Pattern B: Action-style link (same as resting orders)**
```html
<tr>
  <td><a href="/markets/kxmlbgame/.../kxmlbgame-26apr12...">Buy Yes - San Diego</a></td>
  ...
</tr>
```

If Pattern B is used, the existing `extractRestingOrders()` row-detection filter (`/^Buy\s+(Yes|No)\b/i`) would work for positions too. The difference would only be in which cell holds the cost basis (a static `<td>` vs. an editable `<input>`).

**Pattern C: Team name in link, side as a chip/badge**
```html
<tr>
  <td>
    <a href="/markets/kxmlbgame/.../kxmlbgame-26apr12...">San Diego</a>
    <span class="[hashed]">YES</span>
  </td>
  ...
</tr>
```

NEEDS VERIFICATION: Open DevTools on a row in the positions tab. Inspect: (1) the text content of the Market cell, (2) whether it contains "Buy Yes" / "Buy No" phrasing or just the team/event name, (3) whether Side is a separate column or embedded in the Market cell.

---

## 3. Extracting Per-Position Data

### 3.1 Full Kalshi Ticker

**Extraction method: identical to resting orders.**

Every position row links to the same `/markets/<series>/<sport-slug>/<event-ticker>` URL pattern:

```html
<a href="/markets/kxmlbgame/professional-baseball-game/kxmlbgame-26apr12...">
```

Extract with the existing `extractEventTickerFromHref()`:

```
href.split('/').filter(Boolean)[3].toUpperCase()
→ "KXMLBGAME-26APR12SDCOL"   ← event ticker (no team suffix)
```

Selector for the row's market link:

| Element | Primary Selector | Fallback 1 | Fallback 2 | Stability |
|---|---|---|---|---|
| Row market link | `tr td:first-child a[href*="/markets/kx"]` | `td a[href^="/markets/kx"]` | `a[href*="kxmlbgame"], a[href*="kxnbagame"]` | **High** — href structure is stable |

INFERRED: The href contains only the event ticker (no team suffix), exactly as on the resting orders tab. The team suffix must be resolved via team name sent to the backend. See section 3.3.

### 3.2 Side (YES or NO)

NEEDS VERIFICATION: The method of expressing side depends on Pattern A / B / C (see section 2.5).

**If Pattern A (event name link + separate Side cell):**
```
sideCell = row.querySelector('td:nth-child(2)')  // NEEDS VERIFICATION: column index
side = sideCell.textContent.trim().toLowerCase() // "yes" or "no"
```
Selector:

| Element | Primary Selector | Fallback 1 | Fallback 2 | Stability |
|---|---|---|---|---|
| Side cell | `td:nth-child(2)` (positional — NEEDS VERIFICATION) | `td[data-column="side"]` | `td` whose text is exactly "Yes" or "No" | **Low** for nth-child (column order may vary); **High** for text match |

Text-match fallback (most stable regardless of column position):
```
Array.from(row.querySelectorAll('td')).find(
  td => /^(Yes|No)$/i.test(td.textContent.trim())
)
```

**If Pattern B (Buy Yes / Buy No link text):**
```
const m = link.textContent.match(/Buy\s+(Yes|No)/i)
side = m?.[1]?.toLowerCase()   // same as extractRestingOrders()
```

**If Pattern C (chip/badge inside Market cell):**
```
// Look for a <span> or <div> near the link with exactly "YES" or "NO"
const chip = row.querySelector('td:first-child [class*="yes" i], td:first-child [class*="no" i]')
// OR: any element in the Market cell whose text is "YES" or "NO"
const chip = Array.from(row.querySelector('td').querySelectorAll('*')).find(
  el => /^(yes|no)$/i.test(el.textContent.trim())
)
```

Class-based selectors (Pattern C) are LOW stability due to CSS Modules hashing. The text-match approach is the most stable across all patterns and should be the primary strategy.

### 3.3 Team Name (for ticker resolution)

INFERRED: The team name is needed to resolve the event ticker to a full market ticker (team suffix) when calling the backend.

**If Pattern A:** The event name in the link text is in "TeamA vs TeamB" format. The "selected" team (the one the YES position resolves for) is NOT directly in the link text — it must be inferred from the context or sent as null (the backend can attempt resolution without it, though with lower reliability).

INFERRED WORKAROUND: If the Side column says "Yes" and the event is "San Diego vs Colorado", there is no direct signal for which team the YES position is on without knowing which team's moneyline the user bet. However, Kalshi positions have a specific market ticker (team suffix was chosen at order time). The position row must link to or encode the team somehow.

Three possibilities:
1. **The link href includes the team suffix** (e.g., `/markets/kxmlbgame/.../kxmlbgame-26apr12sdcol-sd`). If so, ticker extraction is complete from the href alone.
2. **The link text includes the team** (Pattern B: "Buy Yes - San Diego"). Trivially parseable.
3. **The link text is just the event name** (Pattern A). In this case, the team is not visible in the row without additional context. The engineer should check whether Kalshi displays the team name anywhere else in the row (e.g., a tooltip, a secondary text node, or a sub-cell label).

NEEDS VERIFICATION (CRITICAL): Inspect the `href` attribute of the market link in a position row. Does it end with `-sd`, `-col`, `-nyy`, etc. (team suffix)? If yes, use `segments[4]` or parse the suffix from `segments[3]`. If no, the position row link is event-level only and team must come from row text or a separate column.

Selector for team name (if separate text):
```
// Attempt 1: link text contains team after a separator
const m = link.textContent.match(/Buy\s+(?:Yes|No)\s*[-–·]\s*(.+)/i)

// Attempt 2: secondary text node inside the Market cell
const teamEl = td.querySelector('span, p, div') // non-link text in Market cell

// Attempt 3: position href encodes team suffix — parse from href
const pathParts = href.split('/').filter(Boolean)
const eventTicker = pathParts[3]  // "kxmlbgame-26apr12sdcol-sd"
// if the ticker ends with "-XX", that's the team suffix
const teamSuffix = eventTicker.split('-').slice(-1)[0]  // "sd"
```

### 3.4 Average Cost Basis

**This is the key field that differs from resting orders.**

On the resting orders tab, limit price is in an editable `<input>` element (its value is `.value`, not `.textContent`). Positions have a static average cost basis displayed as plain text in a table cell.

INFERRED: The cost basis cell will contain text like "38c", "38¢", "0.38", or "$0.38" — consistent with Kalshi's formatting patterns.

Parse with the same multi-format regex already used for current-price cells in `extractRestingOrders()`:
```
/^(\d{1,2})\s*[c¢]$/i  → parse as cents directly
/^0?\.\d{2}$/           → multiply by 100 for cents
```

There is **no `<input>` to read** on this tab. If the scraper code blindly queries `row.querySelectorAll("input")`, it will find nothing and return `null` for the price — the code must instead look for text nodes. The resting orders text already falls back to text parsing when no `<input>` is found, but the fallback path uses the first `NN¢` text match (which finds the Current price cell, not the Avg cost cell). The positions scraper needs to target the correct column by position or a data attribute.

| Element | Primary Selector | Fallback 1 | Fallback 2 | Stability |
|---|---|---|---|---|
| Avg cost cell | `td:nth-child(4)` (NEEDS VERIFICATION — column index) | `td[data-column="avg-cost"]` | first `td` whose text matches `/^\d{1,2}[c¢]$/i` that is NOT the Current price column | **Medium** for nth-child; **Low** for text match alone (ambiguous with Current price) |

CRITICAL NOTE: If both "Avg cost" and "Current price" show values like "38c" and "36c", a naive "first NN¢ text match" will always grab the Avg cost column (leftmost). This is coincidentally correct but fragile. Use column index (verified) as primary.

### 3.5 Quantity (Contracts Held)

INFERRED: Plain integer, same format as the Contracts column on resting orders.

| Element | Primary Selector | Fallback 1 | Fallback 2 | Stability |
|---|---|---|---|---|
| Quantity cell | `td:nth-child(3)` (NEEDS VERIFICATION — column index) | `td[data-column="quantity"]` or `td[data-column="contracts"]` | `td` whose text matches `/^\d+$/` (pure integer) | **Medium** |

### 3.6 Current Market Price

INFERRED: Shown as "36c" or "36¢" — the same format as the Current price column on the resting orders tab.

This field is optional for the EV calculation (EV is computed from fair value vs. cost basis, not market price vs. cost basis). It may be used as a display reference or a signal for "should I close now?".

| Element | Primary Selector | Fallback 1 | Fallback 2 | Stability |
|---|---|---|---|---|
| Current price cell | `td:nth-child(5)` (NEEDS VERIFICATION — column index) | `td[data-column="current-price"]` | second `td` whose text matches `/^\d{1,2}[c¢]$/i` | **Medium** |

### 3.7 Unrealized P&L

INFERRED: Displayed as a dollar amount (`-$8.00`, `+$12.50`) or a percentage. Kalshi typically shows dollar P&L for positions rather than percentage.

This field is available from the DOM but is NOT needed for the extension's EV calculation — the extension computes its own fair-value-based EV independently. It may be logged for debugging or used as a sanity check.

| Element | Primary Selector | Fallback 1 | Stability |
|---|---|---|---|
| P&L cell | `td:nth-child(6)` (NEEDS VERIFICATION) | `td` whose text matches `/^[+-]\$[\d.]+$/` | **Low** for positional; **Medium** for text pattern |

### 3.8 Recommended Selector Map (for use by extension engineer)

```javascript
const POSITIONS_SELECTORS = {

  // --- Page detection ---
  pageMatch: /^\/portfolio$/,
  tabMatch: (url) => new URL(url).searchParams.get('tab') === 'positions',

  // --- Auth / empty state ---
  anyPositionRow: 'main tbody tr, main [role="row"]',
  authGate: '[data-testid="auth-wall"], [class*="authWall" i], main a[href*="/login"]',

  // --- List container ---
  // Try in order: semantic table, ARIA table, page-wide fallback
  listContainer: 'main table, main [role="table"]',
  listBody: 'main tbody, main [role="rowgroup"]',

  // --- Per-row fields ---
  // All indices are NEEDS VERIFICATION — confirm column order in DevTools

  // Ticker: from href of the market link
  rowMarketLink: 'td:first-child a[href*="/markets/kx"], td a[href*="/markets/kx"]',

  // Side: text "Yes" or "No" (standalone cell, or embedded in link text)
  // Primary: text match across all tds (most stable, works for all layout patterns)
  rowSideByText: (row) =>
    Array.from(row.querySelectorAll('td')).find(
      td => /^(Yes|No)$/i.test(td.textContent.trim())
    ),

  // Avg cost: INFERRED column index — NEEDS VERIFICATION
  rowAvgCostCell: 'td:nth-child(4)',
  rowAvgCostPattern: /^(\d{1,2})\s*[c¢]$/i,

  // Quantity: INFERRED column index — NEEDS VERIFICATION
  rowQuantityCell: 'td:nth-child(3)',

  // Current price (optional — for display)
  rowCurrentPriceCell: 'td:nth-child(5)',

  // P&L (optional — not needed for EV)
  rowPnlCell: 'td:nth-child(6)',
};
```

---

## 4. EV Calculation for Positions

### 4.1 Conceptual Difference from Resting Orders

Resting orders: EV is the edge on a **prospective fill** if the limit order executes.
```
restingEV = fair_cents - limit_price_cents
```
Positions: EV is the **unrealized edge** on a position already held at a given cost basis.
```
unrealizedEV_pct = (fair_cents - avg_cost_cents) / avg_cost_cents * 100
```

Or equivalently in raw cents:
```
unrealizedEV_cents = fair_cents - avg_cost_cents
```

The extension currently displays resting order EV as a percentage: `(ev > 0 ? "+" : "") + ev.toFixed(1) + "%"`. The same format works for positions.

### 4.2 Direction Logic

For a YES position at `avg_cost` cents:
```
fair_yes  = fair.yes_prob * 100   (from backend)
unrealizedEV = fair_yes - avg_cost
```

For a NO position at `avg_cost` cents:
```
fair_no = (1 - fair.yes_prob) * 100   (or fair.no_prob * 100)
unrealizedEV = fair_no - avg_cost
```

The backend already returns `yes_prob` and `no_prob` (or `yes_cents` / `no_cents` as fallback). This is the same computation as the resting orders `repositionPortfolioBadges()`, which already does:
```javascript
const fair = order.side === "yes" ? cached.fairYes : cached.fairNo;
const ev = ((fair - order.limitPrice) / order.limitPrice) * 100;
```

For positions, substitute `order.avgCost` for `order.limitPrice`.

### 4.3 Signal Display

Badge content:

| Condition | Display | Color |
|---|---|---|
| `unrealizedEV > 0.1` (holding winner vs fair) | `+N.N%` | green (`#4ade80`) |
| `unrealizedEV < -0.1` (holding loser vs fair) | `-N.N%` | red (`#f87171`) |
| `-0.1 <= unrealizedEV <= 0.1` (at fair) | `~0%` | gray (`#8a92a0`) |

Optional secondary signal (hold/close/add):

| Condition | Signal |
|---|---|
| `fair > currentMarketPrice AND fair > avgCost` | Adding contracts still has edge |
| `fair < currentMarketPrice` | Market has overshot fair; consider closing |
| `fair < avgCost` | Position is underwater vs. fair; hold or cut |

The extension MVP should show only the EV% badge. The hold/close/add signal can be a future enhancement.

---

## 5. Edge Cases

### 5.1 Zero Positions (Empty State)

INFERRED: When the user has no open positions, the table renders without any `<tbody>/<tr>` content, or shows a single row with empty-state text ("No positions", "You have no open positions", etc.).

Detection: same no-op strategy as resting orders — `main tbody tr` returns an empty NodeList, scraper exits gracefully without injecting badges.

NEEDS VERIFICATION: Navigate to the positions tab when you have no open positions. Inspect the DOM for any empty-state element — look for `[class*="empty" i]`, `[class*="noData" i]`, or a `<p>` / `<div>` containing "no positions" text. This is useful to distinguish "logged out" from "logged in with empty portfolio".

### 5.2 Partially-Filled Positions (Both Tabs)

INFERRED: When a resting order is partially filled, Kalshi creates a position for the filled portion while the unfilled remainder stays in the resting orders tab. The result:
- Resting orders tab: shows the remaining unfilled contracts (quantity reduced by fills)
- Positions tab: shows the filled contracts at the average fill price

Both tabs show the same game — a position row for 200 contracts YES at 38c AND a resting order for 200 contracts Buy Yes at 38c, both on the same event ticker. The extension must handle this without confusion: each tab's scraper is independent, and the two badges (one per tab) will show different EVs only if the fair value differs from both the limit price (resting) and the avg cost (position).

In practice, for game moneylines where the user placed a single bid, `limitPrice == avgCost`. The EV badges on both tabs will show the same value for this common case.

### 5.3 Settled / Closed Positions

INFERRED: Resolved positions (where the market has closed and the outcome is determined) do NOT appear in the positions tab. They appear in the History tab (`/portfolio?tab=history`). The positions tab shows only **open** (unresolved) positions.

The extension does not need to handle settled positions on this tab.

### 5.4 P&L Display: Dollar vs. Percentage

NEEDS VERIFICATION: Kalshi's positions tab likely shows dollar P&L (`-$8.00`) rather than percentage P&L, consistent with standard brokerage UI patterns. However, it may show both (e.g., `-$8.00 (-2.1%)`).

The extension's EV badge is computed independently of Kalshi's displayed P&L. Kalshi's P&L is based on mark-to-market (current price vs. cost basis), while the extension's EV is based on fair value vs. cost basis. These will differ: when Kalshi's market price is above fair value, the displayed P&L may be positive while the extension's fair EV is negative (the user is sitting on an unrealized gain vs. the market, but the fair signal says the market has overshot).

### 5.5 Average Cost vs. Fill Distribution

INFERRED: Kalshi shows a **single average cost basis**, not a distribution of individual fills. This is consistent with standard practice. Even if the user built a position over multiple fills at different prices, only the blended average is shown on this tab.

The extension uses the average cost basis directly in the EV formula — no distribution handling needed.

### 5.6 Non-Moneyline Positions

The same `MONEYLINE_SERIES_RE` filter used in `extractRestingOrders()` applies:

```javascript
const MONEYLINE_SERIES_RE = /^KX(MLB|NBA|NHL|NFL|NCAAMB|NCAAB|NCAAFB|NCAAF)GAME-/i;
```

Positions for player props (KXMLBHRRBIS, KXMLBSO, etc.), run totals (KXMLBTOTAL), YRFI/NRFI, spreads (KXMLBSPREAD), and any non-sports market should be skipped silently — no badge injected, no backend call made. The backend has no fair value for these market types and would return an error.

VERIFIED (from `content.js` line 1612): this exact regex is already implemented and tested for resting orders; reuse it unchanged.

### 5.7 Multi-Position Same Event

A user may hold both YES and NO on the same event (a hedge, or from different series in the same game). Each appears as a separate row. Both rows will link to the same event ticker but have different sides. The extension handles these as independent positions — each gets its own EV badge. The `orderKey` (used to dedup badges) must include side to avoid collisions:

```javascript
const orderKey = `${ticker}:${side}:${avgCost}:${idx}`;
// e.g., "KXMLBGAME-26APR12SDCOL:yes:38:0" and "KXMLBGAME-26APR12SDCOL:no:62:1"
```

This is the same key structure already used in `extractRestingOrders()`.

### 5.8 Dollar Sign vs. Cents Format for P&L

INFERRED: The P&L cell uses dollar notation (`-$8.00`) rather than cents notation. The Avg cost cell uses cents notation (`38c`). Do not confuse these. The P&L cell will never match `/^\d{1,2}[c¢]$/i`, so a text-match scan for cost basis will naturally skip it.

### 5.9 Mobile Layout

INFERRED: On narrow viewports, Kalshi may collapse the table into a card/accordion layout with stacked key-value pairs instead of horizontal columns. The nth-child selectors would not work. The left-gutter badge injection would also fail (the gutter space disappears on mobile).

Mitigation: the extension targets the Chrome desktop browser, so mobile layout is an edge case. The floating badge strategy (`left: rowRect.left - 8px`) will render the badge off-screen or on top of other content on narrow viewports. A minimum viewport width check (e.g., `window.innerWidth < 768`) can suppress badge injection on mobile.

---

## 6. Layout Constraints for Badge Injection

### 6.1 Available Space

The positions tab has a layout similar to the resting orders tab — a multi-column table with centred content within `<main>`. The gutter to the left of the first column is empty space on desktop viewports.

The existing badge injection in `applyPortfolioBadge()` already anchors to the **left gutter** of the row:
```javascript
badge.style.left = `${rowRect.left - 8}px`;
badge.style.top  = `${rowRect.top + rowRect.height / 2}px`;
badge.style.transform = "translate(-100%, -50%)";
```

This places the badge's right edge 8px to the left of the row's left edge, vertically centered. This approach is React-safe (badge is a direct child of `document.body`, outside Kalshi's React tree) and survives position list re-renders.

INFERRED: The positions table may have a narrower first column if side information is in a dedicated column (reducing the width of the Market column). If the Market column is narrower, there may be less gutter space. The left-gutter approach still works as long as the content is not flush with the viewport edge. On a standard 1440px monitor with Kalshi's centered layout, the gutter should be 60–120px wide.

### 6.2 Overlay Approach Recommendation

Use the **same floating overlay approach** as resting orders:
- Badges are `<span>` elements appended to `document.body`
- CSS class `kalshi-sharp-fv-order-ev` (already defined in `BADGE_STYLES`)
- Positioned via `getBoundingClientRect()` on scroll/resize/mutation
- `MutationObserver` on the list container triggers repositioning when the position list updates (e.g., if a position is closed or a new one opens)

The existing `PORTFOLIO_BADGE_CLASS`, `applyPortfolioBadge()`, `repositionPortfolioBadges()`, and `attachPortfolioObserver()` infrastructure can be reused directly. The engineer needs to:
1. Add an `isPositionsPage()` function and call `refreshPortfolio()` from it
2. Update `extractRestingOrders()` to handle position row format (no `<input>`, side as static text) — or create a parallel `extractPositions()` function that shares the same container-detection and ticker-extraction code

### 6.3 Alternative: Overlay the Avg Cost Column

An alternative to the left-gutter approach: overlay the badge **in the Avg cost column's space**, replacing or annotating the cost basis text with a "38c [+5.2%]" combined label. This is more contextually relevant (the EV annotation lives next to the number it modifies).

Tradeoff: anchoring to a specific column requires knowing its horizontal position, which is obtained via `getBoundingClientRect()` on `td:nth-child(4)` (or whichever column is confirmed). The badge would need to be wider to accommodate both the cost text and the EV. Since the badge is floating (not injected into the DOM cell), this is a positioning question, not a DOM modification question.

RECOMMENDATION: Left-gutter approach for MVP (reuses all existing infrastructure). Avg-cost-column overlay as a future enhancement once column positions are confirmed.

---

## 7. Moneyline Filter for Positions

### 7.1 Filter is Unchanged

VERIFIED (from `content.js`): The moneyline series regex used for resting orders is:

```javascript
const MONEYLINE_SERIES_RE = /^KX(MLB|NBA|NHL|NFL|NCAAMB|NCAAB|NCAAFB|NCAAF)GAME-/i;
```

This exact regex applies to positions with no modification. A user's position list on any given day may include:
- `KXMLBGAME-...` — MLB game winner — **include**
- `KXNBAGAME-...` — NBA game winner — **include**
- `KXNFLGAME-...` — NFL game winner — **include**
- `KXNHLGAME-...` — NHL game winner — **include**
- `KXMLBSO-...` — MLB strikeout prop — **skip**
- `KXMLBTOTAL-...` — MLB run total — **skip**
- `KXMLBHRRBIS-...` — MLB HR+RBI prop — **skip**
- `KXMLBSPREAD-...` — MLB run line — **skip**
- `KXPRESMARKET-...` or any non-sports market — **skip**

NCAAB / NCAAMB / NCAAFB / NCAAF are included in the regex (college basketball and football game winners), which the backend supports.

### 7.2 Skipping Non-Moneyline Rows

When `isMoneylineTicker(ticker)` returns false, the position row is silently skipped — no badge injected, no backend request made. This is the same behavior as resting orders. No error or placeholder badge should be shown for prop/total/spread positions.

---

## 8. Recommended Extraction Plan

Step-by-step strategy for a `extractPositions()` function, paralleling `extractRestingOrders()`:

**Step 1: Detect page and wait for DOM.**
```
isPositionsPage() → pathname === '/portfolio' AND tab === 'positions'
Wait up to 5s for 'main table' or 'main [role="table"]' to appear.
```

**Step 2: Find the list container.**
```
1. document.querySelector("main table")
2. document.querySelector('main [role="table"]')
3. document.querySelector("table")  // page-wide fallback
4. findPortfolioContainerByHeuristic()  // LCA of position-row text patterns
```

**Step 3: Collect candidate rows.**
```
container.querySelectorAll('tr, [role="row"]')
// If empty, try container.querySelectorAll("*") for div-based grids
```

**Step 4: Filter to position rows.**
```
// PRIMARY filter: row contains a link to /markets/kx...
rowHasMarketLink = row.querySelector('a[href*="/markets/kx"]') != null

// SECONDARY filter: row contains a cell with exactly "Yes" or "No"
rowHasSideCell = Array.from(row.querySelectorAll('td')).some(
  td => /^(Yes|No)$/i.test(td.textContent.trim())
)
// OR: row starts with "Buy Yes / Buy No" (if Pattern B layout)
rowHasBuyText = /^Buy\s+(Yes|No)\b/i.test(row.innerText?.trim())

// Accept row if: has market link AND (has side cell OR has buy text)
isPositionRow = rowHasMarketLink && (rowHasSideCell || rowHasBuyText)
```

**Step 5: Extract ticker from link href.**
```
link = row.querySelector('a[href*="/markets/kx"]')
ticker = extractEventTickerFromHref(link.getAttribute('href'))
// e.g., "KXMLBGAME-26APR12SDCOL"
```

**Step 6: Extract side.**
```
// Try Pattern A: standalone side cell
sideCell = Array.from(row.querySelectorAll('td'))
  .find(td => /^(Yes|No)$/i.test(td.textContent.trim()))
side = sideCell?.textContent.trim().toLowerCase()

// Try Pattern B: "Buy Yes/No" in link text
if (!side) {
  const m = link.textContent.match(/Buy\s+(Yes|No)/i)
  side = m?.[1]?.toLowerCase()
}
```

**Step 7: Extract team name.**
```
// Try: link text after "Buy Yes/No -"  (Pattern B)
const m = link.textContent.match(/Buy\s+(?:Yes|No)\s*[-–·]\s*(.+)/i)
team = m?.[1]?.trim()

// Try: team suffix in href (if href ends with "-XX")
// const suffix = ticker.split('-').pop()  // "SD", "COL", etc.
// NOTE: send to backend as team abbreviation only if full name unavailable
// PREFERRED: send full name if available; backend handles abbreviation mapping

// Fallback: send null — backend may be able to resolve without team
// (less reliable for disambiguation when two teams have same event ticker)
```

**Step 8: Extract avg cost basis.**
```
// No <input> on positions tab — read text content directly
// Strategy 1: nth-child column (verify index first)
avgCostCell = row.querySelector('td:nth-child(4)')
// Strategy 2: first td whose text matches /^\d{1,2}[c¢]$/i
avgCostCell = Array.from(row.querySelectorAll('td'))
  .find(td => /^\d{1,2}\s*[c¢]$/i.test(td.textContent.trim()))

raw = avgCostCell?.textContent.trim()
const m = raw.match(/^(\d{1,2})\s*[c¢]$/i)
avgCost = m ? parseInt(m[1], 10) : null
```

**Step 9: Apply moneyline filter.**
```
if (!isMoneylineTicker(ticker)) skip row  // no badge, no fetch
```

**Step 10: Build position object.**
```
{
  rowEl: row,
  orderKey: `${ticker}:${side}:${avgCost}:${idx}`,
  ticker,
  side,            // "yes" or "no"
  team,            // may be null
  avgCost,         // integer, cents
  priceCellEl: avgCostCell   // anchor for badge positioning
}
```

**Step 11: Batch-fetch fair values.**
Identical to `fetchFairsForOrders()` — deduplicate by `${ticker}:${team}`, send to backend.

**Step 12: Compute EV and render badges.**
```
fair = side === "yes" ? cached.fairYes : cached.fairNo
ev = ((fair - avgCost) / avgCost) * 100
applyPortfolioBadge(orderKey, priceCellEl, ev, side)
```

---

## 9. Critical NEEDS VERIFICATION Checklist

Ordered by impact on implementation correctness:

1. **Exact `tab` parameter value** — is it `positions` (plural) or `position` (singular)?
   - How to verify: click the Positions tab in the portfolio nav, read `window.location.search` in console.

2. **Side encoding** — is it Pattern A (separate column with "Yes"/"No"), Pattern B ("Buy Yes - Team" link text), or Pattern C (chip inside Market cell)?
   - How to verify: right-click a position row in DevTools Elements, inspect the `<td>` children and their text content.

3. **Full ticker in href** — does the Market link href end with the team suffix (`-sd`, `-col`, `-nyy`)?
   - How to verify: hover over or select the `<a>` element in a position row, read the full `href` attribute value.

4. **Column order and count** — what are the exact column headers, and in what order?
   - How to verify: inspect `<thead>` row children text content. Note the exact `textContent` of each `<th>`.

5. **Avg cost format** — is it "38c", "38¢", "$0.38", or "0.38"?
   - How to verify: select the Avg cost cell in DevTools, run `$0.textContent.charCodeAt(2)` in console to distinguish "c" (99) from "¢" (162).

6. **Table vs. div layout** — is the container `<table>` or `<div role="table">`?
   - How to verify: select the row container in DevTools, check `$0.tagName`.

7. **Grouping** — are rows grouped by event (with a group-header row) or flat?
   - How to verify: check whether there are any `<tr>` rows with `colspan` attributes or with only a single `<td>` child.

8. **Empty state DOM** — what element signals "no positions"?
   - How to verify: navigate to positions tab when no positions are held (after market resolution); inspect DOM for any `[class*="empty"]` or text-match elements.

9. **`__NEXT_DATA__` structure** — does `window.__NEXT_DATA__.props.pageProps` contain positions data?
   - How to verify (DevTools console on positions tab while logged in):
     ```javascript
     const d = JSON.parse(document.getElementById('__NEXT_DATA__').textContent);
     console.log(Object.keys(d.props?.pageProps ?? {}));
     ```
     If positions data is server-side rendered into `__NEXT_DATA__`, the full ticker (with team suffix) may be directly available, bypassing DOM scraping entirely.

10. **`data-testid` or `data-position-id` attributes on rows** — does Kalshi annotate position rows with stable data attributes?
    - How to verify: select a position row in DevTools, look for any `data-*` attributes on the `<tr>` element or its children.
