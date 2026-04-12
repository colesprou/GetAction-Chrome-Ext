# Kalshi Portfolio / Resting Orders Page — Research Document

> Reconnaissance for extending the `kalshi-sharp-fv` Chrome extension to annotate resting orders with EV%.
> This is a DOM research document. No extension code lives here.
> Last updated: 2026-04-10
>
> **Verification status legend used throughout:**
> - VERIFIED — confirmed from live DOM observation or Kalshi's public API docs
> - INFERRED — derived from Kalshi's known patterns, screenshot analysis, or component library behavior; high confidence but not confirmed with DevTools
> - NEEDS VERIFICATION — must be confirmed by opening the page in DevTools before relying on it

---

## TL;DR for the Extension Engineer

The resting orders page lives at `/portfolio?tab=resting`. The `tab` query parameter is how Kalshi distinguishes the five portfolio sub-views; switching tabs changes the query param while the path stays at `/portfolio`. The page is **auth-gated**: unauthenticated users see a login wall rather than any order data.

Key extraction facts:

1. **Ticker is in the link href on each row.** Each order row contains a link to the full market URL (`/markets/<series>/<sport-slug>/<event-ticker>`), from which the event ticker can be extracted using the same `segments[3].toUpperCase()` logic as the existing market-page scraper. The team suffix (`-SD`, `-COL`, etc.) is available from the "selected team" text in the same row's Market cell (e.g., "Buy Yes - Seattle").

2. **No single stable `data-testid` is confirmed on the list container.** Kalshi uses CSS Modules (hashed class names) throughout. The most stable selectors are structural: `main table`, `[role="table"]` within main, and text-content patterns.

3. **The page re-renders aggressively via React.** When an order is filled or canceled, Kalshi likely replaces the entire order list subtree (not just the affected row). A `MutationObserver` on the table/list container is the right detection strategy, with debounce.

4. **Badge injection point: end of row, after the Exp column.** The trash/cancel icon is in the last column. Inject the EV pill into the second-to-last column position (before the trash icon) or append a new `<td>` equivalent at the row's end. The Current price column is the most semantically appropriate anchor.

---

## 1. URL Patterns

### 1.1 Portfolio Route

The portfolio section lives at a single path:

```
https://kalshi.com/portfolio
```

Portfolio sub-views are selected via the `tab` query parameter:

```
https://kalshi.com/portfolio?tab=resting    ← resting (open) orders
https://kalshi.com/portfolio?tab=history    ← order fill/cancel history
https://kalshi.com/portfolio?tab=positions  ← current open positions
https://kalshi.com/portfolio?tab=overview   ← balance / PnL summary (NEEDS VERIFICATION: exact slug)
https://kalshi.com/portfolio?tab=watchlist  ← NEEDS VERIFICATION: whether this tab exists here
```

INFERRED: Based on how Next.js handles tabbed pages with URL state, the `tab` value is a query param (not a hash, not a separate route). This is consistent with Kalshi's known use of path-based routing without hash fragments (documented in `kalshi_web_research.md` section 1.5).

### 1.2 Tab Navigation Behavior

When the user clicks between portfolio tabs:
- The URL changes from `/portfolio?tab=resting` to `/portfolio?tab=history`, etc.
- This is a **client-side navigation** — `history.pushState` or `history.replaceState` fires, the path stays `/portfolio`, only the search string changes
- React re-renders the content area for the new tab; the nav header and account summary likely persist (no full remount)

NEEDS VERIFICATION: Whether tab switching uses `pushState` (which fires the scraper's `popstate` monkey-patch) or `replaceState`. Open DevTools > Network tab and watch for navigation requests when switching portfolio tabs. If no XHR/fetch fires for a new HTML document, it's pure client-state. If a fetch fires for a JSON payload, it's a data-only navigation.

The content script's existing `history.pushState` / `history.replaceState` monkey-patch will detect the URL change. Add `/portfolio` to the page-type detection logic to trigger the resting-orders scraper when `?tab=resting` is present.

### 1.3 URL Detection Logic for the Resting Orders Page

```
isRestingOrdersPage():
  pathname === '/portfolio'
  AND new URLSearchParams(location.search).get('tab') === 'resting'
```

Note: if the user lands on `/portfolio` with no `tab` param, the default tab may or may not be "resting" — NEEDS VERIFICATION. Do not assume; check for `?tab=resting` explicitly.

### 1.4 Authentication Requirement

VERIFIED (logical certainty): `/portfolio?tab=resting` requires authentication. There is no meaningful order data to show to a logged-out user.

INFERRED: An unauthenticated visit to `/portfolio?tab=resting` will either:
- (a) Redirect the browser to `/login?redirect=/portfolio%3Ftab%3Dresting`, or
- (b) Render the portfolio page shell but show a "Sign in to view your portfolio" prompt in the content area, without redirecting

Option (b) is more common for Next.js apps with server-side session checking. In either case, the content script must detect this state before attempting to scrape.

NEEDS VERIFICATION: Exact behavior. Open a private/incognito window, navigate to `https://kalshi.com/portfolio?tab=resting`, and observe: (1) Does the URL change? (2) What DOM element signals the unauthenticated state?

### 1.5 Other Portfolio-Related URLs

```
https://kalshi.com/portfolio                        ← root (default tab, likely positions or overview)
https://kalshi.com/portfolio?tab=resting            ← resting orders (THIS PAGE)
https://kalshi.com/portfolio?tab=history            ← filled/canceled order history
https://kalshi.com/portfolio?tab=positions          ← open YES/NO position holdings
https://kalshi.com/portfolio/transactions           ← NEEDS VERIFICATION: may be /portfolio?tab=transactions
https://kalshi.com/account                          ← account settings (separate from portfolio)
```

---

## 2. DOM Structure of the Resting Orders List

### 2.1 Overall Page Layout

INFERRED from the screenshot and Kalshi's component library patterns:

```
<body>
  <div id="__next">
    <header>...</header>                          ← site nav (same as market pages)
    <main>
      <div>                                       ← portfolio page container
        <!-- Portfolio nav tabs -->
        <nav> or <div role="tablist">
          <a href="/portfolio?tab=positions">Positions</a>
          <a href="/portfolio?tab=resting">Resting Orders</a>
          <a href="/portfolio?tab=history">Order History</a>
          ...
        </nav>

        <!-- Resting orders content area — only present when tab=resting -->
        <div>                                     ← tab content panel
          <!-- Table or list container -->
          <table> or <div role="table">
            <thead> or header row
              <th>Market</th>
              <th>Filled</th>
              <th>Contracts</th>
              <th>Limit price</th>
              <th>Current price</th>
              <th>Cash</th>
              <th>Placed</th>
              <th>Exp</th>
              <th></th>                           ← cancel button column
            </thead>
            <tbody>
              <!-- Market group header (one per unique event) -->
              <tr class="...group-header...">     ← or a <div> separator
                <td colspan="9">Colorado vs San Diego</td>
              </tr>
              <!-- Order row -->
              <tr>
                <td>
                  <a href="/markets/kxmlbgame/professional-baseball-game/kxmlbgame-26apr12...">
                    Buy Yes - San Diego
                  </a>
                </td>
                <td>0</td>                        ← Filled count
                <td>400</td>                      ← Contracts
                <td>38c</td>                      ← Limit price
                <td>36c</td>                      ← Current price
                <td>$152.00</td>                  ← Cash (cost basis or value)
                <td>Apr 12, 2:05 PM</td>          ← Placed timestamp
                <td>Apr 12, 5:00 PM</td>          ← Expiry
                <td><button>🗑</button></td>       ← Cancel button
              </tr>
              <!-- More order rows for same event... -->
              <!-- Next event group header -->
              <tr class="...group-header...">
                <td colspan="9">Houston vs Seattle</td>
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

NEEDS VERIFICATION: Whether the structure uses `<table>/<tr>/<td>` (semantic HTML table) or `<div role="table">/<div role="row">/<div role="cell">` (ARIA table). Both are common in React component libraries. Check DevTools Elements panel on the portfolio page. The selector strategy differs significantly between the two.

### 2.2 Market Group Headers

From the screenshot, the resting orders list groups multiple orders under a single event header. The header text matches the event title format (e.g., "Colorado vs San Diego", "Houston vs Seattle", "Texas vs Los Angeles D").

INFERRED DOM structure for group headers — three candidate patterns, in decreasing likelihood:

**Pattern A: Full-width table row (most likely)**
```html
<tr>
  <td colspan="9" class="[hashed-class]">Colorado vs San Diego</td>
</tr>
```

**Pattern B: Separate `<thead>` per group (less common)**
```html
<thead>
  <tr><th colspan="9">Colorado vs San Diego</th></tr>
  <tr><th>Market</th><th>Filled</th>...</tr>
</thead>
<tbody>
  <!-- order rows for this event -->
</tbody>
```

**Pattern C: Non-table header div (if it's a div-based layout)**
```html
<div class="[hashed-class]">Colorado vs San Diego</div>
```

Selector candidates for group headers:

| Element | Primary Selector | Fallback 1 | Fallback 2 | Stability |
|---|---|---|---|---|
| Group header row | `tr:has(td[colspan])` | `tr[class*="group" i]` or `tr[class*="header" i]` | `tr:has(td:only-child)` | **Medium** — colspan is structural but not guaranteed |
| Group header text | `td[colspan]` within the header row | `[class*="groupHeader" i]` | `td:only-child` in header row | **Medium** |
| Header as `<th>` | `th[scope="rowgroup"]` | `th[colspan]` | — | **Low** — scope=rowgroup is rarely used in React apps |

NEEDS VERIFICATION: The exact element type (tr, div, th), whether colspan is used, and whether there's a distinct CSS class or data attribute. In DevTools, select the "Colorado vs San Diego" text and inspect its parent chain.

### 2.3 Individual Order Rows

From the screenshot, each order row has these columns:
- **Market**: "Buy Yes - San Diego" or "Buy No - Houston" (with a link)
- **Filled**: integer, "0" in the screenshot for all rows
- **Contracts**: integer quantity, e.g. "400", "0"
- **Limit price**: price in cents with "c" suffix, e.g. "38c", "58c"
- **Current price**: current best ask/bid for the same side, e.g. "36c"
- **Cash**: dollar value, e.g. "$152.00"
- **Placed**: human-readable timestamp, e.g. "Apr 10, 12:14 PM"
- **Exp**: expiry timestamp or "Game" for game-expiry orders
- **[cancel icon]**: trash icon button

INFERRED element type: Most likely `<tr>` with `<td>` children (semantic HTML table is the dominant pattern for tabular data like this in Kalshi's UI, and the columnar layout with a header row strongly suggests an HTML table).

Selector candidates for order rows:

| Element | Primary Selector | Fallback 1 | Fallback 2 | Stability |
|---|---|---|---|---|
| All order rows | `main tbody tr` | `[role="table"] [role="row"]` | `main tr:not(:has(td[colspan]))` | **Medium** — depends on table structure confirmation |
| Order row (excluding group headers) | `tbody tr:not(:has(td[colspan]))` | `tr[data-order-id]` | `tr` with >= 7 td children | **Medium** |

NEEDS VERIFICATION: Whether Kalshi adds a `data-order-id` or `data-testid` attribute to each row. This would be the most stable selector. In DevTools, right-click an order row and inspect for any data-* attributes.

### 2.4 Market / Event Identification Within a Row

The link in the Market column is the primary ticker source. Based on the screenshot text "Buy Yes - San Diego" with a link:

```html
<td>
  <a href="/markets/kxmlbgame/professional-baseball-game/kxmlbgame-26apr12SDCOL">
    Buy Yes - San Diego
  </a>
</td>
```

INFERRED: The href follows the same `/markets/<series>/<sport-slug>/<event-ticker>` pattern as individual market pages. The event ticker is `segments[3]` of the href path.

Selector candidates for the row link:

| Element | Primary Selector | Fallback 1 | Fallback 2 | Stability |
|---|---|---|---|---|
| Order link (href has ticker) | `tr td:first-child a[href*="/markets/"]` | `td a[href^="/markets/kx"]` | `a[href*="kxmlbgame"], a[href*="kxnbagame"], ...` | **High** — href pattern is structural and stable |
| Link text (side + team) | `tr td:first-child a` (textContent) | `td:first-child a` | — | **High** — text content, not class-dependent |

INFERRED ticker extraction from a row:
```
rowLink.getAttribute('href')
→ "/markets/kxmlbgame/professional-baseball-game/kxmlbgame-26apr121410sdcol"
→ split('/').filter(Boolean)[3].toUpperCase()
→ "KXMLBGAME-26APR121410SDCOL"   ← event ticker
```

NEEDS VERIFICATION: Whether the href is a full path (as above) or a relative path, and whether the exact event ticker format in the href is consistent with the market page URL format. Also verify that the link href is on the `<a>` element directly vs. a parent wrapper.

### 2.5 Side (Buy Yes / Buy No)

The link text contains the side. From the screenshot: "Buy Yes - San Diego", "Buy No - Houston".

```javascript
const linkText = rowLink.textContent.trim();
// "Buy Yes - San Diego" → side = "yes", team = "San Diego"
// "Buy No - Houston" → side = "no", team = "Houston"
const m = linkText.match(/Buy\s+(Yes|No)\s*[-–—]\s*(.+)/i);
const side = m?.[1]?.toLowerCase(); // "yes" or "no"
const selectedTeam = m?.[2]?.trim(); // "San Diego" or "Houston"
```

INFERRED: The separator between "Buy Yes/No" and the team name is a hyphen-minus `-` (U+002D) based on the screenshot text. This differs from the sidebar heading on individual market pages which uses a middle-dot `·` (U+00B7). The regex above covers both with `[-–—]` (hyphen, en-dash, em-dash variants).

Stability: **High** — this is link text content, not class-dependent. It will survive CSS changes and hashed class rebuilds.

### 2.6 Limit Price Column

From the screenshot, the Limit price column shows values like "38c", "58c" — a number followed by a lowercase "c" (not the `¢` Unicode symbol used in the orderbook). This is notable.

INFERRED: The "c" is plain ASCII `c`, not `¢` (U+00A2). This means the price parsing regex must handle both:
- `38c` → `/^(\d{1,2})c$/i`
- `38¢` → `/^(\d{1,2})¢$/` (used on market pages)

```javascript
const limitText = limitCell.textContent.trim(); // "38c"
const m = limitText.match(/^(\d{1,2})[c¢]/i);
const limitCents = m ? parseInt(m[1], 10) : null;
```

NEEDS VERIFICATION: Whether the "c" in the screenshot is truly lowercase ASCII `c` or the `¢` symbol rendered in a font that makes it look like "c". Open DevTools and check the raw textContent of the limit price cell.

| Element | Primary Selector | Fallback 1 | Fallback 2 | Stability |
|---|---|---|---|---|
| Limit price cell | `tr td:nth-child(4)` | `td[data-column="limit-price"]` | text matching `/^\d{1,2}[c¢]/i` | **Medium** — positional is fragile if columns reorder |

NEEDS VERIFICATION: The exact column index. The screenshot shows: Market (1), Filled (2), Contracts (3), Limit price (4), Current price (5), Cash (6), Placed (7), Exp (8), Cancel (9). Confirm this ordering in DevTools.

### 2.7 Contracts (Quantity) Column

From the screenshot: values like "400", "0". Plain integers with no unit suffix.

| Element | Primary Selector | Fallback 1 | Fallback 2 | Stability |
|---|---|---|---|---|
| Contracts cell | `tr td:nth-child(3)` | `td[data-column="contracts"]` | — | **Medium** — positional |

```javascript
const qty = parseInt(contractsCell.textContent.trim(), 10);
```

### 2.8 Filled Count Column

From the screenshot: all values are "0". This represents the number of contracts already filled on a partially-filled resting order.

| Element | Primary Selector | Fallback 1 | Fallback 2 | Stability |
|---|---|---|---|---|
| Filled count cell | `tr td:nth-child(2)` | `td[data-column="filled"]` | — | **Medium** — positional |

### 2.9 Cancel / Trash Icon Button

Each row ends with a button to cancel the order. The button likely contains an SVG trash icon or an icon font character.

| Element | Primary Selector | Fallback 1 | Fallback 2 | Stability |
|---|---|---|---|---|
| Cancel button | `tr td:last-child button` | `button[aria-label*="cancel" i]` | `button[aria-label*="delete" i]` | **Medium** if no aria-label; **High** if aria-label present |

NEEDS VERIFICATION: Whether the cancel button has an `aria-label` attribute (e.g., `aria-label="Cancel order"` or `aria-label="Delete order"`). An aria-label is the most stable selector and is standard accessibility practice for icon-only buttons.

---

## 3. Deriving the Full Kalshi Ticker for Each Order

### 3.1 What the Backend Needs

The backend's `/fair/<kalshi_ticker>` endpoint needs the **full market ticker including team suffix**, e.g.:
- `KXMLBGAME-26APR121410SDCOL-SD` ← San Diego wins YES ticker
- `KXMLBGAME-26APR121410SDCOL-COL` ← Colorado wins YES ticker

The portfolio page row gives you:
1. **Event ticker** — from the link href (`KXMLBGAME-26APR121410SDCOL`)
2. **Selected team name** — from the link text ("San Diego")
3. **Side** — from the link text ("Yes" or "No")

### 3.2 Ticker Reconstruction Strategy

**Option A: Send event ticker + team name + side to the backend (RECOMMENDED)**

The backend already does team-name → ticker-suffix matching via its Optic Odds mapping. Sending `{ event_ticker: "KXMLBGAME-26APR121410SDCOL", team: "San Diego", side: "yes" }` is the same interface as the market page scraper, which also sends event ticker + team name. No new logic needed in the extension.

**Option B: Extract full ticker from link href (if available)**

INFERRED: The `/portfolio?tab=resting` page links to individual market pages (`/markets/<series>/<sport-slug>/<event-ticker>`), not to individual team-specific sub-pages. Kalshi's market pages show the event-level view (both teams), not a ticker-specific view. Therefore the href contains only the **event ticker**, not the team suffix.

However, if Kalshi ever adds a link directly to a specific team's market (e.g., a `?team=SD` query param or a separate URL like `/markets/kxmlbgame/.../kxmlbgame-26apr12...-sd`), Option B becomes available.

NEEDS VERIFICATION: Inspect the actual href of the Market column link on the portfolio page. If it includes a team suffix in the path or a query param, document it here.

**Option C: Parse team abbreviation from event ticker**

The event ticker encodes both team codes concatenated (e.g., `SDCOL` = SD + COL in `KXMLBGAME-26APR121410SDCOL`). With the selected team name "San Diego" in hand, matching "San Diego" → "SD" requires an abbreviation lookup table. This is fragile and not recommended as a primary strategy; use Option A.

### 3.3 EV Calculation Direction

A resting "Buy Yes" order at `38c` on the San Diego ticker means:
- You are bidding 38¢ for YES contracts on San Diego winning
- If filled, you own YES at 38¢ cost basis
- EV = `(fair_yes_cents - 38)` per contract (positive = you have edge)

A resting "Buy No" order at `42c` on the San Diego ticker means:
- You are bidding for NO contracts on San Diego winning (i.e., betting Colorado wins)
- The fair value for NO = `fair_no_cents` = `100 - fair_yes_cents`
- EV = `(fair_no_cents - 42)` per contract

The EV display annotation should show:
- `+N.Nc EV` in green if EV > 0 (you have edge at this limit price if filled)
- `-N.Nc EV` in red if EV < 0 (you're paying too much)
- `~0 EV` in gray if near zero

---

## 4. SPA Behavior and List Updates

### 4.1 WebSocket Push Updates

INFERRED (high confidence): Kalshi uses WebSocket for real-time order state updates. The same WebSocket connection (`wss://trading-api.kalshi.com/trade-api/v2/ws/v2` — NEEDS VERIFICATION of exact endpoint) that drives live market price updates also sends order fill and cancellation events to the portfolio page.

When an order fills:
- Kalshi receives a fill event via WebSocket
- React re-renders the order row (or removes it if fully filled)
- The DOM mutation occurs without any URL change

### 4.2 How Cancellations and Fills Affect the DOM

Three possible re-render behaviors (ordered by likelihood for a React + virtual DOM application):

**Behavior A: Full list replace (most likely)**
The entire `<tbody>` (or equivalent list container) is replaced by React when any order changes. This is the simplest React pattern — the component's state updates, and React diffs/re-renders the whole list. From the MutationObserver's perspective, multiple `childList` mutations fire rapidly.

**Behavior B: Row-level update**
Only the affected `<tr>` is removed/updated. More surgical, requires React to track stable keys (e.g., by order ID). Likely if Kalshi uses `key={order.id}` on list items (standard React practice).

**Behavior C: Animation + removal**
The row gets a CSS class applied (e.g., `class="...animating-out..."`) for a brief period before the DOM node is removed. This is cosmetic and doesn't affect extraction.

In all three behaviors, the MutationObserver strategy is the same: watch the list container subtree for `childList` mutations, debounce by 400–800ms, then re-scrape all visible rows.

NEEDS VERIFICATION: Click the trash/cancel icon on a resting order (on a test/throwaway order) and observe in DevTools > Elements panel whether the `<tbody>` content is replaced wholesale or only the individual row is removed.

### 4.3 MutationObserver Strategy for Resting Orders

The correct anchor for the MutationObserver is the **table/list container**, not `document.body`. This minimizes spurious re-triggers from unrelated DOM changes.

```
observe target: main table  (or main [role="table"])
options: { childList: true, subtree: true }
debounce: 600ms (slightly more than the market-page 800ms because fills are less frequent
         and we can afford slightly more latency)
```

After each debounced mutation:
1. Check `window.location.pathname === '/portfolio'` and `?tab=resting` is still active
2. Re-scrape all order rows
3. Send updated tickers to backend for fresh fair values
4. Redraw EV badges

### 4.4 Tab Switch Detection

When the user switches from `?tab=resting` to another tab:
- The URL changes (`history.pushState` fires)
- The resting orders DOM is unmounted
- All injected badges must be removed (they're outside React's tree, attached to the DOM directly)

When the user returns to `?tab=resting`:
- The URL changes back
- The list re-renders (may fetch fresh data)
- The scraper must re-run and re-inject badges

The existing `history.pushState`/`replaceState` monkey-patch in `content.js` handles this correctly, provided the portfolio page is added to the page-type detection logic.

---

## 5. Sign-In Detection

### 5.1 Unauthenticated State Indicators

INFERRED: When an unauthenticated user visits `/portfolio?tab=resting`, Kalshi shows one of:

**Scenario A: Redirect to login (client-side or server-side)**
- The URL becomes `/login` (or `/sign-in`) with a `?redirect=` or `?next=` query param
- `window.location.pathname !== '/portfolio'` — the scraper can detect this and no-op

**Scenario B: Auth wall rendered in-page (no redirect)**
- The URL stays at `/portfolio?tab=resting`
- The content area shows a "Sign in to view your portfolio" prompt
- No table or order rows exist in the DOM

For Scenario B, the safest detection strategy is a negative check: if `isRestingOrdersPage()` returns true but no order rows are found after waiting 3 seconds, the user is either logged out or has no resting orders. Both cases should be treated the same: no-op.

| Signal | Selector | What it means | Stability |
|---|---|---|---|
| Auth wall container | `[data-testid="auth-wall"]` or `[class*="authWall" i]` | Not logged in (Scenario B) | **Low** — needs verification |
| Login prompt text | element with text "Sign in" or "Log in" in main | Not logged in | **Medium** — text content |
| Absence of any `<tr>` or `[role="row"]` in main | `main tr` returns NodeList.length === 0 | Logged out OR no orders | **High** — structural absence |
| "0 resting orders" empty state | `main` contains text matching `/no (resting|open) orders/i` | Logged in but no orders | **Medium** |

NEEDS VERIFICATION: Navigate to `/portfolio?tab=resting` in a private window and check: (1) URL change or not; (2) exact DOM structure of the auth wall; (3) whether there's a `data-testid` on the auth gate element.

### 5.2 Recommended Auth-Detection Logic

```
function isLoggedIn():
  // Approach 1: check for a user-specific DOM signal (e.g., avatar/initials in nav)
  //   Look for an element in <header> whose text matches /^[A-Z]{1,2}$/ (user initials)
  //   or an element with aria-label containing "account" or "profile"
  //   NEEDS VERIFICATION: what exact element Kalshi uses for the logged-in state in the header

  // Approach 2: check for absence of login-wall elements
  //   No <a href="/login"> or <button>Sign in</button> visible in main
  
  // Approach 3 (most reliable): check localStorage/cookie (NEEDS VERIFICATION)
  //   Kalshi may set a non-HttpOnly auth indicator in localStorage
  //   e.g., localStorage.getItem('kalshi_user_id') !== null
  //   Check Application > Local Storage in DevTools on a logged-in session
```

NEEDS VERIFICATION: Inspect `localStorage`, `sessionStorage`, and cookies (non-HttpOnly ones visible to JS) on a logged-in Kalshi session. Any key that contains user ID, session token indicator, or auth state is usable. The presence of orders in the DOM is the most bulletproof signal.

---

## 6. Layout Constraints for Badge Injection

### 6.1 Available Space Per Row

The portfolio table is a data-dense table. From the screenshot, the columns are:
- Market: wide (contains a multi-word link like "Buy Yes - San Diego")
- Filled: narrow (single digit "0")
- Contracts: narrow (3-4 digits)
- Limit price: narrow ("38c")
- Current price: narrow ("36c")
- Cash: medium ("$152.00")
- Placed: medium (datetime string)
- Exp: medium
- Cancel: narrow (icon only)

Row height is estimated at 40–48px based on typical Kalshi table styling (consistent with their market pages).

### 6.2 Injection Point Options

**Option A: After "Current price" column (RECOMMENDED)**

Inject the EV pill between the Current price column and the Cash column. This places it immediately next to the limit and current price data, which is the most contextually relevant position. The EV is a function of those two prices plus fair value.

Implementation: add a new `<td>` (or `<div role="cell">`) after the Current price cell. This requires modifying the row, which survives React re-renders only if done carefully (see Section 6.4).

**Option B: End of row, before cancel icon**

Append the EV pill as the second-to-last cell (before the trash icon). Less contextually adjacent but avoids interfering with the main data columns. The trash icon column is narrow; the EV pill would live in a new cell just before it.

**Option C: Floating badges anchored to row position (same as market-page bid badges)**

Use the same `position: fixed` floating overlay technique as `injectLadderBadges()` on market pages. Create a body-level container (`<div id="kalshi-sharp-fv-portfolio-overlay">`), then for each row, compute `getBoundingClientRect()` and position a fixed badge aligned to the right edge of the Current price cell.

**Recommendation: Option C (floating overlay)**

Reason: the portfolio table is likely to have React re-render the entire `<tbody>` on any order change (see Section 4.2). Injected `<td>` elements inside `<tr>` nodes will be wiped by React re-renders. A floating overlay outside React's tree survives re-renders (as the market-page ladder badges already demonstrate). The position needs to be updated on scroll and on each re-render, but that's already handled by the existing `ladderOverlay` pattern in `content.js`.

### 6.3 Badge Dimensions and Alignment

Suggested badge dimensions:
- Width: 56–72px (enough for "-5.2c EV" or "+12.4c EV")
- Height: 22–26px (fits comfortably in a 40–48px row)
- Position: right-aligned to the Current price column's right edge

The badge should not overlap the trash icon. Since the trash icon is in the last column (right edge of the table), and the floating badge is anchored to the Current price column (5th column from left), there is adequate separation.

### 6.4 React Re-Render Survivability

INFERRED: Kalshi's portfolio table will re-render the order list whenever:
- A new order is placed
- An order is partially or fully filled
- An order is canceled
- The page is first loaded
- The user returns to `?tab=resting` from another tab

Each re-render replaces the `<tbody>` content, wiping any injected `<td>` elements. The floating overlay approach is the correct solution: badges live in `document.body > #kalshi-sharp-fv-portfolio-overlay`, survive React re-renders, and are repositioned via `getBoundingClientRect()` after each MutationObserver trigger.

---

## 7. Recommended Selector Map

```javascript
const RESTING_ORDERS_SELECTORS = {

  // --- Page detection ---

  // Matches the portfolio section of Kalshi
  pageMatch: /^\/portfolio$/,
  // Matches specifically the resting orders tab
  tabMatch: (url) => new URL(url).searchParams.get('tab') === 'resting',

  // --- Auth detection ---

  // Absence of this element means either logged out or no orders.
  // Presence of any <tr> (or role="row") confirms logged in + has orders.
  // Stability: HIGH — structural absence is the most reliable signal.
  anyOrderRow: 'main tbody tr, main [role="row"]',

  // Login/auth gate signal — NEEDS VERIFICATION (inspect a logged-out session).
  // Possible candidates:
  authGate: '[data-testid="auth-wall"], [class*="authWall" i], main a[href*="/login"]',

  // --- List structure ---

  // The table or list container holding all order rows.
  // Stability: MEDIUM — depends on whether it's a <table> or role="table".
  // NEEDS VERIFICATION: confirm table vs div-based layout in DevTools.
  listContainer: 'main table, main [role="table"]',

  // The scrollable body of the table (excludes column headers).
  // Stability: MEDIUM
  listBody: 'main tbody, main [role="rowgroup"]',

  // --- Market group headers ---

  // Row that contains only one cell (colspan or single child) with the event name.
  // Excludes this from the "order rows" scrape.
  // Stability: MEDIUM — depends on colspan pattern; NEEDS VERIFICATION.
  marketGroupHeader: 'tbody tr:has(td[colspan]), tbody tr:has(td:only-child)',

  // Text content of the group header (the event title like "Colorado vs San Diego")
  // Stability: HIGH — it's raw text content, not class-dependent.
  marketGroupHeaderText: 'td[colspan], td:only-child',   // within a group header row

  // --- Order rows ---

  // A single order row — excludes group headers.
  // Stability: MEDIUM — positional/structural, not keyed by data attribute.
  // NEEDS VERIFICATION: whether Kalshi adds data-order-id or data-testid to rows.
  orderRow: 'tbody tr:not(:has(td[colspan])), tbody tr:not(:has(td:only-child))',

  // Alternative if Kalshi uses data attributes (NEEDS VERIFICATION):
  // orderRow: 'tr[data-order-id]',
  // orderRow: '[data-testid="order-row"]',

  // --- Within a row ---

  // The link in the first cell — href contains the event ticker URL.
  // e.g., href="/markets/kxmlbgame/professional-baseball-game/kxmlbgame-26apr12..."
  // This is the primary ticker source and side/team source.
  // Stability: HIGH — href pattern is structural and won't change with CSS rebuilds.
  orderRowLink: 'td:first-child a[href*="/markets/"], td:first-child a[href*="kx"]',

  // The full link text, e.g. "Buy Yes - San Diego" or "Buy No - Houston".
  // Parse with: /Buy\s+(Yes|No)\s*[-–]\s*(.+)/i
  // Stability: HIGH — text content, language/phrasing unlikely to change.
  // (No selector needed — read textContent of orderRowLink)
  orderRowLinkText: null,   // use orderRowLink.textContent.trim()

  // Side of the order: parse from orderRowLink text.
  // "Buy Yes" → side = "yes"; "Buy No" → side = "no"
  // Stability: HIGH — text content.
  orderRowSide: null,       // derived from link text, not a separate selector

  // Selected team: parse from orderRowLink text after the hyphen.
  // "Buy Yes - San Diego" → team = "San Diego"
  // Stability: HIGH — text content.
  orderRowTeam: null,       // derived from link text, not a separate selector

  // Filled count (2nd column). Value is integer like "0" or "50".
  // Stability: MEDIUM — positional.
  // NEEDS VERIFICATION: confirm column index.
  orderRowFilledCount: 'td:nth-child(2)',

  // Contracts quantity (3rd column). Value is integer like "400".
  // Stability: MEDIUM — positional.
  // NEEDS VERIFICATION: confirm column index.
  orderRowQuantity: 'td:nth-child(3)',

  // Limit price (4th column). Value is like "38c" or "38¢".
  // Parse with: /^(\d{1,2})[c¢]/i → parseInt cents.
  // Stability: MEDIUM — positional.
  // NEEDS VERIFICATION: confirm column index and whether "c" or "¢" is used.
  orderRowLimitPrice: 'td:nth-child(4)',

  // Current best price for this side (5th column). Value is like "36c" or "36¢".
  // This is the current market price for the same side as the resting order,
  // useful as a reference but NOT the basis for EV (use fair value vs. limit price).
  // Stability: MEDIUM — positional.
  orderRowCurrentPrice: 'td:nth-child(5)',

  // Cash column (6th column). Dollar value like "$152.00".
  // Stability: MEDIUM — positional.
  orderRowCash: 'td:nth-child(6)',

  // Placed timestamp (7th column). Human-readable like "Apr 10, 12:14 PM".
  // Stability: MEDIUM — positional.
  orderRowPlaced: 'td:nth-child(7)',

  // Expiry (8th column). May be a datetime or "Game" for game-expiry orders.
  // Stability: MEDIUM — positional.
  orderRowExp: 'td:nth-child(8)',

  // Cancel/trash icon button (last column).
  // Stability: HIGH if aria-label present; MEDIUM if icon-only with no label.
  // NEEDS VERIFICATION: confirm aria-label text.
  orderRowCancelButton: 'td:last-child button, button[aria-label*="cancel" i], button[aria-label*="delete" i]',

  // --- Ticker extraction helper (applied to orderRowLink href) ---
  // Usage:
  //   const href = row.querySelector(SELECTORS.orderRowLink)?.getAttribute('href');
  //   const segments = href?.split('/').filter(Boolean);
  //   const eventTicker = segments?.[3]?.toUpperCase(); // e.g. "KXMLBGAME-26APR121410SDCOL"
  tickerFromHrefSegment: 3,   // index into href.split('/').filter(Boolean)

};
```

---

## 8. Verification Checklist for the Extension Engineer

Before writing any extension code for the portfolio page, verify each of these items by opening `https://kalshi.com/portfolio?tab=resting` (while logged in) in Chrome DevTools:

### DOM Structure
- [ ] **Table vs div**: Is the orders list rendered as `<table>/<tr>/<td>` or `<div role="table">/<div role="row">/<div role="cell">`?
- [ ] **Group header element**: Is the "Colorado vs San Diego" header a `<tr>` with a `colspan` `<td>`, a separate `<thead>`, or a standalone `<div>`?
- [ ] **data-testid or data-order-id on rows**: Right-click an order row, Inspect, look for any `data-*` attributes. Document all found.
- [ ] **data-testid on the table/container**: Inspect the parent of the first order row.

### Column Ordering
- [ ] **Confirm column 1–9 order**: Select the table's `<thead>` and copy the column names. Map to: Market, Filled, Contracts, Limit price, Current price, Cash, Placed, Exp, Cancel.
- [ ] **Price format**: Is it "38c" (ASCII c) or "38¢" (Unicode cent sign)? Check `td.textContent.charCodeAt(2)` for the character code.

### Link / Ticker
- [ ] **href format**: Right-click the "Buy Yes - San Diego" link → Inspect → look at the `href` attribute. Confirm it's `/markets/<series>/<sport>/<event-ticker>`.
- [ ] **Does href include team suffix?**: Check if the last path segment includes a `-SD` or similar suffix.
- [ ] **Link text format**: Confirm the separator: "Buy Yes - San Diego" (hyphen), "Buy Yes · San Diego" (middle dot), or something else.

### Auth and Navigation
- [ ] **Logged-out behavior**: Open a private/incognito window, navigate to `/portfolio?tab=resting`. Record the URL and DOM structure.
- [ ] **localStorage auth signal**: In a logged-in session, open DevTools > Application > Local Storage > `https://kalshi.com`. Document any keys that indicate auth state (user ID, session flag, etc.).
- [ ] **Tab switching**: Click between portfolio tabs and observe: does `history.pushState` fire? Does the URL change in the address bar?

### Re-render Behavior
- [ ] **Cancel a throwaway order**: Click the trash icon. Observe in Elements panel whether the whole `<tbody>` is replaced or only the specific `<tr>` is removed.
- [ ] **WebSocket**: Open DevTools > Network > WS filter. Note the WebSocket URL and the message format for order events.

### Cancel Button
- [ ] **aria-label**: Inspect the trash icon button for any `aria-label` attribute. Document the exact string.

---

## 9. Data Extraction Plan (Step-by-Step)

### Step 1: Detect Resting Orders Page
```
pathname === '/portfolio'
AND URLSearchParams(location.search).get('tab') === 'resting'
```

### Step 2: Wait for DOM to Settle
Poll every 100ms for up to 4 seconds. Gate on:
```
document.querySelector('main tbody tr') !== null
OR document.querySelector('main [role="row"]') !== null
```
If nothing appears after 4 seconds: either not logged in or no orders. Log and abort silently.

### Step 3: Detect Auth State
If no order rows found, check for a login-wall signal:
```
document.querySelector('main a[href*="/login"]')
OR document.querySelector('[class*="authWall" i]')
```
If detected: do not inject anything. Log "not authenticated — resting orders scraper dormant".

### Step 4: Scrape All Order Rows
```
const rows = document.querySelectorAll('tbody tr:not(:has(td[colspan]))');
// OR: document.querySelectorAll('tbody tr:not(:has(td:only-child))');
```
For each row:

1. **Extract link**: `row.querySelector('td:first-child a[href*="/markets/"]')`
2. **Extract event ticker from href**: `href.split('/').filter(Boolean)[3].toUpperCase()`
3. **Validate ticker**: must match `/^KX[A-Z]+GAME-\d{2}[A-Z]{3}\d{2}/`
4. **Extract side + team from link text**: parse `/Buy\s+(Yes|No)\s*[-–]\s*(.+)/i`
5. **Extract limit price**: `row.querySelector('td:nth-child(4)').textContent` → parse `/^(\d{1,2})[c¢]/i`
6. **Extract quantity**: `row.querySelector('td:nth-child(3)').textContent` → `parseInt`
7. **Extract filled**: `row.querySelector('td:nth-child(2)').textContent` → `parseInt`

### Step 5: Group by Event Ticker
Multiple rows may share the same event ticker (multiple resting orders on the same game at different prices or on both sides). Group them:
```
orders = Map<eventTicker, Array<{side, team, limitCents, quantity, filled, rowElement}>>
```

### Step 6: Send to Backend for Fair Values
For each unique event ticker, send a request similar to the existing market-page flow:
```
POST /fair   (or GET /fair/<ticker>)
body: { ticker: "KXMLBGAME-26APR121410SDCOL", team: "San Diego", side: "yes" }
response: { fair_yes_cents: 42, fair_no_cents: 58, ... }
```

Multiple tickers can be batched if the backend supports it (reduces round-trips for pages with many open orders).

### Step 7: Compute EV Per Row
For each order row:
```
if (side === 'yes'):
  ev = fair_yes_cents - limitCents
elif (side === 'no'):
  ev = fair_no_cents - limitCents

ev_pct = (ev / 100) * 100   // express as % of $1 contract
```

### Step 8: Inject EV Badges
Use the floating overlay approach (mirrors `injectLadderBadges`):
1. For each row, call `row.getBoundingClientRect()` to get position
2. Position a `position: fixed` badge aligned to the right edge of the Current price cell (`td:nth-child(5)`)
3. Attach a `MutationObserver` + scroll/resize handler to keep badge positions current

### Step 9: React to DOM Changes
On `MutationObserver` trigger (childList, subtree on `main table`):
1. Debounce 600ms
2. Verify still on `?tab=resting`
3. Remove all existing portfolio badges
4. Re-run Steps 4–8

---

## 10. Edge Cases

### 10.1 Orders on Spread / Total Markets (Non-Moneyline)

Not all resting orders will be on `KXMLBGAME`-type tickers. A user may have resting orders on:
- `KXMLBSPREAD-...` (run line)
- `KXMLBTOTAL-...` (over/under)
- `KXNBAPLAYOFFS-...` (series markets)
- Non-sports markets (elections, economics, weather)

The backend may not have fair values for spread/total/non-sports markets. The extension should:
1. Detect the series type from the event ticker prefix
2. For unsupported series: do not call the backend; render a neutral "no fair value" indicator or nothing
3. For supported moneyline series: proceed normally

### 10.2 Orders with 0 Contracts Remaining

Some rows show "Contracts: 0" in the screenshot. This may indicate:
- A fully-filled order that's still showing in "resting" (transitional state before it moves to "history")
- A canceled order mid-animation
- An error state

For rows where contracts = 0, the EV computation is meaningless. Skip badge injection for these rows.

### 10.3 Partially Filled Orders

A row with Filled=150 and Contracts=400 means 150 have been filled, 250 are still resting. The EV should be computed for the **remaining unfilled quantity** (250) at the resting limit price, not the full 400. The badge should annotate the remaining position's EV.

### 10.4 Multiple Orders at the Same Ticker and Side

A user may have two resting Buy Yes orders on "San Diego" at different prices (e.g., 35c and 38c). Each row gets its own EV badge based on its own limit price. No aggregation is needed.

### 10.5 Orders on Live / In-Progress Games

For games currently in progress, sharp sportsbook lines may be unavailable or unreliable. The backend should signal this via a `confidence` or `game_state` field. The badge should show "live - no FV" rather than a potentially stale EV number.

### 10.6 Table Pagination

If the user has many resting orders, Kalshi may paginate or virtualize the list. Only visible rows will be present in the DOM at any time.
- Pagination: a "Next page" button or numbered pages. The MutationObserver approach handles this — each page load replaces the `<tbody>` content.
- Virtualization (rare, more complex): only visible rows are in the DOM; scrolling causes rows to mount/unmount. This would require a more sophisticated badge positioning strategy. NEEDS VERIFICATION: whether Kalshi uses list virtualization on the portfolio page.

### 10.7 Team Name Truncation on Portfolio Page

Unlike market pages where team names are known to be truncated ("Los Angeles C", "Chicago C"), portfolio rows may use the full team city name from the link text (e.g., "San Diego", "Colorado"). This differs from the team codes in the ticker (SD, COL). The backend matching logic needs to handle both forms.

### 10.8 Empty State ("No Resting Orders")

When logged in but with no open orders, the DOM shows an empty state. The content script must not error on this. After the DOM settle wait, if no order rows are found and no auth wall is detected, simply log "no resting orders — nothing to annotate" and exit silently.

---

## 11. Selector Summary Table (Quick Reference)

| Data Point | Selector | How to Parse | Stability |
|---|---|---|---|
| Page match | `pathname === '/portfolio' && tab=resting` | URL API | **High** |
| Auth gate (negative) | absence of `main tbody tr` | NodeList.length === 0 | **High** |
| List container | `main table` or `main [role="table"]` | — | **Medium** |
| Group header row | `tbody tr:has(td[colspan])` | — | **Medium** — NEEDS VERIFICATION |
| Order row | `tbody tr:not(:has(td[colspan]))` | — | **Medium** — NEEDS VERIFICATION |
| Order link | `td:first-child a[href*="/markets/"]` | getAttribute('href') | **High** |
| Event ticker | from order link href | `href.split('/').filter(Boolean)[3].toUpperCase()` | **High** |
| Side | from order link text | `/Buy\s+(Yes\|No)/i` | **High** |
| Team name | from order link text | text after `/-\s*/` | **High** |
| Limit price | `td:nth-child(4)` | `/^(\d{1,2})[c¢]/i` | **Medium** |
| Contracts | `td:nth-child(3)` | `parseInt` | **Medium** |
| Filled count | `td:nth-child(2)` | `parseInt` | **Medium** |
| Current price | `td:nth-child(5)` | `/^(\d{1,2})[c¢]/i` | **Medium** |
| Cancel button | `td:last-child button` | — | **Medium** |

All positional (`nth-child`) selectors are MEDIUM stability and require confirmation of the column order in DevTools. The link href and link text selectors are HIGH stability because they depend on URL structure and human-readable text, not CSS class names.

---

## 12. Connection to the Existing Extension Architecture

### What stays the same
- Backend API interface: send `{ ticker, team, side }` → receive `{ fair_yes_cents, fair_no_cents }`
- Badge rendering and EV% display logic
- Floating overlay approach for React-tree survivability
- MutationObserver + debounce pattern
- `history.pushState` monkey-patch for navigation detection

### What changes / is new
- Page detection: add `/portfolio?tab=resting` check to the main routing logic
- Scraper: new `extractRestingOrders()` function that iterates table rows instead of reading a single ladder
- Ticker extraction: from href (portfolio) vs from URL path (market page)
- Multiple concurrent backend requests: one per unique event ticker found in the orders list
- Badge anchoring: anchor to Current price column of each row (not to a ladder row)
- No KPI header panel needed: the EV badge is the only injected element per row

### `__NEXT_DATA__` on the Portfolio Page

The `__NEXT_DATA__` shortcut documented for market pages may also work on the portfolio page. On page load, `window.__NEXT_DATA__.props.pageProps` may contain the full list of resting orders as serialized data, which would be more reliable than DOM scraping.

NEEDS VERIFICATION: Navigate to the portfolio page (logged in), open DevTools Console, and run:
```javascript
const d = JSON.parse(document.getElementById('__NEXT_DATA__').textContent);
console.log(JSON.stringify(Object.keys(d.props.pageProps), null, 2));
```
If the pageProps contain order data, the full ticker (with team suffix) may be directly available — bypassing the need to parse link text entirely. This would be a significant reliability improvement.
