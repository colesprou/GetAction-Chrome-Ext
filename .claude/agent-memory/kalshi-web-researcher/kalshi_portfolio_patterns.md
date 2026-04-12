---
name: Kalshi Portfolio / Resting Orders Page — DOM Patterns
description: URL routing, DOM structure, ticker extraction, and injection strategy for the /portfolio?tab=resting page
type: reference
---

## URL / Routing

- `/portfolio?tab=resting` — resting (open) orders tab
- `tab` is a query param, not a separate route; switching tabs fires pushState/replaceState
- Other tabs: `?tab=history`, `?tab=positions`, `?tab=overview`
- Auth-gated: must be logged in; unauthenticated shows either a redirect to /login or an in-page auth wall

## Key DOM Observations (INFERRED from screenshot + Kalshi component patterns)

### List Structure
- INFERRED: `<table>` with `<thead>` + `<tbody>`, order rows as `<tr>/<td>`
- NEEDS VERIFICATION: may be `<div role="table">/<div role="row">` instead
- Column order (NEEDS VERIFICATION): Market | Filled | Contracts | Limit price | Current price | Cash | Placed | Exp | Cancel

### Group Headers
- One header row per unique event (e.g., "Colorado vs San Diego")
- INFERRED: `<tr>` with a `<td colspan="9">` containing the event title
- Exclude these when scraping order rows: `tr:not(:has(td[colspan]))`

### Order Rows
- INFERRED: `<tr>` with 9 `<td>` children
- NEEDS VERIFICATION: whether `data-order-id` or `data-testid` attribute exists on rows

## Ticker Extraction from Portfolio Rows

Primary: the Market column link href
```
<a href="/markets/kxmlbgame/professional-baseball-game/kxmlbgame-26apr12...">Buy Yes - San Diego</a>
href.split('/').filter(Boolean)[3].toUpperCase() → event ticker (no team suffix)
```

Team suffix: parse link text: `/Buy\s+(Yes|No)\s*[-–]\s*(.+)/i` → side + team name

Send `{ event_ticker, team, side }` to backend — same interface as market pages.

## Price Format on Portfolio Page

INFERRED from screenshot: "38c" (ASCII lowercase c), NOT "38¢" (Unicode cent sign)
Parse with: `/^(\d{1,2})[c¢]/i` to handle both

NEEDS VERIFICATION: check raw textContent charCodeAt in DevTools

## Badge Injection Strategy

Use floating overlay (same as market-page bid badges) — React will re-render tbody on any order change, wiping injected `<td>` elements.

Anchor point: right edge of Current price cell (td:nth-child(5))
MutationObserver target: main table (subtree: true)
Debounce: 600ms

## EV Direction

- "Buy Yes" at limitCents: EV = fair_yes_cents - limitCents
- "Buy No" at limitCents: EV = fair_no_cents - limitCents (where fair_no = 100 - fair_yes)

## __NEXT_DATA__ Shortcut

NEEDS VERIFICATION: run in DevTools console while logged in:
```javascript
const d = JSON.parse(document.getElementById('__NEXT_DATA__').textContent);
console.log(Object.keys(d.props.pageProps));
```
If pageProps contains order data, full ticker (with team suffix) may be directly available.

## Critical NEEDS VERIFICATION Items

1. Table vs div layout (most important — affects all selectors)
2. Column order (td:nth-child indexes)
3. Price format: "38c" or "38¢"
4. data-order-id or data-testid on rows
5. Group header element type (tr with colspan? div?)
6. Logged-out behavior: redirect vs in-page auth wall
7. Cancel button aria-label text
8. __NEXT_DATA__ pageProps structure on portfolio page
