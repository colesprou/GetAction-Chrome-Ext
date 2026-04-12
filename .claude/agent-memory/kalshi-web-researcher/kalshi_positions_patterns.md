---
name: Kalshi Portfolio / Positions Tab — DOM Patterns
description: URL, row structure, side encoding differences, EV formula, and extraction strategy for the /portfolio?tab=positions page
type: reference
---

## URL / Routing

- `/portfolio?tab=positions` (INFERRED plural — NEEDS VERIFICATION)
- Same SPA tab-switch behavior as resting orders: pushState, no full reload
- Same auth gating as resting orders

## Key Structural Difference from Resting Orders

The positions tab shows FILLED holdings, not unfilled bids. Critical differences:

1. **No `<input>` for price.** Avg cost basis is static text, not an editable input. Do NOT use `row.querySelectorAll("input")` — will find nothing.
2. **Side encoding is UNKNOWN.** Resting orders always use "Buy Yes - Team" link text. Positions may use Pattern A (separate "Yes"/"No" column), Pattern B (same "Buy Yes" format), or Pattern C (chip/badge). NEEDS VERIFICATION — this is the most important unknwon.
3. **No cancel button column.** Last column is likely P&L or a Close action.
4. **Link href may include team suffix.** Check if href ends in `-sd`, `-col`, etc. If it does, full ticker is extractable from href alone without needing team name.

## EV Formula (different from resting orders)

Resting: `EV = fair_cents - limit_price_cents`
Positions: `EV = fair_cents - avg_cost_cents`

- YES position: `EV = fair.yes_cents - avgCost`
- NO position: `EV = fair.no_cents - avgCost` (where fair.no = 100 - fair.yes)

## Row Detection Strategy

Cannot use resting orders' `/^Buy\s+(Yes|No)\b/i` filter if Pattern A layout.
Use instead: `row.querySelector('a[href*="/markets/kx"]') != null` as the primary row filter.

## Moneyline Filter

Same MONEYLINE_SERIES_RE applies: `/^KX(MLB|NBA|NHL|NFL|NCAAMB|NCAAB|NCAAFB|NCAAF)GAME-/i`

## Critical NEEDS VERIFICATION Items (ordered by impact)

1. `tab` param value: `positions` or `position`?
2. Side encoding: Pattern A / B / C (see research doc section 2.5)
3. Full ticker in href: does it include `-sd` team suffix?
4. Column order: which nth-child is Avg cost?
5. Avg cost format: "38c", "38¢", "$0.38", or "0.38"?
6. Grouping: flat rows or grouped by event?
7. `__NEXT_DATA__` structure: positions data server-side rendered?

## Research Doc

`docs/kalshi_positions_research.md` — full selector maps, extraction plan, and edge cases.
