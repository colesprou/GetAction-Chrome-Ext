---
name: Kalshi URL Structure and Ticker Format Conventions
description: Confirmed URL path structure, ticker format by sport, and how to correctly extract the event ticker from the URL
type: reference
---

## URL Structure

Kalshi market pages: `/markets/<series-slug>/<sport-display-slug>/<event-ticker>`

Path segments (0-indexed after splitting on `/` and filtering empty):
- `segments[0]` = "markets" (literal)
- `segments[1]` = series code lowercase, e.g. "kxmlbgame" — NOT the ticker to extract
- `segments[2]` = human-readable sport slug, e.g. "professional-baseball-game" — decorative
- `segments[3]` = **event ticker lowercase** — THIS is what to extract and uppercase

## Correct Ticker Extraction

```javascript
const segments = window.location.pathname.split('/').filter(Boolean);
const eventTicker = segments[3]?.toUpperCase(); // "KXMLBGAME-26APR101420PITCHC"
```

Do NOT use the current scraper's reverse-scan approach without tightening the regex.
The regex `/^kx[a-z0-9]/i.test(s) && s.length > 4` matches series codes (length 9).
Use instead: `/^kx[a-z]+-\d{2}[a-z]{3}\d{2}/i` (requires hyphen + date digits).

## Ticker Format

`<SERIES>-<YYMONDD><HHMM?><AWAY><HOME>-<OUTCOME>`

Example: `KXMLBGAME-26APR101420PITCHC-CHC`
- KXMLBGAME = MLB moneyline series
- 26APR10 = April 10, 2026
- 1420 = 2:20 PM game time (may be omitted)
- PIT = Pittsburgh Pirates (away)
- CHC = Chicago Cubs (home)
- -CHC = YES side resolves if Cubs win

## Series Prefixes by Sport

- MLB moneyline: KXMLBGAME
- NBA moneyline: KXNBAGAME
- NFL moneyline: KXNFLGAME
- NHL moneyline: KXNHLGAME

Spread and total markets use KXMLBSPREAD, KXMLBTOTAL, etc. — the extension MVP covers only GAME series.

## Optic Odds Relationship

Optic Odds `source_ids.market_id` = full market ticker WITH team suffix (e.g., `KXMLBGAME-26APR101420PITCHC-CHC`). URL contains only the event ticker (no team suffix). The content script sends the event ticker + selected team name to the backend; the backend resolves the full ticker.
