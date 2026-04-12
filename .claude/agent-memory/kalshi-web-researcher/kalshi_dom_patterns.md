---
name: Kalshi DOM Patterns — Stable Selectors and Known Structure
description: Key DOM observations for Kalshi sports market pages — what to use for title, selected team, tabs, and orderbook
type: reference
---

## Framework

Next.js + CSS Modules. CSS class names are HASHED and change on every deploy. Never use class names as primary selectors. Prefer: semantic HTML elements, ARIA attributes, data-testid, structural patterns.

## Key DOM Elements (confidence levels)

### Event Title
- `h1` — one per page, contains "Pittsburgh @ Chicago C"
- Stability: HIGH
- Separator: `@` for away@home, sometimes `vs`

### Active Tab (currently viewing Yes or No)
- `[role="tab"][aria-selected="true"]` — NEEDS VERIFICATION with DevTools
- Text: "Trade Yes" or "Trade No"
- Stability: HIGH if aria-selected is used (standard ARIA pattern)

### Sidebar / Buy Panel Heading (primary selected-team signal)
- `aside h2` — contains "Buy Yes · Pittsburgh"
- Fallback: `aside h3`, `aside [role="heading"]`
- Separator between side and team: middle dot `·` (U+00B7) — NEEDS VERIFICATION
- Stability: HIGH for semantic aside+heading; tag level NEEDS VERIFICATION

### Orderbook Container
- `[data-testid="orderbook"]` — NEEDS VERIFICATION
- Fallback: `[role="table"]` within main
- Do NOT use class-name selectors for this

### Ladder Rows
- `[role="row"]` within orderbook container — NEEDS VERIFICATION
- Split asks from bids by finding the midpoint row (contains "Last NNc" text)
- Asks are rows ABOVE midpoint; bids are BELOW

### Compact Buy Buttons (top of page, NOT the ladder)
- `button[aria-label*="Buy Yes" i]` — NEEDS VERIFICATION
- Text pattern fallback: `btn.innerText` matches `/^Yes\s+\d+¢$/i`
- Use `innerText` not `textContent` in case children are separate spans

## Critical Bug Notes

1. Current scraper's `extractCurrentSide()` counts body.innerText occurrences — WRONG.
   Both teams appear with nearly equal frequency. Use `aside h2` instead.

2. Current scraper's `extractOrderbook()` only finds compact buy buttons.
   Real ladder rows are in a separate table structure, NOT buttons.

## __NEXT_DATA__ Shortcut

```javascript
const d = JSON.parse(document.getElementById('__NEXT_DATA__').textContent);
// Contains full market objects with tickers, team names, prices
// Exact path NEEDS VERIFICATION: likely d.props.pageProps.event.markets
```

Running `Object.keys(d.props.pageProps)` in DevTools console on any market page immediately reveals the shape.
