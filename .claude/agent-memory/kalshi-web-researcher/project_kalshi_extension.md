---
name: Kalshi Sharp FV Chrome Extension — Project Context
description: Overview of the kalshi_chrome project: what it is, what the extension does, and the known scraper bugs being addressed
type: project
---

Building a Chrome extension (`extension/`) that overlays sharp-book fair value and ladder edge highlighting on Kalshi sports market pages. The extension has a working backend (computes fair value per Kalshi ticker from Optic Odds / sharp books), a service worker for proxying requests, and a content script that scrapes the Kalshi DOM.

**Why:** The content script (`extension/src/content/content.js`) is making wrong assumptions about Kalshi's DOM and URL structure. The research document at `docs/kalshi_web_research.md` was written to give the engineer the correct picture before rewriting the scraper.

**Known bugs at the time of research (2026-04-10):**
1. URL parsing grabs `KXMLBGAME` (series code at path index 1) instead of `KXMLBGAME-26APR101420PITCHC` (event ticker at path index 3)
2. Current-side detection uses body.innerText occurrence counting — wrong because both teams appear with equal frequency; fix is to read `aside h2` sidebar heading
3. Orderbook extraction only grabs top Yes/No ask buttons (compact buy buttons), not the full ladder

**Current scope expansion (2026-04-10):**
- Adding a second surface: `/portfolio?tab=resting` (resting orders page)
- Research doc at `docs/kalshi_portfolio_research.md`
- Goal: annotate each resting order row with EV% based on fair value vs. limit price
- Ticker extraction: from link href in each row (segments[3]) + team name from link text
- Badge injection: use floating overlay approach (same as bid badges) to survive React re-renders
- Key unverified items: table vs div layout, exact column order, price format (c vs ¢), data-order-id attribute, __NEXT_DATA__ structure on portfolio page

**How to apply:** When working on the content script, refer to `docs/kalshi_web_research.md` (market pages) and `docs/kalshi_portfolio_research.md` (portfolio/resting orders) for the correct selector maps and extraction logic. The NEEDS VERIFICATION items in those docs must be confirmed with live DevTools before writing final selectors.
