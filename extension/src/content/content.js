// Kalshi Sharp Fair Value — content script (MV3, no bundler, no ES modules).
// Everything lives in this single IIFE so the manifest can load it directly.
(() => {
  "use strict";

  // ==========================================================================
  // Config
  // ==========================================================================

  const DEFAULT_CONFIG = {
    backendUrl: "http://localhost:8000",
    extensionToken: "dev-local-token",
    pollIntervalMs: 5000,
    mutationDebounceMs: 800,
    requestTimeoutMs: 4000,
  };

  async function loadConfig() {
    try {
      const stored = await chrome.storage.local.get(["backendUrl", "extensionToken"]);
      return {
        ...DEFAULT_CONFIG,
        ...(stored.backendUrl ? { backendUrl: stored.backendUrl } : {}),
        ...(stored.extensionToken ? { extensionToken: stored.extensionToken } : {}),
      };
    } catch {
      return DEFAULT_CONFIG;
    }
  }

  // ==========================================================================
  // API client — routes through the service worker so we're not bound by
  // the Kalshi page's CSP. The service worker owns the config + fetch.
  // ==========================================================================

  async function fetchFairValue(_config, payload) {
    try {
      return await chrome.runtime.sendMessage({ type: "fetchFairValue", payload });
    } catch (err) {
      return { status: "error", code: "sendmessage_failed", message: String(err) };
    }
  }

  // ==========================================================================
  // Scraper — all Kalshi DOM / URL logic lives here.
  // When the overlay shows wrong info, tune the functions in this section.
  // ==========================================================================

  const LOG = (...args) => console.log("[kalshi-sharp-fv]", ...args);

  function extractContext() {
    const ticker = extractTicker();
    if (!ticker) {
      LOG("no ticker found in URL", window.location.pathname);
      return null;
    }

    const eventTitle = extractEventTitle();
    const state = extractMarketState(eventTitle);
    const orderbook = {
      best_ask_yes: state.currentTeamPrices?.yesAsk ?? null,
      best_ask_no: state.currentTeamPrices?.noAsk ?? null,
      best_bid_yes: null,
      best_bid_no: null,
    };

    const ctx = {
      ticker,
      title: eventTitle,
      yes_label: state.currentTeam,
      teams: state.teams,
      teamPrices: state.teamPrices,
      currentTeam: state.currentTeam,
      otherTeam: state.otherTeam,
      currentTab: state.currentTab,
      lastPrice: state.lastPrice,
      asks: state.asks,
      bids: state.bids,
      orderbook,
    };
    LOG("context", ctx);
    return ctx;
  }

  // ---- market state (teams + ladder + current side) ----
  //
  // Strategy: try semantic selectors first (per docs/kalshi_web_research.md),
  // fall back to innerText regex parsing if semantic selectors fail.

  function extractMarketState(eventTitle) {
    const bodyText = document.body?.innerText || "";
    const teams = splitEventTitle(eventTitle || "");

    // -----------------------------------------------------------------
    // Current tab: role=tab[aria-selected=true] → "Trade Yes"/"Trade No".
    // -----------------------------------------------------------------
    let currentTab = null;
    const activeTabEl = document.querySelector('[role="tab"][aria-selected="true"]');
    if (activeTabEl) {
      const t = (activeTabEl.innerText || activeTabEl.textContent || "").toLowerCase();
      if (t.includes("yes")) currentTab = "yes";
      else if (t.includes("no")) currentTab = "no";
      LOG("tab via aria-selected:", currentTab, t);
    }

    // Fallback: parse "Trade (Yes|No) Last NN¢" from innerText.
    const lastMatch = bodyText.match(/Trade\s+(Yes|No)\s+Last\s+(\d+)\s*¢/i);
    if (!currentTab && lastMatch) {
      currentTab = lastMatch[1].toLowerCase();
      LOG("tab via innerText:", currentTab);
    }
    const lastPrice = lastMatch ? parseInt(lastMatch[2], 10) : null;

    // -----------------------------------------------------------------
    // Current team: sidebar heading "Buy Yes · Pittsburgh" / "Buy No · Chicago C".
    //
    // Strategy:
    //  1. Semantic selector on aside (aside h2/h3/[role="heading"])
    //  2. Any element in the page whose innerText matches "Buy Yes · X"
    //     — fallback for when Kalshi's sidebar structure changes
    //  3. Body-wide innerText regex — absolute last resort
    // -----------------------------------------------------------------
    let currentTeam = null;
    let currentSideFromSidebar = null;

    // Shared regex for all three strategies. Accepts middle-dot, bullet,
    // hyphen, or colon as separator.
    const BUY_PATTERN = /Buy\s+(Yes|No)\s*[·•\-:]\s*([A-Za-z][^\n\r]*?)$/im;

    // Strategy 1: semantic selector
    const sidebarHeading =
      document.querySelector("aside h2") ||
      document.querySelector("aside h3") ||
      document.querySelector('aside [role="heading"]');
    if (sidebarHeading) {
      const text = (sidebarHeading.innerText || sidebarHeading.textContent || "").trim();
      const m = text.match(/Buy\s+(Yes|No)\s*[·•\-:]\s*(.+)/i);
      if (m) {
        currentSideFromSidebar = m[1].toLowerCase();
        currentTeam = m[2].trim();
        if (!currentTab) currentTab = currentSideFromSidebar;
        LOG("sidebar heading (aside):", text, "→ team:", currentTeam);
      }
    }

    // Strategy 2: any h2/h3/heading anywhere with the Buy pattern
    if (!currentTeam) {
      const headings = document.querySelectorAll('h2, h3, [role="heading"]');
      for (const h of headings) {
        const text = (h.innerText || h.textContent || "").trim();
        if (text.length > 80) continue;
        const m = text.match(/Buy\s+(Yes|No)\s*[·•\-:]\s*(.+)/i);
        if (m) {
          currentSideFromSidebar = m[1].toLowerCase();
          currentTeam = m[2].trim();
          if (!currentTab) currentTab = currentSideFromSidebar;
          LOG("sidebar heading (heading scan):", text, "→ team:", currentTeam);
          break;
        }
      }
    }

    // Strategy 3: body innerText pattern match — catches cases where the
    // sidebar isn't structured as a heading at all.
    if (!currentTeam) {
      const m = bodyText.match(BUY_PATTERN);
      if (m) {
        currentSideFromSidebar = m[1].toLowerCase();
        currentTeam = m[2].trim();
        if (!currentTab) currentTab = currentSideFromSidebar;
        LOG("sidebar via body innerText:", m[0], "→ team:", currentTeam);
      }
    }

    // -----------------------------------------------------------------
    // Team prices (best Yes/No ask per team).
    //
    // Pattern: market rows look like "TeamName <gap> NN% <gap> Yes NN¢ No NN¢".
    // We REQUIRE a percent sign shortly after the team name so we don't
    // accidentally match:
    //   - the h1 "Arizona vs Philadelphia"  (no percent after "Arizona")
    //   - the spread row "Philadelphia wins by over 1.5 runs  42% ..."
    //     (text between team name and percent is too long — the 30-char gap
    //     cap excludes it)
    //
    // Word boundary (\b) prevents "Philadelphia" from matching "West Philadelphia".
    // -----------------------------------------------------------------
    const teamPrices = {};
    for (const team of teams) {
      const re = new RegExp(
        "\\b" + escapeRe(team) +
          "[\\s\\S]{0,30}?\\d{1,3}\\s*%" +
          "[\\s\\S]{0,80}?Yes\\s+(\\d{1,3})\\s*¢" +
          "[\\s\\S]{0,40}?No\\s+(\\d{1,3})\\s*¢",
        "i",
      );
      const m = bodyText.match(re);
      if (m) {
        teamPrices[team] = {
          yesAsk: parseInt(m[1], 10),
          noAsk: parseInt(m[2], 10),
        };
      } else {
        LOG("team price match failed for:", team);
      }
    }

    // Sanity check: on a binary market, teamA.yesAsk + teamB.yesAsk should
    // be near 100 (sum of complementary probabilities plus the vig). If we
    // picked up the same row for both teams — or grabbed an unrelated market's
    // row — the sum will be ~120+ or two identical prices. Discard in that
    // case to force the empty-teamPrices fallback path.
    if (teams.length === 2) {
      const [a, b] = teams;
      const pa = teamPrices[a];
      const pb = teamPrices[b];
      if (pa && pb) {
        const sumYes = pa.yesAsk + pb.yesAsk;
        const sumNo = pa.noAsk + pb.noAsk;
        const identical = pa.yesAsk === pb.yesAsk && pa.noAsk === pb.noAsk;
        // Accept range 95-115 (wider than pure 100 to handle normal vig).
        const plausible = sumYes >= 95 && sumYes <= 115 && sumNo >= 95 && sumNo <= 115;
        if (identical || !plausible) {
          LOG("team prices failed sanity check, discarding", {
            a, pa, b, pb, sumYes, sumNo, identical,
          });
          delete teamPrices[a];
          delete teamPrices[b];
        }
      }
    }

    // -----------------------------------------------------------------
    // Fallback current-team detection: match "Last NN¢" to team prices.
    // -----------------------------------------------------------------
    if (!currentTeam && lastPrice != null && currentTab) {
      for (const team of teams) {
        const p = teamPrices[team];
        if (!p) continue;
        if (currentTab === "yes" && p.yesAsk === lastPrice) { currentTeam = team; break; }
        if (currentTab === "no" && p.noAsk === lastPrice) { currentTeam = team; break; }
      }
    }

    // If sidebar gave us a truncated/partial name like "Chicago C", match it
    // to the full team name from the title.
    if (currentTeam && teams.length > 0 && !teams.includes(currentTeam)) {
      const needle = currentTeam.toLowerCase();
      const matched = teams.find(
        (t) => t.toLowerCase().startsWith(needle) || needle.startsWith(t.toLowerCase()),
      );
      if (matched) {
        LOG("sidebar team '%s' → full team '%s'", currentTeam, matched);
        currentTeam = matched;
      }
    }

    if (!currentTeam && teams.length > 0) currentTeam = teams[0];
    const otherTeam = teams.find((t) => t !== currentTeam) || null;

    // -----------------------------------------------------------------
    // Ladder: try DOM structure first, fall back to innerText.
    // -----------------------------------------------------------------
    let ladderRows = extractLadderDom();
    if (!ladderRows || ladderRows.length === 0) {
      ladderRows = extractLadderInnerText(bodyText);
    }

    // Dedup (same price+contracts pair may appear multiple times).
    const seen = new Set();
    const dedup = [];
    for (const r of ladderRows) {
      const k = `${r.price}:${r.contracts}`;
      if (seen.has(k)) continue;
      seen.add(k);
      dedup.push(r);
    }

    // Split into asks vs bids using lastPrice as the pivot.
    let asks = [];
    let bids = [];
    if (lastPrice != null && dedup.length > 0) {
      for (const r of dedup) {
        if (r.price >= lastPrice) asks.push(r);
        else bids.push(r);
      }
      asks.sort((a, b) => b.price - a.price); // descending (highest ask at top)
      bids.sort((a, b) => b.price - a.price); // descending (best bid at top)
    }

    LOG("marketState", {
      teams, teamPrices, currentTeam, otherTeam,
      currentTab, lastPrice,
      askCount: asks.length, bidCount: bids.length,
    });

    return {
      teams, teamPrices, currentTeam, otherTeam,
      currentTeamPrices: teamPrices[currentTeam] || null,
      currentTab, lastPrice, asks, bids,
    };
  }

  // ---- ladder: DOM-based extraction ----

  function extractLadderDom() {
    const container =
      document.querySelector('[data-testid="orderbook"]') ||
      document.querySelector('[data-testid="order-book"]') ||
      document.querySelector('[role="table"]');
    if (!container) return null;

    const rows = container.querySelectorAll('[role="row"], tr');
    const out = [];
    for (const row of rows) {
      const cells = row.querySelectorAll('[role="cell"], td, span');
      // Look for a cell whose text is NN¢
      let price = null;
      let contracts = null;
      for (const c of cells) {
        const text = (c.innerText || c.textContent || "").trim();
        if (price == null) {
          const pm = text.match(/^(\d{1,3})\s*¢$/);
          if (pm) {
            const p = parseInt(pm[1], 10);
            if (p >= 1 && p <= 99) { price = p; continue; }
          }
        }
        if (price != null && contracts == null) {
          const cm = text.match(/^([\d,]+)$/);
          if (cm) {
            const c_ = parseInt(cm[1].replace(/,/g, ""), 10);
            if (!isNaN(c_)) { contracts = c_; break; }
          }
        }
      }
      if (price != null && contracts != null) {
        out.push({ price, contracts });
      }
    }
    LOG("ladder via DOM:", out.length, "rows");
    return out;
  }

  // ---- ladder: innerText fallback ----

  function extractLadderInnerText(bodyText) {
    // Rows look like "58¢   355,594    $206.24K" in innerText.
    const ladderRe = /(\d{1,3})\s*¢\s*[\n\t ]+([\d,]+)\s*[\n\t ]+\$[\d.]+[KMB]?/g;
    const rows = [];
    let match;
    while ((match = ladderRe.exec(bodyText)) !== null) {
      const price = parseInt(match[1], 10);
      const contracts = parseInt(match[2].replace(/,/g, ""), 10);
      if (isNaN(price) || price < 1 || price > 99) continue;
      if (isNaN(contracts)) continue;
      rows.push({ price, contracts });
    }
    LOG("ladder via innerText:", rows.length, "rows");
    return rows;
  }

  // ==========================================================================
  // DOM injection — annotate Kalshi's own UI with fair value / EV%
  //
  // Two injection targets:
  //   1. TEAM ROW: next to Kalshi's "Chance %" column, show "fair 61.2%" with
  //      a color-coded delta vs the market %.
  //   2. BID ROWS: next to each bid price in the orderbook ladder, show the
  //      ROI% if a limit buy placed at that price were to get filled.
  // ==========================================================================

  const BID_EV_CLASS = "kalshi-sharp-fv-bid-ev";
  const TEAM_FAIR_CLASS = "kalshi-sharp-fv-team-fair";
  const LADDER_OVERLAY_ID = "kalshi-sharp-fv-ladder-overlay";
  const KPI_HEADER_ID = "kalshi-sharp-fv-kpi-header";
  const KPI_TOGGLE_ID = "kalshi-sharp-fv-toggle";
  const PORTFOLIO_OVERLAY_ID = "kalshi-sharp-fv-portfolio-overlay";
  const PORTFOLIO_BADGE_CLASS = "kalshi-sharp-fv-order-ev";
  const PORTFOLIO_FAIR_CLASS = "kalshi-sharp-fv-order-fair";
  const STYLE_TAG_ID = "kalshi-sharp-fv-injected-styles";
  const BADGE_STYLES = `
    /* Body-level overlay that hosts floating ladder EV badges so they
       survive Kalshi's React re-renders of ladder rows. */
    #${LADDER_OVERLAY_ID} {
      position: fixed;
      top: 0; left: 0;
      width: 0; height: 0;
      pointer-events: none;
      z-index: 2147483640;
    }
    /* EV% badge — positioned fixed relative to viewport */
    .${BID_EV_CLASS} {
      position: fixed;
      transform: translateY(-50%);
      font: 700 13px/1 ui-monospace, Menlo, Consolas, monospace;
      font-variant-numeric: tabular-nums;
      padding: 4px 8px;
      border-radius: 5px;
      pointer-events: none;
      white-space: nowrap;
      letter-spacing: -0.01em;
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35);
    }
    .${BID_EV_CLASS}.pos {
      background: rgba(74, 222, 128, 0.18);
      border: 1px solid rgba(74, 222, 128, 0.5);
      color: #4ade80;
    }
    .${BID_EV_CLASS}.neg {
      background: rgba(248, 113, 113, 0.18);
      border: 1px solid rgba(248, 113, 113, 0.5);
      color: #f87171;
    }
    .${BID_EV_CLASS}.zero {
      background: rgba(107, 114, 128, 0.15);
      border: 1px solid rgba(107, 114, 128, 0.4);
      color: #8a92a0;
    }
    /* Portfolio / resting orders EV badges — slightly smaller than ladder
       badges since rows are denser and we want to squeeze into a tight cell. */
    .${PORTFOLIO_BADGE_CLASS} {
      position: fixed;
      transform: translateY(-50%);
      font: 700 11px/1 ui-monospace, Menlo, Consolas, monospace;
      font-variant-numeric: tabular-nums;
      padding: 3px 7px;
      border-radius: 4px;
      pointer-events: none;
      white-space: nowrap;
      letter-spacing: -0.01em;
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);
      /* Max-int z-index so we always paint on top of Kalshi's stacking
         contexts (table cells, modals, etc.). */
      z-index: 2147483646;
    }
    .${PORTFOLIO_BADGE_CLASS}.pos {
      background: rgba(74, 222, 128, 0.2);
      border: 1px solid rgba(74, 222, 128, 0.55);
      color: #4ade80;
    }
    .${PORTFOLIO_BADGE_CLASS}.neg {
      background: rgba(248, 113, 113, 0.2);
      border: 1px solid rgba(248, 113, 113, 0.55);
      color: #f87171;
    }
    .${PORTFOLIO_BADGE_CLASS}.zero {
      background: rgba(107, 114, 128, 0.15);
      border: 1px solid rgba(107, 114, 128, 0.4);
      color: #8a92a0;
    }
    /* Fair price label — orange, sits to the LEFT of the EV pill */
    /* Portfolio loading indicator */
    #kalshi-sharp-fv-loading {
      position: fixed;
      bottom: 60px;
      left: 50%;
      transform: translateX(-50%);
      background: #161a20;
      border: 1px solid #272b33;
      border-radius: 20px;
      padding: 8px 20px;
      color: #8a92a0;
      font: 500 11px/1.4 -apple-system, system-ui, sans-serif;
      z-index: 2147483646;
      display: flex;
      align-items: center;
      gap: 10px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
      transition: opacity 0.3s;
    }
    #kalshi-sharp-fv-loading .spinner {
      width: 14px; height: 14px;
      border: 2px solid #272b33;
      border-top-color: #4ade80;
      border-radius: 50%;
      animation: kalshi-fv-spin 0.8s linear infinite;
    }
    @keyframes kalshi-fv-spin {
      to { transform: rotate(360deg); }
    }

    .${PORTFOLIO_FAIR_CLASS} {
      position: fixed;
      transform: translateY(-50%);
      font: 700 11px/1 ui-monospace, Menlo, Consolas, monospace;
      font-variant-numeric: tabular-nums;
      padding: 3px 7px;
      border-radius: 4px;
      pointer-events: none;
      white-space: nowrap;
      letter-spacing: -0.01em;
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);
      background: rgba(251, 146, 60, 0.18);
      border: 1px solid rgba(251, 146, 60, 0.55);
      color: #fb923c;
      z-index: 2147483646;
    }
    /* Fair % annotation next to each team row's Chance column */
    .${TEAM_FAIR_CLASS} {
      display: inline-block;
      margin-left: 8px;
      font-size: 0.72em;
      font-weight: 500;
      font-variant-numeric: tabular-nums;
      letter-spacing: -0.01em;
      opacity: 0.9;
    }
    .${TEAM_FAIR_CLASS}.pos { color: #4ade80; }
    .${TEAM_FAIR_CLASS}.neg { color: #f87171; }
    .${TEAM_FAIR_CLASS}.zero { color: #8a92a0; }

    /* KPI header — floating card the user can drag and resize. Default
       position hugs the LEFT edge of Kalshi's centered content column (its
       right edge sits ~20px before the title/chart), using max() so it
       gracefully falls back to left:16px on narrow viewports. State is
       persisted so user-chosen positions override the default. */
    #${KPI_HEADER_ID} {
      position: fixed;
      top: 100px;
      left: max(16px, calc(50% - 630px));
      width: 250px;
      height: 380px;
      min-width: 180px;
      min-height: 160px;
      max-width: calc(100vw - 32px);
      max-height: calc(100vh - 40px);
      overflow: auto;
      resize: both;
      background: linear-gradient(180deg, #10141b 0%, #0b0d11 100%);
      border: 1px solid #272b33;
      border-radius: 10px;
      /* Base font-size — rewritten by JS based on current width.
         All descendant sizes use em so they scale with this. */
      font-size: 10px;
      padding: 1.2em 1.4em;
      color: #e6e8eb;
      font-family: -apple-system, system-ui, "Segoe UI", Roboto, sans-serif;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
      z-index: 2147483639;
    }
    #${KPI_HEADER_ID} .kpi-label {
      display: flex;
      align-items: center;
      gap: 0.6em;
      font-size: 0.9em;
      color: #6b7280;
      text-transform: uppercase;
      letter-spacing: 0.09em;
      margin-bottom: 1em;
      font-weight: 600;
      cursor: move;
      user-select: none;
    }
    #${KPI_HEADER_ID} .kpi-label:hover { color: #8a92a0; }
    #${KPI_HEADER_ID} .kpi-label::before {
      content: "⋮⋮";
      letter-spacing: -0.2em;
      color: #3a3f49;
      font-size: 1.2em;
      margin-right: 0.2em;
    }
    #${KPI_HEADER_ID} .kpi-label .kpi-title {
      flex: 1;
    }
    #${KPI_HEADER_ID} .kpi-close {
      background: transparent;
      border: none;
      color: #6b7280;
      font-size: 1.6em;
      line-height: 1;
      cursor: pointer;
      padding: 0 0.2em;
      margin: -0.4em -0.4em -0.4em 0;
      letter-spacing: 0;
    }
    #${KPI_HEADER_ID} .kpi-close:hover { color: #e6e8eb; }

    /* Floating toggle pill — shown when KPI is hidden */
    #${KPI_TOGGLE_ID} {
      position: fixed;
      bottom: 20px;
      left: 20px;
      padding: 9px 16px 9px 14px;
      background: linear-gradient(180deg, #161a20 0%, #10141b 100%);
      border: 1px solid #272b33;
      border-radius: 24px;
      color: #b8beca;
      font: 600 11px/1 -apple-system, system-ui, "Segoe UI", Roboto, sans-serif;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      cursor: pointer;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
      z-index: 2147483638;
      display: flex;
      align-items: center;
      gap: 8px;
      transition: background 0.15s, color 0.15s, transform 0.15s;
    }
    #${KPI_TOGGLE_ID}::before {
      content: "";
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #4ade80;
      box-shadow: 0 0 6px rgba(74, 222, 128, 0.6);
    }
    #${KPI_TOGGLE_ID}:hover {
      background: linear-gradient(180deg, #1c212a 0%, #161a20 100%);
      color: #e6e8eb;
      transform: translateY(-1px);
    }
    #${KPI_HEADER_ID} .kpi-label .dot {
      width: 5px; height: 5px; border-radius: 50%;
      background: #4ade80;
      box-shadow: 0 0 6px rgba(74, 222, 128, 0.6);
    }
    /* Teams stacked vertically (narrow card). */
    #${KPI_HEADER_ID} .kpi-teams {
      display: flex;
      flex-direction: column;
      gap: 0.8em;
    }
    #${KPI_HEADER_ID} .kpi-team {
      display: flex;
      flex-direction: column;
      gap: 0.2em;
      padding: 0.6em 0.8em;
      background: #0b0d11;
      border: 1px solid #1a1d23;
      border-radius: 0.6em;
    }
    #${KPI_HEADER_ID} .kpi-team-name {
      font-size: 1em;
      font-weight: 600;
      color: #8a92a0;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #${KPI_HEADER_ID} .kpi-team-fair {
      display: flex;
      align-items: baseline;
      gap: 0.8em;
      font-variant-numeric: tabular-nums;
    }
    #${KPI_HEADER_ID} .kpi-team-fair .pct {
      font-size: 2em;
      font-weight: 700;
      color: #e6e8eb;
      letter-spacing: -0.02em;
    }
    #${KPI_HEADER_ID} .kpi-team-fair .amer {
      font-size: 1.1em;
      font-weight: 500;
      color: #8a92a0;
    }
    #${KPI_HEADER_ID} .kpi-market-line {
      display: flex;
      align-items: center;
      gap: 0.6em;
      font-size: 1em;
      color: #8a92a0;
      font-variant-numeric: tabular-nums;
    }
    #${KPI_HEADER_ID} .kpi-market-line .kalshi { color: #b8beca; }
    #${KPI_HEADER_ID} .kpi-market-line .kpi-edge { font-weight: 600; }
    #${KPI_HEADER_ID} .kpi-market-line .kpi-edge.pos { color: #4ade80; }
    #${KPI_HEADER_ID} .kpi-market-line .kpi-edge.neg { color: #f87171; }
    #${KPI_HEADER_ID} .kpi-market-line .kpi-edge.zero { color: #8a92a0; }

    /* Per-book odds table — compact for narrow card */
    #${KPI_HEADER_ID} .kpi-books {
      margin-top: 1em;
      padding-top: 0.8em;
      border-top: 1px solid #20242c;
    }
    #${KPI_HEADER_ID} .kpi-books-head,
    #${KPI_HEADER_ID} .kpi-books-row {
      display: grid;
      grid-template-columns: 1.5fr 1fr 1fr;
      gap: 0.6em;
      align-items: center;
      font-variant-numeric: tabular-nums;
    }
    #${KPI_HEADER_ID} .kpi-books-head {
      font-size: 0.9em;
      color: #6b7280;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 0 0 0.5em;
      border-bottom: 1px solid #1a1d23;
      margin-bottom: 0.3em;
      font-weight: 600;
    }
    #${KPI_HEADER_ID} .kpi-books-head .col-team {
      text-align: right;
      color: #b8beca;
    }
    #${KPI_HEADER_ID} .kpi-books-row {
      font-size: 1.1em;
      padding: 0.2em 0;
    }
    #${KPI_HEADER_ID} .kpi-books-row .col-book {
      color: #b8beca;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-size: 0.95em;
    }
    #${KPI_HEADER_ID} .kpi-books-row .col-odds {
      text-align: right;
      color: #e6e8eb;
      font-weight: 600;
    }
  `;

  function ensureInjectedStyles() {
    if (document.getElementById(STYLE_TAG_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_TAG_ID;
    style.textContent = BADGE_STYLES;
    document.head.appendChild(style);
  }

  // Cache the orderbook container + observer so we don't re-attach on every tick.
  const ladderInjection = {
    container: null,
    observer: null,
    lastFair: null,
    lastTab: null,
    lastLastPrice: null,
  };

  // Body-level floating overlay for bid EV badges. Badges live here, OUTSIDE
  // Kalshi's React tree, so re-renders of ladder rows don't wipe them.
  // Positions are updated via getBoundingClientRect on scroll/resize/mutation.
  const ladderOverlay = {
    overlay: null,           // the body-level container div
    badges: new Map(),       // key: price (int) → badge element
    scrollAttached: false,
    scrollPending: false,
  };

  // A "buy button" is a <button> whose direct text is "Yes NN¢" or "No NN¢".
  // We exclude these from ladder detection — they're team-card compact buttons,
  // not orderbook rows.
  function isBuyButton(btn) {
    if (!btn || btn.tagName !== "BUTTON") return false;
    const t = (btn.innerText || btn.textContent || "").trim();
    return /^(Yes|No)\s+\d{1,3}\s*¢$/i.test(t);
  }

  function insideBuyButton(el) {
    const btn = el.closest && el.closest("button");
    return isBuyButton(btn);
  }

  function findOrderbookContainer() {
    // Strategy 1: semantic data-testid (if Kalshi ever adds one).
    let el = document.querySelector('[data-testid="orderbook"]') ||
             document.querySelector('[data-testid="order-book"]');
    if (el) return el;

    // Strategy 2: ARIA role=table inside main.
    el = document.querySelector('main [role="table"]');
    if (el) return el;

    // Strategy 3: class-name contains "orderbook".
    el = document.querySelector('[class*="orderbook" i]') ||
         document.querySelector('[class*="order-book" i]');
    if (el) return el;

    // Strategy 4: LCA of all NN¢ price leaves that are NOT inside buy buttons.
    // The smallest common ancestor of all ladder prices is the ladder itself.
    const leafElements = collectPriceLeaves(document.body);
    if (leafElements.length < 2) return null;

    const lca = lowestCommonAncestor(leafElements);
    if (lca) return lca;
    return null;
  }

  // Collect all elements whose textContent (trimmed) is exactly "NN¢" and
  // which are NOT descendants of a buy button. Uses the recursive "shallowest
  // match" pattern so a parent like <div><span>65</span>¢</div> is picked
  // instead of any inner span.
  function collectPriceLeaves(root) {
    const out = [];
    function walk(el) {
      if (el.tagName === "BUTTON" && isBuyButton(el)) return;
      const t = (el.textContent || "").trim();
      const m = t.match(/^(\d{1,2})\s*¢$/);
      if (m) {
        const price = parseInt(m[1], 10);
        if (price >= 1 && price <= 99) {
          out.push(el);
          return;
        }
      }
      for (const child of el.children) walk(child);
    }
    walk(root);
    return out;
  }

  // Smallest element that contains every element in `elements`.
  function lowestCommonAncestor(elements) {
    if (!elements.length) return null;
    let ancestor = elements[0];
    while (ancestor) {
      let containsAll = true;
      for (const e of elements) {
        if (!ancestor.contains(e)) { containsAll = false; break; }
      }
      if (containsAll) return ancestor;
      ancestor = ancestor.parentElement;
    }
    return null;
  }

  // Find each ladder row along with its price and side (ask/bid).
  // Returns [{row, price, priceLeaf, side}, ...].
  //
  // Side classification: walks the container in document order, tracking
  // whether we've passed the "Last NN¢" divider element. Rows before the
  // divider are asks; rows after are bids. This correctly handles tight
  // markets where the best bid equals the last-traded price (e.g. the bids
  // section literally starts with the "Last 54¢" row at 54¢).
  //
  // Skips any NN¢ element inside a buy button so "Yes 62¢" / "No 39¢"
  // compact buttons never get treated as rows.
  function findLadderRows(container) {
    const results = new Map(); // Element -> {row, price, priceLeaf, side}
    let passedMidpoint = false;
    // Match "Last 54¢" / "Last 54c" / "last 54¢" etc.
    const LAST_RE = /^last\s+\d{1,2}\s*¢$/i;

    function walk(el) {
      // Short-circuit entire buy-button subtrees.
      if (el.tagName === "BUTTON" && isBuyButton(el)) return;

      const t = (el.textContent || "").trim();

      // Check for the midpoint divider first — it's a leaf-ish element whose
      // trimmed text is exactly "Last NN¢". Once we see it, subsequent rows
      // are bids.
      if (!passedMidpoint && LAST_RE.test(t)) {
        passedMidpoint = true;
        return; // don't recurse into the midpoint element itself
      }

      // Price row: exact "NN¢" text.
      const m = t.match(/^(\d{1,2})\s*¢$/);
      if (m) {
        const price = parseInt(m[1], 10);
        if (price >= 1 && price <= 99) {
          if (!insideBuyButton(el)) {
            const row = findRowAncestor(el, container);
            if (row && !results.has(row)) {
              results.set(row, {
                row,
                price,
                priceLeaf: el,
                side: passedMidpoint ? "bid" : "ask",
              });
            }
          }
          return;
        }
      }
      for (const child of el.children) walk(child);
    }
    walk(container);
    return Array.from(results.values());
  }

  function findRowAncestor(leaf, container) {
    // Walk up until we hit an element whose parent has multiple children with
    // price leaves (i.e., we're the row and our parent is the rows container).
    let current = leaf;
    for (let i = 0; i < 8; i++) {
      const parent = current.parentElement;
      if (!parent || parent === container || parent === document.body) {
        return current;
      }
      const siblings = Array.from(parent.children);
      let siblingsWithPrices = 0;
      for (const sib of siblings) {
        if (sib === current) continue;
        if (/\b\d{1,2}¢\b/.test(sib.textContent || "")) siblingsWithPrices++;
        if (siblingsWithPrices >= 1) break;
      }
      if (siblingsWithPrices >= 1) {
        // `current` is a row; its parent is the rows container.
        return current;
      }
      current = parent;
    }
    return current;
  }

  // -------------------------------------------------------------------------
  // KPI header — a clean summary bar injected near the top of the Kalshi page
  // -------------------------------------------------------------------------

  function injectKpiHeader(ctx, fair, sportsbook) {
    if (!ctx || !fair) return;

    ensureInjectedStyles();

    const current = ctx.currentTeam;
    const other = ctx.otherTeam;
    if (!current || !other) return;

    // Create the KPI element once as a direct child of body — it's
    // position: fixed, so it lives in its own stacking context and doesn't
    // inherit any parent width/overflow constraints from Kalshi's layout.
    let kpi = document.getElementById(KPI_HEADER_ID);
    if (!kpi) {
      kpi = document.createElement("div");
      kpi.id = KPI_HEADER_ID;
      // Hide until saved state is restored (avoid a flash at the default).
      kpi.style.visibility = "hidden";
      document.body.appendChild(kpi);
      restoreKpiState(kpi).finally(() => {
        kpi.style.visibility = "";
      });
      attachKpiInteractions(kpi);
      LOG("KPI header injected into body (draggable, resizable)");
    }

    // Ensure the toggle pill exists (it may be hidden or visible depending
    // on the current visibility state, but the element needs to be present
    // so its click handler is bound).
    ensureKpiToggleButton();

    // Compute values.
    // For two-way markets: yes_prob = currentTeam, no_prob = otherTeam.
    // For three-way (soccer): yes_prob/no_prob are binary complements for
    // whichever side the user is viewing, but home_prob/away_prob/draw_prob
    // give the actual per-outcome fair values which is what we need in the
    // KPI to show all three sides correctly.
    const isThreeWay = !!fair.is_three_way;

    let curFair, otherFair, curAmer, otherAmer;
    if (isThreeWay && fair.home_prob != null && fair.away_prob != null) {
      // Use the explicit home/away probs — NOT the binary complement.
      // The sidebar tells us which team is "current". The event title in
      // Kalshi soccer is "Away vs Home" or "Home vs Away" — but the
      // yes_side from the backend tells us which is which.
      // Since the KPI always fetches with yes_label=currentTeam, yes_side
      // tells us if current=home or current=away.
      const mapping = sportsbook?._mapping || {};
      // Simplification: just use home for first team in title, away for
      // second. The title splits as [team0, team1] where team0 is the
      // current team (per sidebar detection).
      curFair = fair.home_prob * 100;
      otherFair = fair.away_prob * 100;
      // But wait — we need to know which is home and which is away.
      // The backend's yes_side tells us: if yes_side=home, current=home.
      // We don't have yes_side in the JS fair object, but we DO have the
      // raw probs. Since fair.yes_prob = one of {home_prob, away_prob},
      // we can determine the mapping.
      if (Math.abs(fair.yes_prob - fair.home_prob) < 0.001) {
        // current team is home
        curFair = fair.home_prob * 100;
        otherFair = fair.away_prob * 100;
      } else {
        // current team is away
        curFair = fair.away_prob * 100;
        otherFair = fair.home_prob * 100;
      }
      // American odds: recompute from the actual per-outcome probs.
      curAmer = formatAmericanFromProb(curFair / 100);
      otherAmer = formatAmericanFromProb(otherFair / 100);
    } else {
      curFair = fair.yes_prob != null ? fair.yes_prob * 100 : fair.yes_cents;
      otherFair = fair.no_prob != null ? fair.no_prob * 100 : fair.no_cents;
      curAmer = fair.yes_american;
      otherAmer = fair.no_american;
    }

    const curPrices = ctx.teamPrices?.[current] || null;
    const otherPrices = ctx.teamPrices?.[other] || null;
    const curKalshi = curPrices?.yesAsk ?? null;
    const otherKalshi = otherPrices?.yesAsk ?? null;
    const curEdge = curKalshi != null ? curFair - curKalshi : null;
    const otherEdge = otherKalshi != null ? otherFair - otherKalshi : null;

    // Three-way (soccer): draw card + draw column in per-book table.
    const drawFair = fair.draw_prob != null ? fair.draw_prob * 100 : (fair.draw_cents || null);
    const drawAmer = fair.draw_american || null;
    // Find "Tie" or "Draw" in ctx.teamPrices — Kalshi labels it as "Tie".
    const drawPrices = ctx.teamPrices?.["Tie"] || ctx.teamPrices?.["Draw"] || null;
    const drawKalshi = drawPrices?.yesAsk ?? null;
    const drawEdge = (drawKalshi != null && drawFair != null) ? drawFair - drawKalshi : null;

    const perBook = (sportsbook && sportsbook.per_book) || [];

    // Per-book table columns adapt to two-way vs three-way.
    const booksGridCols = isThreeWay
      ? "grid-template-columns: 1.5fr 1fr 1fr 1fr"
      : "grid-template-columns: 1.5fr 1fr 1fr";
    const booksHtml = perBook.length
      ? `<div class="kpi-books">
           <div class="kpi-books-head" style="${booksGridCols}">
             <span>Book</span>
             <span class="col-team">${escapeHtml(truncate(current, 12))}</span>
             <span class="col-team">${escapeHtml(truncate(other, 12))}</span>
             ${isThreeWay ? '<span class="col-team">Draw</span>' : ""}
           </div>
           ${perBook.map((b) => `
             <div class="kpi-books-row" style="${booksGridCols}">
               <span class="col-book">${escapeHtml(b.book)}</span>
               <span class="col-odds">${formatAmerican(b.yes_american)}</span>
               <span class="col-odds">${formatAmerican(b.no_american)}</span>
               ${isThreeWay ? `<span class="col-odds">${formatAmerican(b.draw_american)}</span>` : ""}
             </div>
           `).join("")}
         </div>`
      : "";

    // Draw card for three-way markets.
    const drawCardHtml = isThreeWay && drawFair != null
      ? `<div class="kpi-divider"></div>
         ${kpiTeamCard("Draw", drawFair, drawAmer, drawKalshi, drawEdge)}`
      : "";

    kpi.innerHTML = `
      <div class="kpi-label">
        <span class="dot"></span>
        <span class="kpi-title">SHARP BOOK FAIR</span>
        <button class="kpi-close" type="button" title="Hide">×</button>
      </div>
      <div class="kpi-teams">
        ${kpiTeamCard(current, curFair, curAmer, curKalshi, curEdge)}
        <div class="kpi-divider"></div>
        ${kpiTeamCard(other, otherFair, otherAmer, otherKalshi, otherEdge)}
        ${drawCardHtml}
      </div>
      ${booksHtml}
    `;
  }

  function kpiTeamCard(name, fairPct, fairAmer, kalshi, edge) {
    const edgeCls = edge == null ? "" :
      edge > 0.1 ? "pos" : edge < -0.1 ? "neg" : "zero";
    const marketLine = kalshi != null
      ? `<div class="kpi-market-line">
           <span class="kalshi">Kalshi ${kalshi}¢</span>
           <span class="kpi-edge ${edgeCls}">${formatEdge(edge)}</span>
         </div>`
      : "";
    return `
      <div class="kpi-team">
        <div class="kpi-team-name">${escapeHtml(truncate(name, 22))}</div>
        <div class="kpi-team-fair">
          <span class="pct">${fairPct.toFixed(1)}%</span>
          <span class="amer">${formatAmerican(fairAmer)}</span>
        </div>
        ${marketLine}
      </div>
    `;
  }

  function removeKpiHeader() {
    const el = document.getElementById(KPI_HEADER_ID);
    if (el) el.remove();
    removeKpiToggleButton();
  }

  // -------------------------------------------------------------------------
  // KPI drag + resize + persist
  // -------------------------------------------------------------------------

  const KPI_STATE_KEY = "kpiHeaderState";
  // Bump this when changing defaults — old saved state will be ignored so
  // everyone picks up the new CSS defaults on their next load.
  const KPI_STATE_VERSION = 3;

  function attachKpiInteractions(kpi) {
    // Drag: mousedown anywhere inside .kpi-label starts a drag. Uses event
    // delegation on the KPI element so it survives innerHTML refreshes.
    let dragging = false;
    let startX = 0, startY = 0;
    let startLeft = 0, startTop = 0;

    kpi.addEventListener("mousedown", (e) => {
      const target = e.target;
      // Ignore clicks on interactive children (close button) — they shouldn't
      // start a drag.
      if (target && target.closest && target.closest(".kpi-close")) return;
      const onLabel = target && target.closest && target.closest(".kpi-label");
      if (!onLabel) return;
      e.preventDefault();
      dragging = true;
      const rect = kpi.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      document.body.style.userSelect = "none";
    });

    // Close button — delegated so it survives innerHTML refreshes.
    kpi.addEventListener("click", (e) => {
      const btn = e.target && e.target.closest && e.target.closest(".kpi-close");
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      hideKpi();
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const newLeft = Math.max(0, Math.min(window.innerWidth - 40, startLeft + dx));
      const newTop = Math.max(0, Math.min(window.innerHeight - 40, startTop + dy));
      kpi.style.left = `${newLeft}px`;
      kpi.style.top = `${newTop}px`;
      kpi.style.right = "auto";
      kpi.style.bottom = "auto";
      kpi.style.transform = "none";
    });

    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = "";
      saveKpiState(kpi);
    });

    // Resize: native CSS resize handle doesn't emit events, but a ResizeObserver
    // catches size changes.
    //   1. Immediately rescale root font-size so text grows with the card.
    //   2. Debounced save of position+size to storage.
    let saveTimer = null;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const w = e.contentRect.width;
        updateKpiFontSize(kpi, w);
      }
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => saveKpiState(kpi), 300);
    });
    ro.observe(kpi);
    // Apply initial size in case the ResizeObserver doesn't fire synchronously.
    updateKpiFontSize(kpi, kpi.getBoundingClientRect().width || 280);
  }

  // Map card width → root font-size (px). 280px is the default width and
  // produces a 10px base. Growth is gentle: +1px of font per +80px of width
  // above the default, so doubling width only grows text ~30%.
  function updateKpiFontSize(kpi, width) {
    const BASE_WIDTH = 280;
    const BASE_FONT = 10;
    const SLOPE = 1 / 80;   // +1px font per +80px width
    const MIN = 9;
    const MAX = 18;
    const raw = BASE_FONT + (width - BASE_WIDTH) * SLOPE;
    const clamped = Math.max(MIN, Math.min(raw, MAX));
    kpi.style.fontSize = `${clamped.toFixed(2)}px`;
  }

  async function saveKpiState(kpi) {
    try {
      const rect = kpi.getBoundingClientRect();
      const visible = kpi.style.display !== "none";
      const state = {
        version: KPI_STATE_VERSION,
        left: `${Math.round(rect.left)}px`,
        top: `${Math.round(rect.top)}px`,
        width: `${Math.round(rect.width)}px`,
        height: `${Math.round(rect.height)}px`,
        visible,
      };
      await chrome.storage.local.set({ [KPI_STATE_KEY]: state });
    } catch {
      /* storage unavailable — ignore */
    }
  }

  // Save visibility alone (used by show/hide without touching position/size).
  async function saveKpiVisibility(visible) {
    try {
      const stored = await chrome.storage.local.get(KPI_STATE_KEY);
      const state = (stored && stored[KPI_STATE_KEY]) || { version: KPI_STATE_VERSION };
      state.visible = visible;
      state.version = KPI_STATE_VERSION;
      await chrome.storage.local.set({ [KPI_STATE_KEY]: state });
    } catch {
      /* ignore */
    }
  }

  async function restoreKpiState(kpi) {
    try {
      const stored = await chrome.storage.local.get(KPI_STATE_KEY);
      const state = stored && stored[KPI_STATE_KEY];
      if (!state) {
        // First time ever — default to hidden so user opts in via the toggle.
        kpi.style.display = "none";
        updateKpiToggleVisibility();
        return;
      }
      // Version check — old state formats get ignored so everyone picks up
      // updated CSS defaults after a version bump.
      if (state.version !== KPI_STATE_VERSION) {
        await chrome.storage.local.remove(KPI_STATE_KEY);
        kpi.style.display = "none";
        updateKpiToggleVisibility();
        return;
      }
      if (state.left) kpi.style.left = state.left;
      if (state.top) kpi.style.top = state.top;
      if (state.width) kpi.style.width = state.width;
      if (state.height) kpi.style.height = state.height;
      kpi.style.right = "auto";
      kpi.style.bottom = "auto";
      kpi.style.transform = "none";
      // Default to hidden unless explicitly shown — a user who's never opened
      // it should see the toggle pill, not the full KPI.
      kpi.style.display = state.visible === true ? "" : "none";
      updateKpiToggleVisibility();
    } catch {
      /* ignore */
    }
  }

  // -------------------------------------------------------------------------
  // Show / hide + toggle pill
  // -------------------------------------------------------------------------

  function showKpi() {
    const kpi = document.getElementById(KPI_HEADER_ID);
    if (kpi) kpi.style.display = "";
    saveKpiVisibility(true);
    updateKpiToggleVisibility();
  }

  function hideKpi() {
    const kpi = document.getElementById(KPI_HEADER_ID);
    if (kpi) kpi.style.display = "none";
    saveKpiVisibility(false);
    updateKpiToggleVisibility();
  }

  function ensureKpiToggleButton() {
    let btn = document.getElementById(KPI_TOGGLE_ID);
    if (btn && document.contains(btn)) return btn;

    btn = document.createElement("button");
    btn.id = KPI_TOGGLE_ID;
    btn.type = "button";
    btn.textContent = "Sharp Fair";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      showKpi();
    });
    document.body.appendChild(btn);
    updateKpiToggleVisibility();
    return btn;
  }

  // Show the toggle pill only when the KPI is hidden.
  function updateKpiToggleVisibility() {
    const btn = document.getElementById(KPI_TOGGLE_ID);
    if (!btn) return;
    const kpi = document.getElementById(KPI_HEADER_ID);
    const kpiHidden = !kpi || kpi.style.display === "none";
    btn.style.display = kpiHidden ? "" : "none";
  }

  function removeKpiToggleButton() {
    const btn = document.getElementById(KPI_TOGGLE_ID);
    if (btn) btn.remove();
  }

  function injectLadderBadges(ctx, fair) {
    if (!ctx || !fair) return;

    ensureInjectedStyles();
    ensureLadderOverlay();
    attachLadderHandlers();

    // Inject team-row fair % annotations (both teams).
    injectTeamFairs(ctx, fair);

    // Store fair/tab/lastPrice for callbacks (scroll/observer) that don't
    // have ctx in scope.
    const precYes = fair.yes_prob != null ? fair.yes_prob * 100 : fair.yes_cents;
    const precNo  = fair.no_prob  != null ? fair.no_prob  * 100 : fair.no_cents;
    const tab = ctx.currentTab || "yes";
    ladderInjection.lastFair = tab === "no" ? precNo : precYes;
    ladderInjection.lastTab = tab;
    ladderInjection.lastLastPrice = ctx.lastPrice;

    // (Re-)discover the orderbook container if we don't have one or it's detached.
    if (!ladderInjection.container || !document.contains(ladderInjection.container)) {
      ladderInjection.container = findOrderbookContainer();
      if (ladderInjection.container) {
        LOG("orderbook container:", ladderInjection.container.tagName,
            ladderInjection.container.getAttribute("data-testid") ||
            (ladderInjection.container.className || "").toString().slice(0, 40));
        attachOrderbookObserver();
      }
    }

    if (!ladderInjection.container) {
      LOG("no orderbook container — clearing ladder badges");
      clearLadderOverlayBadges();
      return;
    }

    refreshLadderBadges();
  }

  // Full refresh pass: scan current rows, add/update/remove badges as needed,
  // compute EV%, and position each badge in the body-level overlay.
  //
  // Called from:
  //  - injectLadderBadges (initial render + each refresh cycle)
  //  - scheduleUpdateLadder (scroll, resize, mutation)
  function refreshLadderBadges() {
    if (!ladderInjection.container) return;
    if (ladderInjection.lastFair == null) return;
    if (!ladderOverlay.overlay) return;

    // Sanity check: if the container has been collapsed, hidden, or is
    // otherwise not actually rendering anything visible, drop the cache
    // and clear badges. Prevents transient badges from appearing when the
    // user closes the orderbook panel.
    const container = ladderInjection.container;
    if (!document.contains(container)) {
      clearStaleLadder();
      return;
    }
    const containerRect = container.getBoundingClientRect();
    if (
      containerRect.width === 0 ||
      containerRect.height === 0 ||
      containerRect.bottom < 0 ||
      containerRect.top > window.innerHeight ||
      containerRect.right < 0 ||
      containerRect.left > window.innerWidth
    ) {
      clearStaleLadder();
      return;
    }

    const ladderFair = ladderInjection.lastFair;
    const lastPrice = ladderInjection.lastLastPrice;

    const rows = findLadderRows(container);

    // Only bid rows, sorted by price descending (best bid first). Kalshi
    // renders them highest-first but we don't want to trust DOM order for
    // the slice cap below.
    const bidRows = rows
      .filter((r) => r.side === "bid")
      .sort((a, b) => b.price - a.price);

    // Hard cap on annotated rows. Kalshi keeps more rows in the DOM than it
    // visibly renders (virtualization); capping at the first N best bids
    // keeps badges off rows that aren't visible even if a clip check misses.
    const MAX_BID_BADGES = 8;
    const visibleBids = bidRows.slice(0, MAX_BID_BADGES);

    const activePrices = new Set();
    let bidsAnnotated = 0;
    for (const { price, priceLeaf } of visibleBids) {
      activePrices.add(price);
      const roi = ((ladderFair - price) / price) * 100;
      applyOverlayBadge(price, priceLeaf, roi);
      bidsAnnotated++;
    }

    // Remove badges for prices that no longer exist in the ladder.
    for (const [price, badge] of ladderOverlay.badges) {
      if (!activePrices.has(price)) {
        badge.remove();
        ladderOverlay.badges.delete(price);
      }
    }

    LOG("ladder badges:", bidsAnnotated, "fair", ladderFair.toFixed(1),
        "last", lastPrice);
  }

  // The orderbook container we were tracking has disappeared or collapsed.
  // Wipe all badges, drop caches, detach the mutation observer. The next
  // refresh cycle (driven by the main poll) will attempt to rediscover a
  // valid container via findOrderbookContainer.
  function clearStaleLadder() {
    clearLadderOverlayBadges();
    if (ladderInjection.observer) {
      ladderInjection.observer.disconnect();
      ladderInjection.observer = null;
    }
    ladderInjection.container = null;
  }

  function applyOverlayBadge(price, priceLeaf, roi) {
    let badge = ladderOverlay.badges.get(price);
    if (!badge) {
      badge = document.createElement("span");
      badge.className = BID_EV_CLASS;
      ladderOverlay.overlay.appendChild(badge);
      ladderOverlay.badges.set(price, badge);
    }

    const cls = roi > 0.1 ? "pos" : roi < -0.1 ? "neg" : "zero";
    // Only rewrite className / text when they actually change — prevents
    // repaint flashing during rapid observer-triggered refreshes.
    const nextClassName = `${BID_EV_CLASS} ${cls}`;
    if (badge.className !== nextClassName) badge.className = nextClassName;

    const nextText = (roi > 0 ? "+" : "") + roi.toFixed(1) + "%";
    if (badge.textContent !== nextText) badge.textContent = nextText;

    const rect = priceLeaf.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      if (badge.style.display !== "none") badge.style.display = "none";
      return;
    }

    // Viewport check — catches collapsing/animating rows that land outside
    // the visible viewport entirely.
    if (
      rect.bottom < 0 ||
      rect.top > window.innerHeight ||
      rect.right < 0 ||
      rect.left > window.innerWidth
    ) {
      if (badge.style.display !== "none") badge.style.display = "none";
      return;
    }

    // Container bounds check — require the price cell's vertical center to
    // be inside the orderbook container's own bounding rect. Kalshi renders
    // more rows in the DOM than it visibly displays (no overflow:hidden, so
    // the rows technically have layout positions below the visible ladder,
    // which is why they leak into Spread/Total sections below).
    //
    // The orderbook container's rect describes the visible ladder area.
    // Rows whose center is below the container's bottom edge are DOM-present
    // but visually below the fold — hide their badges.
    const container = ladderInjection.container;
    if (container) {
      const containerRect = container.getBoundingClientRect();
      const centerY = (rect.top + rect.bottom) / 2;
      if (centerY < containerRect.top || centerY > containerRect.bottom) {
        if (badge.style.display !== "none") badge.style.display = "none";
        return;
      }
    }

    // Hit-test at the price cell's center. Catches cases where something
    // else is painted on top of the row (tooltips, modals, etc.).
    const centerX = (rect.left + rect.right) / 2;
    const centerY = (rect.top + rect.bottom) / 2;
    if (!isHitAt(priceLeaf, centerX, centerY)) {
      if (badge.style.display !== "none") badge.style.display = "none";
      return;
    }

    if (badge.style.display === "none") badge.style.display = "";
    badge.style.left = `${rect.right + 6}px`;
    badge.style.top  = `${rect.top + rect.height / 2}px`;
  }

  // True when the element actually paints at the given viewport coordinates.
  // Temporarily hides our ladder overlay div so elementFromPoint doesn't
  // return our own badges.
  function isHitAt(target, x, y) {
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
      return false;
    }
    const overlay = ladderOverlay.overlay;
    const prevPE = overlay ? overlay.style.pointerEvents : null;
    if (overlay) overlay.style.pointerEvents = "none";
    const hit = document.elementFromPoint(x, y);
    if (overlay) overlay.style.pointerEvents = prevPE || "";
    if (!hit) return false;
    // Accept if hit == target, or target contains hit, or hit contains target.
    return hit === target || target.contains(hit) || hit.contains(target);
  }

  // Return the most-restrictive visible rect for the orderbook container.
  // Walks up from the orderbook looking for any ancestor whose overflow hides
  // content and intersects their rects. Returns null if we can't find the
  // container at all.
  function getClipRect() {
    const container = ladderInjection.container;
    if (!container) return null;

    // Start with the container's own visible rect and intersect with any
    // clipping ancestor rects up to the document body.
    let clipRect = container.getBoundingClientRect();
    let el = container.parentElement;
    while (el && el !== document.body) {
      const style = getComputedStyle(el);
      if (style && /auto|scroll|hidden/.test(style.overflowY + style.overflowX)) {
        const r = el.getBoundingClientRect();
        clipRect = {
          top: Math.max(clipRect.top, r.top),
          bottom: Math.min(clipRect.bottom, r.bottom),
          left: Math.max(clipRect.left, r.left),
          right: Math.min(clipRect.right, r.right),
        };
      }
      el = el.parentElement;
    }
    return clipRect;
  }

  function ensureLadderOverlay() {
    if (ladderOverlay.overlay && document.contains(ladderOverlay.overlay)) return;
    const div = document.createElement("div");
    div.id = LADDER_OVERLAY_ID;
    div.setAttribute("aria-hidden", "true");
    document.body.appendChild(div);
    ladderOverlay.overlay = div;
  }

  function attachLadderHandlers() {
    if (ladderOverlay.scrollAttached) return;
    const cb = scheduleUpdateLadder;
    // capture=true so we also catch scrolls inside nested scroll containers
    // (Kalshi has at least one scroll container for the page body).
    window.addEventListener("scroll", cb, { capture: true, passive: true });
    window.addEventListener("resize", cb, { passive: true });
    ladderOverlay.scrollAttached = true;
  }

  function scheduleUpdateLadder() {
    if (ladderOverlay.scrollPending) return;
    ladderOverlay.scrollPending = true;
    requestAnimationFrame(() => {
      ladderOverlay.scrollPending = false;
      refreshLadderBadges();
    });
  }

  function clearLadderOverlayBadges() {
    for (const badge of ladderOverlay.badges.values()) badge.remove();
    ladderOverlay.badges.clear();
  }

  // -------------------------------------------------------------------------
  // Team-row fair %: inject "fair 61.2%" next to Kalshi's "Chance %" column
  // -------------------------------------------------------------------------

  function injectTeamFairs(ctx, fair) {
    if (!ctx) return;
    const current = ctx.currentTeam;
    const other = ctx.otherTeam;
    if (!current || !other) return;

    const isThreeWay = !!fair.is_three_way;

    // For three-way (soccer), use the explicit home/away/draw probs from the
    // backend — NOT the binary yes_prob/no_prob which are complements, not
    // individual team win probabilities.
    let currentFair, otherFair, drawFairInline;
    if (isThreeWay && fair.home_prob != null && fair.away_prob != null) {
      // Determine which team is home vs away by comparing yes_prob to home_prob.
      if (Math.abs(fair.yes_prob - fair.home_prob) < 0.001) {
        currentFair = fair.home_prob * 100;
        otherFair = fair.away_prob * 100;
      } else {
        currentFair = fair.away_prob * 100;
        otherFair = fair.home_prob * 100;
      }
      drawFairInline = fair.draw_prob != null ? fair.draw_prob * 100 : null;
    } else {
      currentFair = fair.yes_prob != null ? fair.yes_prob * 100 : fair.yes_cents;
      otherFair = fair.no_prob != null ? fair.no_prob * 100 : fair.no_cents;
      drawFairInline = null;
    }

    // Include "Tie" and "Draw" in the known team list so three-way soccer
    // markets get their draw row annotated with fair % too.
    const teamsWithDraw = [...(ctx.teams || []), "Tie", "Draw"];
    const teamRows = findTeamRows(teamsWithDraw);
    LOG("moneyline team rows found:", teamRows.length);

    for (const { row, pctLeaf, marketPct, teamName } of teamRows) {
      let teamFair = null;
      const tn = (teamName || "").toLowerCase();
      if (tn === "tie" || tn === "draw") {
        teamFair = drawFairInline;
      } else if (teamName === current) {
        teamFair = currentFair;
      } else if (teamName === other) {
        teamFair = otherFair;
      }
      if (teamFair == null) continue;
      applyTeamFairBadge(pctLeaf, teamFair, marketPct);
    }
  }

  // Find ONLY the moneyline team rows on the page.
  //
  // A moneyline row has:
  //   - the team name IMMEDIATELY followed by the chance percentage
  //     (i.e. "Philadelphia 61%" — not "Philadelphia wins by over 1.5 runs 42%")
  //   - a compact "Yes NN¢" buy button
  //
  // Secondary markets (Spread, Team Totals, F5 Innings, etc.) all contain the
  // team name but with descriptor text between the name and the percent —
  // those get rejected by the "team + percent adjacent" pattern.
  //
  // Returns [{row, pctLeaf, marketPct, teamName}].
  function findTeamRows(knownTeams) {
    const buttons = document.querySelectorAll("button");
    const results = new Map(); // row element -> {row, pctLeaf, marketPct, teamName}
    for (const btn of buttons) {
      const text = (btn.innerText || btn.textContent || "").trim();
      if (!/^Yes\s+\d{1,3}\s*¢$/i.test(text)) continue;

      // Walk up to find the smallest ancestor that contains a % AND both Yes/No buttons.
      let row = btn.parentElement;
      for (let i = 0; i < 8 && row; i++) {
        const rt = row.innerText || row.textContent || "";
        if (/\d{1,3}\s*%/.test(rt) && /Yes\s+\d{1,3}\s*¢/i.test(rt) && /No\s+\d{1,3}\s*¢/i.test(rt)) {
          break;
        }
        row = row.parentElement;
      }
      if (!row || results.has(row)) continue;

      // Strict moneyline check: the row's text must START with "TeamName NN%".
      // This rejects spread/total/team-total rows which have descriptor text
      // between the team name and the percentage.
      const rowText = (row.innerText || row.textContent || "").trim();
      let matchedTeam = null;
      for (const team of knownTeams) {
        const mlPattern = new RegExp(
          "^\\s*" + escapeRe(team) + "\\s+\\d{1,3}\\s*%",
        );
        if (mlPattern.test(rowText)) {
          matchedTeam = team;
          break;
        }
      }
      if (!matchedTeam) continue;

      // Find the % leaf within the row.
      const pctLeaf = findPercentLeafIn(row);
      if (!pctLeaf) continue;

      const pctText = (pctLeaf.textContent || "").trim();
      const m = pctText.match(/^(\d{1,3})\s*%$/);
      if (!m) continue;
      const marketPct = parseInt(m[1], 10);

      results.set(row, { row, pctLeaf, marketPct, teamName: matchedTeam });
    }
    return Array.from(results.values());
  }

  function findPercentLeafIn(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node = walker.nextNode();
    while (node) {
      if (node.children.length === 0) {
        const t = (node.textContent || "").trim();
        // Exact percent leaf (avoid "61% ▲ 2" parent — we want the inner span)
        if (/^\d{1,3}\s*%$/.test(t)) return node;
      }
      node = walker.nextNode();
    }
    return null;
  }

  function applyTeamFairBadge(pctLeaf, teamFair, marketPct) {
    // Reuse existing badge if present (it lives as a child of the pct leaf).
    let badge = pctLeaf.querySelector(`:scope > .${TEAM_FAIR_CLASS}`);
    if (!badge) {
      badge = document.createElement("span");
      badge.className = TEAM_FAIR_CLASS;
      pctLeaf.appendChild(badge);
    }
    const delta = teamFair - marketPct;
    const cls = delta > 0.25 ? "pos" : delta < -0.25 ? "neg" : "zero";
    badge.className = `${TEAM_FAIR_CLASS} ${cls}`;
    badge.textContent = `fair ${teamFair.toFixed(1)}%`;
  }

  function attachOrderbookObserver() {
    if (ladderInjection.observer) ladderInjection.observer.disconnect();
    const container = ladderInjection.container;
    if (!container) return;

    // Badges live OUTSIDE Kalshi's tree now, so we no longer need to filter
    // out "our own" mutations — nothing we do shows up here.
    ladderInjection.observer = new MutationObserver(() => {
      scheduleUpdateLadder();
    });
    ladderInjection.observer.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  function clearLadderBadges() {
    if (ladderInjection.observer) {
      ladderInjection.observer.disconnect();
      ladderInjection.observer = null;
    }
    // Remove all badges from the floating overlay.
    clearLadderOverlayBadges();
    // Team-row fair annotations (these do live inside Kalshi's tree — a single
    // inline span inside the % leaf).
    document.querySelectorAll(`.${TEAM_FAIR_CLASS}`).forEach((el) => el.remove());
    // KPI header.
    removeKpiHeader();
    ladderInjection.container = null;
    ladderInjection.lastFair = null;
    ladderInjection.lastLastPrice = null;
  }

  // ---- ticker ----

  // Tighter pattern: requires kx + letters + "-" + YY + MMM + DD.
  // Example match: kxmlbgame-26apr101420pitchc
  // Non-match:    kxmlbgame (bare series code)
  const EVENT_TICKER_RE = /^kx[a-z]+-\d{2}[a-z]{3}\d{2}/i;

  // Moneyline / match tickers. The portfolio page shows every order type
  // (game moneylines, player props, totals, YRFI/NRFI, etc.) but the backend
  // only knows how to compute fair value for head-to-head win markets.
  //
  // Rule-based (not a whitelist): any ticker that is
  //   KX<LETTERS>GAME-<DATE>...    — team sports moneyline
  //   KX<LETTERS>MATCH-<DATE>...   — tennis / combat / individual
  // is treated as moneyline. This auto-supports any new sport Kalshi adds
  // as long as it follows the GAME/MATCH suffix convention.
  //
  // Explicit blacklist catches known non-moneyline series that would
  // otherwise pass (the suffix convention isn't perfectly enforced by
  // Kalshi — e.g. future player prop series might accidentally collide).
  const MONEYLINE_SERIES_RE =
    /^KX[A-Z]+(GAME|MATCH)-\d{2}[A-Z]{3}\d{2}/i;

  // Known non-moneyline prefixes — reject even if they pass the rule above.
  const NON_MONEYLINE_PREFIXES = [
    "KXMLBHRRBIS",     // Hits + Runs + RBIs
    "KXMLBSO",         // Strikeouts
    "KXMLBTOTAL",      // Game totals (over/under)
    "KXMLBYRFI",       // Yes Run First Inning
    "KXMLBNRFI",       // No Run First Inning
    "KXMLBHITS",       // Player hits
    "KXMLBHR",         // Home runs
    "KXMLBTB",         // Total bases
    "KXMLBPP",         // Player props generic
    "KXNBAPP",         // NBA player props
    "KXNFLPP",         // NFL player props
    "KXNHLPP",         // NHL player props
  ];

  function isMoneylineTicker(ticker) {
    if (!ticker) return false;
    const up = ticker.toUpperCase();
    // Explicit blacklist wins even if the suffix looks like GAME/MATCH.
    for (const prefix of NON_MONEYLINE_PREFIXES) {
      if (up.startsWith(prefix)) return false;
    }
    return MONEYLINE_SERIES_RE.test(up);
  }

  function extractTicker() {
    // Primary: path segment index 3 per research doc §1.1.
    // URL shape: /markets/<series>/<sport-slug>/<event-ticker>
    const segments = window.location.pathname.split("/").filter(Boolean);
    if (segments.length >= 4 && EVENT_TICKER_RE.test(segments[3])) {
      return segments[3].toUpperCase();
    }
    // Fallback: reverse-scan for a segment matching the tighter regex.
    for (let i = segments.length - 1; i >= 0; i--) {
      if (EVENT_TICKER_RE.test(segments[i])) return segments[i].toUpperCase();
    }
    // Loose fallback — anything kx* with reasonable length.
    for (let i = segments.length - 1; i >= 0; i--) {
      const s = segments[i];
      if (/^kx[a-z0-9]/i.test(s) && s.length > 10) return s.toUpperCase();
    }
    // Last-resort: data attribute
    const el = document.querySelector("[data-ticker]");
    if (el) return el.getAttribute("data-ticker").toUpperCase();
    return null;
  }

  // ---- event title ----

  function extractEventTitle() {
    // The event title is usually a big h1 like "Pittsburgh vs Chicago C".
    const candidates = ["h1", '[data-testid="market-title"]', '[class*="Title"] h1'];
    for (const sel of candidates) {
      try {
        const el = document.querySelector(sel);
        const text = el?.textContent?.trim();
        if (text && text.length > 2 && text.length < 200) return text;
      } catch {/* noop */}
    }
    return null;
  }

  function splitEventTitle(title) {
    for (const sep of [" vs ", " @ ", " at ", " v "]) {
      const idx = title.toLowerCase().indexOf(sep);
      if (idx >= 0) {
        return [
          title.slice(0, idx).trim(),
          title.slice(idx + sep.length).trim().replace(/[?.!]$/, ""),
        ];
      }
    }
    return [];
  }

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // ==========================================================================
  // Overlay (Shadow DOM, no framework)
  // ==========================================================================

  const OVERLAY_ID = "kalshi-sharp-fv-overlay";

  const STYLES = `
    :host, * { box-sizing: border-box; }
    .root {
      position: fixed; bottom: 20px; right: 20px; width: 280px;
      background: #0f1115; color: #e6e8eb;
      border: 1px solid #272b33; border-radius: 10px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.35);
      font: 12px/1.4 -apple-system, system-ui, "Segoe UI", Roboto, sans-serif;
      z-index: 2147483647; user-select: none; overflow: hidden;
    }
    .header { display: flex; justify-content: space-between; align-items: center;
      padding: 8px 10px; background: #161a20; border-bottom: 1px solid #272b33; cursor: move; }
    .header .title { font-weight: 600; letter-spacing: 0.02em; font-size: 11px; color: #b8beca; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #3a3f49; }
    .dot.ok { background: #4ade80; }
    .dot.amber { background: #fbbf24; }
    .dot.red { background: #f87171; }
    .dot.gray { background: #6b7280; }
    .body { padding: 10px 12px; }
    .row { display: flex; justify-content: space-between; align-items: baseline; padding: 3px 0; }
    .label { color: #8a92a0; font-size: 11px; }
    .val { font-variant-numeric: tabular-nums; font-weight: 600; }
    .val.pos { color: #4ade80; }
    .val.neg { color: #f87171; }
    .sep { height: 1px; background: #20242c; margin: 6px 0; }
    .footer { display: flex; justify-content: space-between; align-items: center;
      padding: 6px 10px; border-top: 1px solid #272b33;
      background: #0b0d11; color: #8a92a0; font-size: 10px; }
    .signal { display: inline-block; padding: 2px 6px; border-radius: 4px;
      font-size: 10px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; }
    .signal.playable { background: rgba(74,222,128,0.15); color: #4ade80; }
    .signal.near_fair { background: rgba(156,163,175,0.15); color: #b8beca; }
    .signal.avoid { background: rgba(248,113,113,0.15); color: #f87171; }
    .signal.unknown { background: rgba(107,114,128,0.15); color: #6b7280; }
    .muted { color: #6b7280; font-size: 11px; }
    .books { margin-top: 2px; }
    .book-head, .book-row {
      display: grid; grid-template-columns: 1fr 1.3fr 1.3fr; gap: 4px;
      font-variant-numeric: tabular-nums;
    }
    .book-head { color: #6b7280; font-size: 9px; text-transform: uppercase;
      letter-spacing: 0.04em; padding: 2px 0; border-bottom: 1px solid #1a1d23; }
    .book-head .team { text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .book-head .team.current { color: #93c5fd; }
    .book-row { padding: 2px 0; font-size: 11px; }
    .book-row .name { color: #b8beca; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .book-row .yes, .book-row .no { color: #e6e8eb; text-align: right; }
    .book-row .yes.current { color: #e6e8eb; }

    /* Teams (two side-by-side cards) */
    .teams { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 2px; }
    .team {
      border: 1px solid #1f232b; border-radius: 6px; padding: 6px 8px;
      background: #0b0d11;
    }
    .team.current { border-color: #3b82f6; background: #10141b; }
    .team .name { font-size: 10px; color: #8a92a0; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .team .fair { font-size: 13px; font-weight: 700; color: #e6e8eb; font-variant-numeric: tabular-nums; }
    .team .ask-line { font-size: 10px; color: #8a92a0; margin-top: 2px; font-variant-numeric: tabular-nums; }
    .team .edge { font-weight: 600; }
    .team .edge.pos { color: #4ade80; }
    .team .edge.neg { color: #f87171; }

    .section-label {
      font-size: 10px; color: #6b7280; text-transform: uppercase;
      letter-spacing: 0.05em; margin: 6px 0 2px;
    }

    .root.wide { width: 340px; }
  `;

  function Overlay() {
    let host = document.getElementById(OVERLAY_ID);
    if (host) host.remove();
    host = document.createElement("div");
    host.id = OVERLAY_ID;
    document.documentElement.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = STYLES;
    shadow.appendChild(style);
    const root = document.createElement("div");
    root.className = "root";
    shadow.appendChild(root);

    // Drag
    let dragging = false, ox = 0, oy = 0;
    shadow.addEventListener("mousedown", (e) => {
      const header = e.composedPath().find((n) => n.classList && n.classList.contains("header"));
      if (!header) return;
      dragging = true;
      const rect = root.getBoundingClientRect();
      ox = e.clientX - rect.left;
      oy = e.clientY - rect.top;
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      root.style.left = `${e.clientX - ox}px`;
      root.style.top = `${e.clientY - oy}px`;
      root.style.right = "auto";
      root.style.bottom = "auto";
    });
    window.addEventListener("mouseup", () => { dragging = false; });

    const api = {
      host,
      renderLoading() {
        root.innerHTML = `
          <div class="header"><span class="title">KALSHI SHARP FV</span><span class="dot gray"></span></div>
          <div class="body"><div class="muted">Loading fair value…</div></div>`;
      },
      renderError(msg) {
        root.innerHTML = `
          <div class="header"><span class="title">KALSHI SHARP FV</span><span class="dot red"></span></div>
          <div class="body"><div class="muted">${escapeHtml(msg)}</div></div>`;
      },
      renderUnmapped(reason) {
        root.innerHTML = `
          <div class="header"><span class="title">KALSHI SHARP FV</span><span class="dot amber"></span></div>
          <div class="body">
            <div class="muted">No matched market</div>
            <div class="muted">${escapeHtml(reason || "")}</div>
          </div>`;
      },
      renderFair(data, ctx) {
        const { fair, edge, sportsbook, updated_at, warning, cache } = data;
        const signal = (edge && edge.signal) || "unknown";
        const dotClass =
          signal === "playable" ? "ok" :
          signal === "avoid" ? "red" :
          signal === "near_fair" ? "gray" : "amber";

        const titleText = (ctx && ctx.title) || "Kalshi market";
        const age = cache && cache.hit ? `cached ${Math.round((cache.age_ms || 0) / 1000)}s` : "live";
        const updatedRel = formatRelTime(updated_at);

        // Make the overlay wide enough to fit the two-team row comfortably.
        root.classList.add("wide");

        // Teams block — always show both when we have both teams.
        // fair is computed relative to yes_label == ctx.currentTeam, so:
        //   currentTeam YES = fair.yes_cents
        //   otherTeam   YES = fair.no_cents  (complementary binary market)
        const teamsHtml = renderTeamsBlock(ctx, fair);

        // Inject KPI header near the top of the Kalshi page.
        injectKpiHeader(ctx, fair, sportsbook);

        // Inject edge badges into Kalshi's native orderbook rows.
        injectLadderBadges(ctx, fair);

        // Per-book odds block. Backend returns yes_american/no_american where
        // YES = currentTeam (we pass yes_label to it) and NO = otherTeam.
        // Sportsbooks don't think in Yes/No so we use team names as headers.
        const perBook = (sportsbook && sportsbook.per_book) || [];
        const currentTeamLabel = shortTeamName(ctx?.currentTeam) || "YES";
        const otherTeamLabel = shortTeamName(ctx?.otherTeam) || "NO";
        const booksHtml = perBook.length
          ? `<div class="books">
               <div class="book-head">
                 <span>Book</span>
                 <span class="team current" title="${escapeHtml(ctx?.currentTeam || "")}">${escapeHtml(currentTeamLabel)}</span>
                 <span class="team" title="${escapeHtml(ctx?.otherTeam || "")}">${escapeHtml(otherTeamLabel)}</span>
               </div>
               ${perBook.map((b) => `
                 <div class="book-row">
                   <span class="name">${escapeHtml(b.book)}</span>
                   <span class="yes current">${formatAmerican(b.yes_american)}</span>
                   <span class="no">${formatAmerican(b.no_american)}</span>
                 </div>`).join("")}
             </div>`
          : `<div class="muted">no sharp books</div>`;

        root.innerHTML = `
          <div class="header">
            <span class="title">${escapeHtml(truncate(titleText, 40))}</span>
            <span class="dot ${dotClass}"></span>
          </div>
          <div class="body">
            ${teamsHtml}
            <div class="section-label">Sharp books</div>
            ${booksHtml}
            ${warning ? `<div class="muted" style="margin-top:4px;">⚠ ${escapeHtml(warning)}</div>` : ""}
          </div>
          <div class="footer">
            <span class="signal ${signal}">${signal.replace("_", " ")}</span>
            <span>${updatedRel} · ${age}</span>
          </div>`;
      },
    };

    api.renderLoading();
    return api;
  }

  function renderTeamsBlock(ctx, fair) {
    if (!ctx) return "";
    const teams = ctx.teams || [];
    const current = ctx.currentTeam;
    const other = ctx.otherTeam;
    const isThreeWay = !!fair.is_three_way;

    // For three-way (soccer), use explicit home/away/draw probs.
    // For two-way, use the binary complement as before.
    let curFairYes, curFairNo, otherFairYes, otherFairNo;
    if (isThreeWay && fair.home_prob != null && fair.away_prob != null) {
      // Determine home/away assignment from yes_prob.
      const curIsHome = Math.abs(fair.yes_prob - fair.home_prob) < 0.001;
      const curProb = curIsHome ? fair.home_prob : fair.away_prob;
      const otherProb = curIsHome ? fair.away_prob : fair.home_prob;
      curFairYes = curProb * 100;
      curFairNo = (1 - curProb) * 100;
      otherFairYes = otherProb * 100;
      otherFairNo = (1 - otherProb) * 100;
    } else {
      curFairYes = fair.yes_prob != null ? fair.yes_prob * 100 : fair.yes_cents;
      curFairNo  = fair.no_prob  != null ? fair.no_prob  * 100 : fair.no_cents;
      otherFairYes = curFairNo;
      otherFairNo = curFairYes;
    }

    if (teams.length < 2 || !current || !other) {
      // Fallback: single-side layout if we couldn't identify both teams.
      const yesEdge = ctx.orderbook?.best_ask_yes != null
        ? curFairYes - ctx.orderbook.best_ask_yes : null;
      const noEdge = ctx.orderbook?.best_ask_no != null
        ? curFairNo - ctx.orderbook.best_ask_no : null;
      return `
        <div class="row"><span class="label">Fair YES</span>
          <span class="val">${formatCents(curFairYes)} (${formatAmerican(fair.yes_american)})</span></div>
        <div class="row"><span class="label">Fair NO</span>
          <span class="val">${formatCents(curFairNo)} (${formatAmerican(fair.no_american)})</span></div>
        <div class="row"><span class="label">Ask YES</span>
          <span class="val">${renderAsk(ctx.orderbook?.best_ask_yes)} <span class="${edgeClass(yesEdge)}">${formatEdge(yesEdge)}</span></span></div>
        <div class="row"><span class="label">Ask NO</span>
          <span class="val">${renderAsk(ctx.orderbook?.best_ask_no)} <span class="${edgeClass(noEdge)}">${formatEdge(noEdge)}</span></span></div>
        <div class="sep"></div>
      `;
    }

    const currentPrices = ctx.teamPrices?.[current] || null;
    const otherPrices = ctx.teamPrices?.[other] || null;

    const curAskYes = currentPrices?.yesAsk ?? null;
    const curAskNo = currentPrices?.noAsk ?? null;
    const otherAskYes = otherPrices?.yesAsk ?? null;
    const otherAskNo = otherPrices?.noAsk ?? null;

    // Edges computed against precise fair (one decimal precision).
    const curEdgeYes = curAskYes != null ? curFairYes - curAskYes : null;
    const curEdgeNo  = curAskNo  != null ? curFairNo  - curAskNo  : null;
    const otherEdgeYes = otherAskYes != null ? otherFairYes - otherAskYes : null;
    const otherEdgeNo  = otherAskNo  != null ? otherFairNo  - otherAskNo  : null;

    const teamCard = (name, fairYes, fairNo, askYes, askNo, edgeYes, edgeNo, isCurrent) => `
      <div class="team ${isCurrent ? "current" : ""}">
        <div class="name">${escapeHtml(truncate(name, 16))}</div>
        <div class="fair">${formatCents(fairYes)} <span style="color:#6b7280;font-weight:400;">/ ${formatCents(fairNo)}</span></div>
        <div class="ask-line">
          Y ${renderAsk(askYes)} <span class="edge ${edgeClass(edgeYes)}">${formatEdge(edgeYes)}</span>
          &nbsp;·&nbsp;
          N ${renderAsk(askNo)} <span class="edge ${edgeClass(edgeNo)}">${formatEdge(edgeNo)}</span>
        </div>
      </div>`;

    return `
      <div class="teams">
        ${teamCard(current, curFairYes, curFairNo, curAskYes, curAskNo, curEdgeYes, curEdgeNo, true)}
        ${teamCard(other, otherFairYes, otherFairNo, otherAskYes, otherAskNo, otherEdgeYes, otherEdgeNo, false)}
      </div>
    `;
  }

  function edgeClass(e) {
    if (e == null || isNaN(e)) return "";
    if (e > 0.1) return "pos-edge pos";
    if (e < -0.1) return "neg-edge neg";
    return "zero-edge";
  }

  // Compress a full team name into a short label that fits a narrow header.
  // "Pittsburgh Pirates" -> "Pirates", "Chicago Cubs" -> "Cubs",
  // "Los Angeles Lakers" -> "Lakers", "Chicago C" -> "Chicago C".
  // Strategy: if the name has multiple words, prefer the last word (mascot).
  // Single-word or already-short stays as-is. Caps at 12 chars.
  function shortTeamName(name) {
    if (!name) return null;
    const trimmed = name.trim();
    if (trimmed.length <= 12) return trimmed;
    const words = trimmed.split(/\s+/);
    if (words.length >= 2) {
      const last = words[words.length - 1];
      if (last.length >= 3) return last.slice(0, 12);
    }
    return trimmed.slice(0, 11) + "…";
  }

  function escapeHtml(s) {
    if (s == null) return "";
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function truncate(s, n) { return !s ? "" : s.length > n ? s.slice(0, n - 1) + "…" : s; }
  function formatAmerican(odds) {
    if (odds == null) return "";
    const r = Math.round(odds);
    return r > 0 ? `+${r}` : `${r}`;
  }
  function formatAmericanFromProb(p) {
    if (p == null || p <= 0 || p >= 1) return null;
    if (p >= 0.5) return Math.round(-100 * p / (1 - p));
    return Math.round(100 * (1 - p) / p);
  }
  function formatCents(c) {
    if (c == null || isNaN(c)) return "—";
    return `${c.toFixed(1)}¢`;
  }
  function formatEdge(e) {
    if (e == null || isNaN(e)) return "";
    const r = e.toFixed(1);
    return e > 0 ? `+${r}¢` : `${r}¢`;
  }
  function renderAsk(c) { return c == null ? "—" : `${c}¢`; }
  function formatRelTime(iso) {
    if (!iso) return "";
    const t = new Date(iso).getTime();
    if (isNaN(t)) return "";
    const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
    return secs < 60 ? `${secs}s ago` : `${Math.round(secs / 60)}m ago`;
  }

  // ==========================================================================
  // Portfolio / resting orders page
  //
  // Annotates each resting order with its EV% if the order were to fill at
  // its limit price. Strategy:
  //   1. Parse each order row from the portfolio table (link href → event
  //      ticker, link text → side + team, positional cell → limit price)
  //   2. Batch-resolve unique tickers against the backend
  //      (the backend's served-fair cache handles dedup automatically)
  //   3. Compute EV per row as (fair - limit) / limit * 100
  //   4. Render floating overlay badges positioned next to each row's price
  //      — same pattern as the ladder bid EV badges (out-of-tree, React-safe)
  //
  // Reference: docs/kalshi_portfolio_research.md
  // ==========================================================================

  const portfolioInjection = {
    overlay: null,           // body-level container
    badges: new Map(),       // orderKey → EV pill element
    fairBadges: new Map(),   // orderKey → orange fair label element
    observer: null,
    listContainer: null,
    inflight: false,
    lastFetchAt: 0,
    scrollAttached: false,
    scrollPending: false,
    cache: new Map(),        // ticker → { fairYes, fairNo, timestamp }
  };

  // ---- page detection ----

  function isRestingOrdersPage() {
    if (window.location.pathname !== "/portfolio") return false;
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get("tab") === "resting";
    } catch {
      return false;
    }
  }

  function isPositionsPage() {
    if (window.location.pathname !== "/portfolio") return false;
    try {
      const params = new URLSearchParams(window.location.search);
      const tab = params.get("tab");
      // Positions is the DEFAULT tab — bare /portfolio (no query) is Positions
      // in Kalshi's UI. Explicit ?tab=positions or ?tab=position also maps.
      return tab === null || tab === "" || tab === "positions" || tab === "position";
    } catch {
      return false;
    }
  }

  // True when we're on ANY portfolio tab we can annotate.
  function isPortfolioPage() {
    return isRestingOrdersPage() || isPositionsPage();
  }

  // ---- scraper ----
  //
  // Parses the resting orders list into an array of orders. Each order:
  //   { rowEl, orderKey, ticker, side ("yes"|"no"), team, limitPrice, priceCellEl }
  //
  // `orderKey` is a stable identity we use to dedup badges across re-renders.
  // We derive it from (ticker, side, limit, row index within ticker group).

  function extractRestingOrders() {
    // Container detection: try multiple strategies and log which one hit.
    // Kalshi's portfolio may be <table>, role=table, or even a div grid.
    let container = document.querySelector("main table");
    let containerStrategy = "main table";
    if (!container) {
      container = document.querySelector('main [role="table"]');
      containerStrategy = 'main [role="table"]';
    }
    if (!container) {
      // Last resort — any <table> or role=table on the page.
      container = document.querySelector("table") || document.querySelector('[role="table"]');
      containerStrategy = container ? container.tagName + " (fallback)" : "none";
    }
    if (!container) {
      // Grid-based fallback: find any element whose innerText contains
      // "Buy Yes" or "Buy No" in a grid-looking structure.
      container = findPortfolioContainerByHeuristic();
      containerStrategy = container ? "heuristic" : "none";
    }

    if (!container) {
      LOG("portfolio: NO container found on page. url:", window.location.href);
      return { container: null, orders: [] };
    }

    LOG("portfolio: container via", containerStrategy,
        "→", container.tagName, (container.className || "").toString().slice(0, 50));

    // Candidate rows. Try <tr> first, then role=row, then any element
    // whose innerText begins with "Buy Yes" or "Buy No".
    let rowEls = container.querySelectorAll('tr, [role="row"]');
    if (rowEls.length === 0) {
      // Div-based grid: scan all descendants for rows.
      rowEls = container.querySelectorAll("*");
    }
    LOG("portfolio: scanning", rowEls.length, "candidate row elements");

    const orders = [];
    const seenRows = new Set();
    const keyCounter = new Map(); // base key → count (for deduping duplicate orders)
    let linkFound = 0;
    let linkMissingButBuyText = 0;

    // Build a map from event title text → ticker using __NEXT_DATA__ (the
    // Next.js server-rendered data blob). This is the ONLY reliable source
    // of Kalshi tickers on the portfolio page — there are zero <a> links.
    const titleToTicker = buildTitleToTickerMap();

    // Pre-pass: assign tickers to rows by matching group-header text against
    // the title→ticker map.
    let currentGroupTicker = null;
    let currentGroupTitle = null;
    const groupTickerByIdx = new Map();
    const groupTitleByIdx = new Map();

    rowEls.forEach((row, idx) => {
      const rowText = (row.innerText || row.textContent || "").trim();
      if (/^Buy\s+(Yes|No)\b/i.test(rowText)) {
        groupTickerByIdx.set(idx, currentGroupTicker);
        groupTitleByIdx.set(idx, currentGroupTitle);
        return;
      }
      // Non-order row — store its text as the group title (for resolve-event
      // fallback when there are no links/tickers).
      const headerText = rowText.replace(/\s+/g, " ").trim();
      // Skip the column header row ("Market | Filled | Contracts | ...")
      if (headerText && !/^Market\b/i.test(headerText)) {
        currentGroupTitle = headerText;
      }
      if (headerText && titleToTicker.has(headerText.toLowerCase())) {
        currentGroupTicker = titleToTicker.get(headerText.toLowerCase());
        LOG("group header matched:", headerText, "→", currentGroupTicker);
      }
      groupTickerByIdx.set(idx, currentGroupTicker);
      groupTitleByIdx.set(idx, currentGroupTitle);
    });

    rowEls.forEach((row, idx) => {
      if (seenRows.has(row)) return;

      // Only process order rows (start with "Buy Yes/No").
      const rowText = (row.innerText || row.textContent || "").trim();
      if (!/^Buy\s+(Yes|No)\b/i.test(rowText)) return;

      // --- Ticker ---
      // Strategy 1: direct link in this row (path or query-param based).
      let ticker = null;
      const link =
        row.querySelector('a[href*="/markets/"]') ||
        row.querySelector('a[href*="marketTicker"]') ||
        row.querySelector("a[href]");

      if (link) {
        linkFound++;
        const href = link.getAttribute("href") || "";
        ticker = extractEventTickerFromHref(href);
        if (!ticker) {
          try {
            const url = new URL(href, window.location.origin);
            const mt = url.searchParams.get("marketTicker");
            if (mt && EVENT_TICKER_RE.test(mt)) {
              const parts = mt.toUpperCase().split("-");
              ticker = parts.length > 2 ? parts.slice(0, -1).join("-") : mt.toUpperCase();
            }
          } catch { /* ignore */ }
        }
      }

      // Strategy 2: inherit from the most recent group header.
      if (!ticker) {
        ticker = groupTickerByIdx.get(idx) || null;
        if (ticker) LOG("ticker from group header:", ticker, "row:", rowText.slice(0, 50));
      }

      // --- Side + team from row text ---
      let side = null;
      let team = null;
      const sm = rowText.match(/^Buy\s+(Yes|No)/i);
      if (sm) side = sm[1].toLowerCase();

      const teamMatch = rowText.match(
        /^Buy\s+(?:Yes|No)\s*[·•\-–:]\s*([A-Za-z][^\n\r]*?)(?:\s+\d|$)/,
      );
      if (teamMatch) team = teamMatch[1].trim();

      if (!side) return;
      if (!ticker) linkMissingButBuyText++;

      // Kalshi renders each resting-order row as:
      //   Market | Filled | Contracts | [INPUT: Limit price] | Current price | Cash | ...
      //
      // The row contains THREE <input> elements: Filled (readonly, usually 0),
      // Contracts (usually 10-400), and Limit price. The Limit price is
      // ALWAYS the last input in the row. Picking "first input in [1,99]"
      // gives us Contracts instead of Limit price, producing EVs like +488%.
      //
      // Fix: iterate inputs in REVERSE and take the rightmost valid one.
      // This is the Limit price column by Kalshi's layout convention.

      // --- Limit price via <input value="NN"> (LAST input in the row) ---
      let limitPrice = null;
      let limitInputEl = null;
      const inputs = Array.from(row.querySelectorAll("input"));
      for (let i = inputs.length - 1; i >= 0; i--) {
        const input = inputs[i];
        const raw = input.value != null ? String(input.value).trim() : "";
        let n = NaN;
        if (/^\d{1,2}$/.test(raw)) n = parseInt(raw, 10);
        else if (/^\d{1,2}\s*[c¢]$/i.test(raw)) n = parseInt(raw, 10);
        else if (/^0?\.\d{1,2}$/.test(raw)) n = Math.round(parseFloat(raw) * 100);
        if (!isNaN(n) && n >= 1 && n <= 99) {
          limitPrice = n;
          limitInputEl = input;
          break;
        }
      }

      // Debug: log every resting row's parsed fields so cache-collision /
      // cross-game-bleed bugs are immediately diagnosable from the console.
      const inputValues = inputs.map((inp) => String(inp.value ?? "").trim());
      LOG(
        "resting row:",
        `idx=${idx}`,
        `ticker=${ticker || "(none)"}`,
        `side=${side || "(none)"}`,
        `team=${team || "(none)"}`,
        `inputs=[${inputValues.join(",")}]`,
        `limit=${limitPrice}`,
      );

      // --- Current price cell for badge positioning ---
      // Kalshi shows Current price as plain text "NN¢" in the cell after
      // the limit price input.
      let priceCell = null;
      const leaves = row.querySelectorAll("td, [role=\"cell\"], div, span");
      for (const leaf of leaves) {
        if (leaf.children.length > 2) continue;
        const t = (leaf.textContent || "").trim();
        const m = t.match(/^(\d{1,2})\s*[c¢]$/i);
        if (m) {
          const p = parseInt(m[1], 10);
          if (p >= 1 && p <= 99) {
            priceCell = leaf;
            break;
          }
        }
      }

      if (limitPrice == null || !priceCell) return;

      if (!ticker) {
        // Try to derive ticker from a nearby group header.
        // Walk up looking for the nearest preceding element with a link
        // to /markets/ OR innerText matching "TeamA vs TeamB".
        ticker = deriveTickerFromNearbyHeader(row);
      }
      // If we have a ticker, filter to moneyline only. If we DON'T have a
      // ticker (which is the normal case on the portfolio page — zero links),
      // we rely on /resolve-event and let the backend decide whether the
      // event is a moneyline market.
      if (ticker && !isMoneylineTicker(ticker)) {
        return;
      }
      // If no ticker AND no eventTitle, we can't resolve anything. Skip.
      if (!ticker && !groupTitleByIdx.get(idx)) {
        LOG("portfolio: row has no ticker or title —", rowText.slice(0, 80));
        return;
      }

      const eventTitle = groupTitleByIdx.get(idx) || null;
      seenRows.add(row);
      // Stable order key: uses (ticker/title + team + side + limit) as the
      // base, with a counter suffix to distinguish duplicate orders at the
      // same price. The counter increments in DOM order, which is stable
      // across Kalshi re-renders (rows don't reorder, they just re-render
      // in place), so the key is flicker-free AND duplicate-safe.
      const baseKey = ticker
        ? `${ticker}:${side}:${limitPrice}:${team || ""}`
        : `${eventTitle || "?"}:${team || "?"}:${side}:${limitPrice}`;
      const keyCount = (keyCounter.get(baseKey) || 0) + 1;
      keyCounter.set(baseKey, keyCount);
      const orderKey = keyCount === 1 ? baseKey : `${baseKey}#${keyCount}`;
      orders.push({
        rowEl: row,
        orderKey,
        ticker,
        eventTitle,
        side,
        team,
        limitPrice,
        priceCellEl: priceCell,
      });
    });

    LOG("portfolio: extracted", orders.length, "orders",
        "(link-found:", linkFound, "link-missing:", linkMissingButBuyText, ")");
    return { container, orders };
  }

  // ---- positions scraper ----
  //
  // Positions look similar to resting orders but with key differences:
  //   - No <input> for price — avg cost is static text
  //   - Side is in its own cell ("Yes" / "No"), not in the link text as
  //     "Buy Yes/No - Team"
  //   - EV denominator is avg cost, not limit price (same math though)

  function extractPositions() {
    // Same container cascade as resting orders.
    let container = document.querySelector("main table");
    let containerStrategy = "main table";
    if (!container) {
      container = document.querySelector('main [role="table"]');
      containerStrategy = 'main [role="table"]';
    }
    if (!container) {
      container = document.querySelector("table") || document.querySelector('[role="table"]');
      containerStrategy = container ? container.tagName + " (fallback)" : "none";
    }
    if (!container) {
      container = findPortfolioContainerByHeuristic();
      containerStrategy = container ? "heuristic" : "none";
    }

    if (!container) {
      LOG("positions: NO container found");
      return { container: null, orders: [] };
    }

    LOG("positions: container via", containerStrategy,
        "→", container.tagName, (container.className || "").toString().slice(0, 50));

    let rowEls = container.querySelectorAll('tr, [role="row"]');
    if (rowEls.length === 0) {
      rowEls = container.querySelectorAll("*");
    }

    // Build title→ticker map from __NEXT_DATA__ (same as resting scraper).
    const titleToTicker_pos = buildTitleToTickerMap();

    let currentGroupTicker_pos = null;
    let currentGroupTitle_pos = null;
    const groupTickerByIdx_pos = new Map();
    const groupTitleByIdx_pos = new Map();

    rowEls.forEach((row, idx) => {
      const rowText = (row.innerText || row.textContent || "").trim();
      if (/^Buy\s+(Yes|No)\b/i.test(rowText)) {
        groupTickerByIdx_pos.set(idx, currentGroupTicker_pos);
        groupTitleByIdx_pos.set(idx, currentGroupTitle_pos);
        return;
      }
      const headerText = rowText.replace(/\s+/g, " ").trim();
      if (headerText && !/^Market\b/i.test(headerText)) {
        currentGroupTitle_pos = headerText;
      }
      if (headerText && titleToTicker_pos.has(headerText.toLowerCase())) {
        currentGroupTicker_pos = titleToTicker_pos.get(headerText.toLowerCase());
      }
      groupTickerByIdx_pos.set(idx, currentGroupTicker_pos);
      groupTitleByIdx_pos.set(idx, currentGroupTitle_pos);
    });

    const orders = [];
    const seenRows = new Set();
    const keyCounter_pos = new Map();

    rowEls.forEach((row, idx) => {
      if (seenRows.has(row)) return;

      const rowText = (row.innerText || row.textContent || "").trim();

      // --- Ticker ---
      let ticker = null;
      const link =
        row.querySelector('a[href*="/markets/"]') ||
        row.querySelector('a[href*="marketTicker"]') ||
        row.querySelector("a[href]");
      if (link) {
        const href = link.getAttribute("href") || "";
        ticker = extractEventTickerFromHref(href);
        if (!ticker) {
          try {
            const url = new URL(href, window.location.origin);
            const mt = url.searchParams.get("marketTicker");
            if (mt && EVENT_TICKER_RE.test(mt)) {
              const parts = mt.toUpperCase().split("-");
              ticker = parts.length > 2 ? parts.slice(0, -1).join("-") : mt.toUpperCase();
            }
          } catch { /* ignore */ }
        }
      }
      if (!ticker) ticker = groupTickerByIdx_pos.get(idx) || null;
      if (ticker && !isMoneylineTicker(ticker)) return;
      if (!ticker && !groupTitleByIdx_pos.get(idx)) return;

      // --- Side detection ---
      let side = null;

      // Pattern B: "Buy Yes/No" in row text.
      const buyMatch = rowText.match(/^Buy\s+(Yes|No)/i);
      if (buyMatch) side = buyMatch[1].toLowerCase();

      // Pattern A: a table cell whose trimmed text is exactly "Yes" or "No".
      if (!side) {
        const cells = row.querySelectorAll("td, [role=\"cell\"]");
        for (const cell of cells) {
          const t = (cell.innerText || cell.textContent || "").trim();
          if (/^(Yes|No)$/i.test(t)) {
            side = t.toLowerCase();
            break;
          }
        }
      }

      if (!side) return;

      // --- team name ---
      let team = null;
      // From link text "Buy Yes - Team" or "Buy Yes · Team"
      const teamMatch = linkText.match(/[-–·]\s*(.+?)$/);
      if (teamMatch) team = teamMatch[1].trim();
      // From full row text, if the link doesn't carry it
      if (!team) {
        const rowTeamMatch = rowText.match(
          /^Buy\s+(?:Yes|No)\s*[-–·]\s*([A-Za-z][^\n\r]*?)(?:\s+\d|$)/i,
        );
        if (rowTeamMatch) team = rowTeamMatch[1].trim();
      }

      // --- prices (static text, no <input>) ---
      //
      // Collect EVERY cell whose trimmed text matches /^NN¢$/ or /^NNc$/.
      // Kalshi's positions tab has two price columns: Avg cost and Current
      // price. Per research doc, the FIRST in DOM order is Avg cost. If
      // Kalshi's column order ever flips, changing [0] to [1] below is
      // the only fix needed.
      const priceCandidates = [];
      const cells = row.querySelectorAll("td, [role=\"cell\"]");
      for (const cell of cells) {
        if (cell.contains(link)) continue; // skip the market cell
        const t = (cell.innerText || cell.textContent || "").trim();
        const m = t.match(/^(\d{1,2})\s*[c¢]$/i);
        if (m) {
          const p = parseInt(m[1], 10);
          if (p >= 1 && p <= 99) {
            priceCandidates.push({ el: cell, price: p });
          }
        }
      }

      // Fallback: descendant scan for nested spans.
      if (priceCandidates.length === 0) {
        const leaves = row.querySelectorAll("td, [role=\"cell\"], div, span");
        for (const leaf of leaves) {
          if (leaf.contains(link)) continue;
          if (leaf.children.length > 2) continue;
          const t = (leaf.textContent || "").trim();
          const m = t.match(/^(\d{1,2})\s*[c¢]$/i);
          if (m) {
            const p = parseInt(m[1], 10);
            if (p >= 1 && p <= 99) {
              // Dedup by containment — avoid double-adding a cell and its inner span.
              if (!priceCandidates.some((c) => c.el.contains(leaf) || leaf.contains(c.el))) {
                priceCandidates.push({ el: leaf, price: p });
              }
            }
          }
        }
      }

      if (priceCandidates.length === 0) return;

      // Pick the LEFTMOST price cell by its rendered bounding rect. In
      // Kalshi's column layout, Avg cost appears to the LEFT of Current
      // price, so the leftmost NN¢ cell is always avg cost regardless of
      // DOM ordering quirks (CSS grid can reorder without affecting DOM).
      priceCandidates.sort(
        (a, b) => a.el.getBoundingClientRect().left - b.el.getBoundingClientRect().left,
      );
      const avgCost = priceCandidates[0].price;
      const priceCell = priceCandidates[0].el;

      // Debug log the scraping result for the first 3 rows so the user can
      // diagnose positioning / math issues without guessing.
      if (orders.length < 3) {
        LOG(
          "positions row:",
          `ticker=${ticker}`, `side=${side}`, `team=${team || "(null)"}`,
          `avgCost=${avgCost}¢`,
          `otherPrices=${priceCandidates.slice(1).map((c) => c.price + "¢").join(",")}`,
        );
      }

      const eventTitle = groupTitleByIdx_pos.get(idx) || null;
      seenRows.add(row);
      const baseKey = ticker
        ? `${ticker}:${side}:${avgCost}:${team || ""}:pos`
        : `${eventTitle || "?"}:${team || "?"}:${side}:${avgCost}:pos`;
      const keyCount = (keyCounter_pos.get(baseKey) || 0) + 1;
      keyCounter_pos.set(baseKey, keyCount);
      const orderKey = keyCount === 1 ? baseKey : `${baseKey}#${keyCount}`;
      orders.push({
        rowEl: row,
        orderKey,
        ticker,
        eventTitle,
        side,
        team,
        limitPrice: avgCost,
        priceCellEl: priceCell,
      });
    });

    LOG("positions: extracted", orders.length, "positions");
    return { container, orders };
  }

  async function refreshPositions() {
    if (portfolioInjection.inflight) return;
    const now = Date.now();
    if (now - portfolioInjection.lastFetchAt < 8000) return;
    portfolioInjection.lastFetchAt = now;

    ensureInjectedStyles();
    ensurePortfolioOverlay();
    attachPortfolioHandlers();

    const { container, orders } = extractPositions();
    if (!container) {
      clearPortfolioBadges();
      hidePortfolioLoading();
      return;
    }

    if (container !== portfolioInjection.listContainer) {
      portfolioInjection.listContainer = container;
      attachPortfolioObserver(container);
    }

    if (orders.length === 0) {
      clearPortfolioBadges();
      hidePortfolioLoading();
      return;
    }

    const isFirstLoad = portfolioInjection.cache.size === 0;
    if (isFirstLoad) showPortfolioLoading();

    portfolioInjection.inflight = true;
    try {
      const { results } = await fetchFairsForOrders(orders);
      for (const [key, val] of results) {
        portfolioInjection.cache.set(key, val);
      }
    } finally {
      portfolioInjection.inflight = false;
      hidePortfolioLoading();
    }

    repositionPositionsBadges();
  }

  function repositionPositionsBadges() {
    const { orders } = extractPositions();
    const activeOrderKeys = new Set(orders.map((o) => o.orderKey));

    for (const order of orders) {
      const cacheKey = order.ticker
        ? `ticker:${order.ticker}:${order.team || ""}`
        : `title:${order.eventTitle || ""}:${order.team || ""}`;
      const cached = portfolioInjection.cache.get(cacheKey);
      if (!cached || cached.status !== "ok") continue;

      const fair = order.side === "yes" ? cached.fairYes : cached.fairNo;
      const ev = ((fair - order.limitPrice) / order.limitPrice) * 100;
      applyPortfolioBadge(order.orderKey, order.priceCellEl, ev, order.side, fair);
    }

    for (const [key, badge] of portfolioInjection.badges) {
      if (!activeOrderKeys.has(key)) {
        badge.remove();
        portfolioInjection.badges.delete(key);
      }
    }
    for (const [key, fairEl] of portfolioInjection.fairBadges) {
      if (!activeOrderKeys.has(key)) {
        fairEl.remove();
        portfolioInjection.fairBadges.delete(key);
      }
    }
  }

  // Heuristic fallback — find an ancestor of any "Buy Yes/No" text.
  function findPortfolioContainerByHeuristic() {
    const bodyText = document.body?.innerText || "";
    if (!/\bBuy\s+(Yes|No)\b/i.test(bodyText)) return null;
    // Find the smallest common ancestor of the first 3 "Buy ..." occurrences.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    const matches = [];
    let node = walker.nextNode();
    while (node && matches.length < 3) {
      if (node.children.length === 0) {
        const t = (node.textContent || "").trim();
        if (/^Buy\s+(Yes|No)$/i.test(t) || /^Buy\s+(Yes|No)\b/i.test(t)) {
          matches.push(node);
        }
      }
      node = walker.nextNode();
    }
    if (matches.length < 2) return null;
    // Walk up from the first match until the ancestor contains all matches.
    let ancestor = matches[0].parentElement;
    while (ancestor) {
      if (matches.every((m) => ancestor.contains(m))) return ancestor;
      ancestor = ancestor.parentElement;
    }
    return null;
  }

  // When a row has no direct link, try to derive the ticker from the
  // IMMEDIATELY PRECEDING sibling (the group header row, if one exists).
  //
  // DANGER: the earlier implementation walked backward through siblings
  // until it found ANY link. That caused cross-event bleed on the resting
  // orders page: when a Kalshi group header lacked a link, the walk would
  // keep going and pick up the previous event group's ticker — attaching
  // e.g. the ATP event ticker to NBA order rows. That produced badges
  // showing tennis fair values on basketball orders.
  //
  // The fix: only look at direct previous siblings WHOSE OWN innerText
  // does NOT start with "Buy Yes/No" (i.e. not another order row). As
  // soon as we pass another order row, stop — we're out of our group.
  function deriveTickerFromNearbyHeader(row) {
    let cursor = row.previousElementSibling;
    for (let i = 0; i < 5 && cursor; i++) {
      const cursorText = (cursor.innerText || cursor.textContent || "").trim();
      // If the previous sibling is another order row, we've walked past
      // our group boundary. Stop.
      if (/^Buy\s+(Yes|No)\b/i.test(cursorText)) return null;
      const link = cursor.querySelector?.('a[href*="/markets/"]');
      if (link) {
        const t = extractEventTickerFromHref(link.getAttribute("href") || "");
        if (t) return t;
      }
      cursor = cursor.previousElementSibling;
    }
    return null;
  }

  // Build a map from event title (lowercased) → event-level ticker by
  // parsing Kalshi's __NEXT_DATA__ JSON blob. This is the server-rendered
  // React props object that Next.js injects into every page. It contains
  // the full list of orders/positions including their tickers, event titles,
  // and team names — all the data we can't get from the DOM because Kalshi
  // doesn't use <a> links on the portfolio page.
  //
  // The exact shape of __NEXT_DATA__ is NEEDS VERIFICATION — we search
  // recursively for any object that has both a `ticker` field matching
  // EVENT_TICKER_RE and an `event_title` or `title` or `subtitle` field.
  function buildTitleToTickerMap() {
    const map = new Map(); // lowercased title → event-level ticker
    try {
      const scriptEl = document.getElementById("__NEXT_DATA__");
      if (!scriptEl) {
        LOG("__NEXT_DATA__ not found");
        return map;
      }
      const data = JSON.parse(scriptEl.textContent);
      // Recursively search for ticker + title pairs.
      findTickersRecursive(data, map, 0);
      LOG("__NEXT_DATA__ ticker map:", map.size, "entries",
          Array.from(map.entries()).slice(0, 5).map(([k, v]) => `${k} → ${v}`).join(", "));
    } catch (e) {
      LOG("__NEXT_DATA__ parse error:", String(e));
    }
    return map;
  }

  function findTickersRecursive(obj, map, depth) {
    if (depth > 15 || !obj || typeof obj !== "object") return;

    // If this object has a ticker-like field, try to extract title + ticker.
    if (typeof obj.ticker === "string" && EVENT_TICKER_RE.test(obj.ticker)) {
      const ticker = obj.ticker.toUpperCase();
      // Strip the outcome suffix to get the event-level ticker.
      const parts = ticker.split("-");
      const eventTicker = parts.length > 2 ? parts.slice(0, -1).join("-") : ticker;

      // Try multiple possible title field names.
      for (const key of ["event_title", "title", "subtitle", "yes_sub_title", "no_sub_title", "event"]) {
        const val = obj[key];
        if (typeof val === "string" && val.length > 2 && val.length < 200) {
          const lower = val.replace(/\s+/g, " ").trim().toLowerCase();
          if (!map.has(lower)) {
            map.set(lower, eventTicker);
          }
        }
      }
    }

    // Recurse into arrays and objects.
    if (Array.isArray(obj)) {
      for (const item of obj) findTickersRecursive(item, map, depth + 1);
    } else {
      for (const key of Object.keys(obj)) {
        findTickersRecursive(obj[key], map, depth + 1);
      }
    }
  }

  function extractEventTickerFromHref(href) {
    try {
      // Support absolute and relative URLs.
      const path = href.startsWith("http") ? new URL(href).pathname : href;
      const segments = path.split("/").filter(Boolean);
      // /markets/<series>/<sport-slug>/<event-ticker>
      if (segments.length >= 4 && EVENT_TICKER_RE.test(segments[3])) {
        return segments[3].toUpperCase();
      }
      // Fallback: any segment matching the event ticker pattern.
      for (let i = segments.length - 1; i >= 0; i--) {
        if (EVENT_TICKER_RE.test(segments[i])) return segments[i].toUpperCase();
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  // ---- per-order fair value fetch ----
  //
  // Two strategies:
  //   A) If we have a ticker (from link href or __NEXT_DATA__), use /fair-value.
  //   B) If we only have an event title + team (the portfolio case where
  //      Kalshi has zero links), use /resolve-event which searches all
  //      leagues for a matching fixture by team names.
  //
  // Deduplicates by (title:team) so the same game with 4 orders only hits
  // the backend once.

  async function fetchResolveEvent(payload) {
    try {
      return await chrome.runtime.sendMessage({ type: "resolveEvent", payload });
    } catch (err) {
      return { status: "error", code: "sendmessage_failed", message: String(err) };
    }
  }

  async function fetchFairsForOrders(orders) {
    // Deduplicate by the best key we have. If ticker is present, use it.
    // If not, use title:team (resolve-event path).
    const unique = new Map();
    for (const order of orders) {
      const key = order.ticker
        ? `ticker:${order.ticker}:${order.team || ""}`
        : `title:${order.eventTitle || ""}:${order.team || ""}`;
      if (!unique.has(key)) {
        unique.set(key, {
          ticker: order.ticker,
          team: order.team,
          side: order.side,
          eventTitle: order.eventTitle,
        });
      }
    }

    const results = new Map();
    await Promise.all(
      Array.from(unique.entries()).map(async ([key, { ticker, team, side, eventTitle }]) => {
        let res;
        if (ticker) {
          // Strategy A: direct ticker lookup.
          res = await fetchFairValue(state.config, {
            ticker,
            yes_label: team,
            teams: [],
          });
        } else if (eventTitle && team) {
          // Strategy B: resolve by event title + team name.
          res = await fetchResolveEvent({
            title: eventTitle,
            team,
            side: side || "yes",
          });
        } else {
          res = { status: "error", reason: "no_ticker_no_title" };
        }

        if (res && res.status === "ok" && res.fair) {
          const fairYes = res.fair.yes_prob != null
            ? res.fair.yes_prob * 100
            : res.fair.yes_cents;
          const fairNo = res.fair.no_prob != null
            ? res.fair.no_prob * 100
            : res.fair.no_cents;
          results.set(key, { fairYes, fairNo, status: "ok" });
          LOG("fair fetched:", key, "→", `yes=${fairYes.toFixed(1)}¢`, `no=${fairNo.toFixed(1)}¢`);
        } else {
          results.set(key, {
            status: res?.status || "error",
            reason: res?.reason || res?.message || "unknown",
          });
          LOG("fair FAILED:", key, "→", res?.status || "error", res?.reason || "");
        }
      }),
    );
    return { unique, results };
  }

  // ---- portfolio overlay + badges ----

  // ---- loading indicator ----

  function showPortfolioLoading() {
    let el = document.getElementById("kalshi-sharp-fv-loading");
    if (el) return;
    el = document.createElement("div");
    el.id = "kalshi-sharp-fv-loading";
    el.innerHTML = '<div class="spinner"></div> Loading sharp fair values…';
    document.body.appendChild(el);
  }

  function hidePortfolioLoading() {
    const el = document.getElementById("kalshi-sharp-fv-loading");
    if (el) el.remove();
  }

  // ---- portfolio overlay ----

  function ensurePortfolioOverlay() {
    // We no longer need a wrapping overlay div — each badge is appended
    // directly to document.body with its own z-index: max. This avoids
    // stacking-context inheritance issues where Kalshi's table cells paint
    // on top of elements nested inside our overlay.
    // Keep the field for compatibility with older code paths but treat it
    // as always-present (body is always in document).
    portfolioInjection.overlay = document.body;
  }

  function applyPortfolioBadge(orderKey, priceCellEl, ev, side, fairCents) {
    // Don't create badges for orders with no fair data. This prevents
    // empty green pills on rows where the backend couldn't resolve.
    if (ev == null || isNaN(ev) || fairCents == null || isNaN(fairCents)) return;

    // --- EV pill (right) ---
    let badge = portfolioInjection.badges.get(orderKey);
    if (!badge) {
      badge = document.createElement("span");
      badge.className = PORTFOLIO_BADGE_CLASS;
      document.body.appendChild(badge);
      portfolioInjection.badges.set(orderKey, badge);
    }
    // Store the anchor element so quickRepositionPortfolioBadges can
    // reposition on scroll without re-scraping.
    badge._anchorEl = priceCellEl;
    const cls = ev > 0.1 ? "pos" : ev < -0.1 ? "neg" : "zero";
    const nextClassName = `${PORTFOLIO_BADGE_CLASS} ${cls}`;
    if (badge.className !== nextClassName) badge.className = nextClassName;
    const nextText = (ev > 0 ? "+" : "") + ev.toFixed(1) + "%";
    if (badge.textContent !== nextText) badge.textContent = nextText;

    // --- Fair label (orange, left of EV pill) ---
    let fairEl = portfolioInjection.fairBadges.get(orderKey);
    if (fairCents != null && !isNaN(fairCents)) {
      if (!fairEl) {
        fairEl = document.createElement("span");
        fairEl.className = PORTFOLIO_FAIR_CLASS;
        document.body.appendChild(fairEl);
        portfolioInjection.fairBadges.set(orderKey, fairEl);
      }
      const fairText = `${fairCents.toFixed(1)}¢`;
      if (fairEl.textContent !== fairText) fairEl.textContent = fairText;
    } else if (fairEl) {
      fairEl.remove();
      portfolioInjection.fairBadges.delete(orderKey);
      fairEl = null;
    }

    // --- Visibility + positioning ---
    const rect = priceCellEl.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      if (badge.style.display !== "none") badge.style.display = "none";
      if (fairEl && fairEl.style.display !== "none") fairEl.style.display = "none";
      return;
    }
    if (
      rect.bottom < 0 ||
      rect.top > window.innerHeight ||
      rect.right < 0 ||
      rect.left > window.innerWidth
    ) {
      if (badge.style.display !== "none") badge.style.display = "none";
      if (fairEl && fairEl.style.display !== "none") fairEl.style.display = "none";
      return;
    }

    if (badge.style.display === "none") badge.style.display = "";
    if (fairEl && fairEl.style.display === "none") fairEl.style.display = "";

    // Anchor both badges in the LEFT gutter of the row. Layout order
    // (left → right, in the gutter before the first Kalshi column):
    //   [ fair 54.2¢ ]  [ +3.4% ]  | Buy Yes · Team ...
    //
    // The EV pill's RIGHT edge sits at `rowRect.left - 8` (same as before).
    // The fair label's RIGHT edge sits to the LEFT of the EV pill with a
    // 6px gap. We can't know the EV pill's width before layout, so after
    // positioning it we read its rect and position the fair label relative.
    const row = findRowAncestorForBadge(priceCellEl);
    const rowRect = row ? row.getBoundingClientRect() : rect;
    const verticalCenter = rowRect.top + rowRect.height / 2;

    badge.style.left = `${rowRect.left - 8}px`;
    badge.style.top  = `${verticalCenter}px`;
    badge.style.transform = "translate(-100%, -50%)";

    if (fairEl) {
      // Read the EV pill's rect after positioning to find its left edge.
      // getBoundingClientRect reflects the translate, so we can use it
      // directly to place the fair label just before it.
      const evRect = badge.getBoundingClientRect();
      const fairRight = evRect.left - 6;
      fairEl.style.left = `${fairRight}px`;
      fairEl.style.top  = `${verticalCenter}px`;
      fairEl.style.transform = "translate(-100%, -50%)";
    }
  }

  // Walk up from a cell to find its row (<tr>, role=row, or a flex container).
  function findRowAncestorForBadge(cell) {
    let el = cell;
    for (let i = 0; i < 6 && el; i++) {
      if (el.tagName === "TR") return el;
      if (el.getAttribute && el.getAttribute("role") === "row") return el;
      el = el.parentElement;
    }
    return cell.parentElement || cell;
  }

  function clearPortfolioBadges() {
    for (const badge of portfolioInjection.badges.values()) badge.remove();
    portfolioInjection.badges.clear();
    for (const fairEl of portfolioInjection.fairBadges.values()) fairEl.remove();
    portfolioInjection.fairBadges.clear();
    if (portfolioInjection.observer) {
      portfolioInjection.observer.disconnect();
      portfolioInjection.observer = null;
    }
    portfolioInjection.listContainer = null;
  }

  function attachPortfolioHandlers() {
    if (portfolioInjection.scrollAttached) return;
    // Scroll/resize → immediate rAF reposition (no debounce — visual).
    window.addEventListener("scroll", schedulePortfolioScroll, { capture: true, passive: true });
    window.addEventListener("resize", schedulePortfolioScroll, { passive: true });
    portfolioInjection.scrollAttached = true;
  }

  let portfolioMutationTimer = null;
  let portfolioScrollPending = false;

  // Scroll/resize: reposition immediately via rAF (badges are position:fixed
  // and drift when the user scrolls — can't debounce this).
  function schedulePortfolioScroll() {
    if (portfolioScrollPending) return;
    portfolioScrollPending = true;
    requestAnimationFrame(() => {
      portfolioScrollPending = false;
      quickRepositionPortfolioBadges();
      // After repositioning, check if there are new uncached orders visible.
      // If so, trigger an immediate fetch for them (don't wait for the 8s poll).
      checkForNewOrders();
    });
  }

  // Mutation: debounced (2s) — Kalshi's table re-renders on price ticks.
  function schedulePortfolioUpdate() {
    if (portfolioMutationTimer) return;
    portfolioMutationTimer = setTimeout(() => {
      portfolioMutationTimer = null;
      if (isRestingOrdersPage()) repositionPortfolioBadges();
      else if (isPositionsPage()) repositionPositionsBadges();
    }, 2000);
  }

  // Check if newly-visible rows (from scrolling) have uncached fair values.
  // If so, fire an immediate fetch for just those orders without waiting for
  // the 8-second poll. This makes scrolling down a long list feel instant.
  let newOrderFetchPending = false;
  function checkForNewOrders() {
    if (newOrderFetchPending || portfolioInjection.inflight) return;

    const scraper = isRestingOrdersPage() ? extractRestingOrders
                  : isPositionsPage() ? extractPositions : null;
    if (!scraper) return;

    const { orders } = scraper();
    const uncached = orders.filter((o) => {
      const cacheKey = o.ticker
        ? `ticker:${o.ticker}:${o.team || ""}`
        : `title:${o.eventTitle || ""}:${o.team || ""}`;
      return !portfolioInjection.cache.has(cacheKey);
    });

    if (uncached.length === 0) return;

    LOG("portfolio: found", uncached.length, "uncached orders after scroll, fetching...");
    newOrderFetchPending = true;

    // Fire an immediate fetch for the uncached orders only.
    fetchFairsForOrders(uncached).then(({ results }) => {
      for (const [key, val] of results) {
        portfolioInjection.cache.set(key, val);
      }
      // Reposition to show the new badges.
      if (isRestingOrdersPage()) repositionPortfolioBadges();
      else if (isPositionsPage()) repositionPositionsBadges();
    }).catch(() => {}).finally(() => {
      newOrderFetchPending = false;
    });
  }

  // Ultra-fast reposition: just moves existing badges to match their
  // anchor cells' current viewport positions. No re-scraping, no cache
  // lookups, no network. Called on every scroll frame.
  function quickRepositionPortfolioBadges() {
    for (const [key, badge] of portfolioInjection.badges) {
      const anchor = badge._anchorEl;
      if (!anchor || !document.contains(anchor)) {
        // Anchor gone (row was removed by Kalshi). Hide badge until
        // the next full reposition cleans it up.
        if (badge.style.display !== "none") badge.style.display = "none";
        continue;
      }
      const row = findRowAncestorForBadge(anchor);
      const rowRect = row ? row.getBoundingClientRect() : anchor.getBoundingClientRect();

      // Skip rows that are offscreen or zero-height.
      if (rowRect.height === 0 || rowRect.bottom < 0 || rowRect.top > window.innerHeight) {
        if (badge.style.display !== "none") badge.style.display = "none";
        const fairEl = portfolioInjection.fairBadges.get(key);
        if (fairEl && fairEl.style.display !== "none") fairEl.style.display = "none";
        continue;
      }

      // Skip badges that haven't been fully positioned yet (no left set).
      if (!badge.style.left || badge.style.left === "0px") continue;

      if (badge.style.display === "none") badge.style.display = "";
      const y = rowRect.top + rowRect.height / 2;
      badge.style.top = `${y}px`;

      const fairEl = portfolioInjection.fairBadges.get(key);
      if (fairEl) {
        if (fairEl.style.display === "none") fairEl.style.display = "";
        fairEl.style.top = `${y}px`;
        const evRect = badge.getBoundingClientRect();
        if (evRect.left > 0) {
          fairEl.style.left = `${evRect.left - 6}px`;
        }
      }
    }
  }

  // Lightweight repositioning — reuses the cached fair values from the most
  // recent refresh. Called on scroll/resize/mutation.
  //
  // CRITICAL: does NOT remove badges whose cache entry is missing. A missing
  // cache entry means "we haven't fetched yet" (the async fetch is in-flight),
  // not "this order disappeared." Removing badges during that window causes
  // the visible flicker. Only remove badges whose ORDER ROW is genuinely
  // gone from the page (the row was canceled, filled, or the user navigated).
  function repositionPortfolioBadges() {
    const { orders } = extractRestingOrders();

    // Collect all orderKeys that still have a row on the page.
    const activeOrderKeys = new Set(orders.map((o) => o.orderKey));

    for (const order of orders) {
      const cacheKey = order.ticker
        ? `ticker:${order.ticker}:${order.team || ""}`
        : `title:${order.eventTitle || ""}:${order.team || ""}`;
      const cached = portfolioInjection.cache.get(cacheKey);
      // If cache miss, leave existing badge as-is (don't remove, don't update).
      if (!cached || cached.status !== "ok") continue;

      const fair = order.side === "yes" ? cached.fairYes : cached.fairNo;
      const ev = ((fair - order.limitPrice) / order.limitPrice) * 100;
      applyPortfolioBadge(order.orderKey, order.priceCellEl, ev, order.side, fair);
    }

    // Remove badges ONLY for orders whose rows are no longer on the page.
    for (const [key, badge] of portfolioInjection.badges) {
      if (!activeOrderKeys.has(key)) {
        badge.remove();
        portfolioInjection.badges.delete(key);
      }
    }
    for (const [key, fairEl] of portfolioInjection.fairBadges) {
      if (!activeOrderKeys.has(key)) {
        fairEl.remove();
        portfolioInjection.fairBadges.delete(key);
      }
    }
  }

  function attachPortfolioObserver(container) {
    if (portfolioInjection.observer) portfolioInjection.observer.disconnect();
    portfolioInjection.observer = new MutationObserver(() => {
      schedulePortfolioUpdate();
    });
    portfolioInjection.observer.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  async function refreshPortfolio() {
    if (portfolioInjection.inflight) return;
    const now = Date.now();
    if (now - portfolioInjection.lastFetchAt < 8000) return;
    portfolioInjection.lastFetchAt = now;

    ensureInjectedStyles();
    ensurePortfolioOverlay();
    attachPortfolioHandlers();

    const { container, orders } = extractRestingOrders();
    if (!container) {
      clearPortfolioBadges();
      hidePortfolioLoading();
      return;
    }

    if (container !== portfolioInjection.listContainer) {
      portfolioInjection.listContainer = container;
      attachPortfolioObserver(container);
    }

    if (orders.length === 0) {
      clearPortfolioBadges();
      hidePortfolioLoading();
      return;
    }

    // Show loading indicator on FIRST fetch only (when cache is empty).
    const isFirstLoad = portfolioInjection.cache.size === 0;
    if (isFirstLoad) showPortfolioLoading();

    portfolioInjection.inflight = true;
    try {
      const { results } = await fetchFairsForOrders(orders);
      for (const [key, val] of results) {
        portfolioInjection.cache.set(key, val);
      }
    } finally {
      portfolioInjection.inflight = false;
      hidePortfolioLoading();
    }

    repositionPortfolioBadges();
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  const state = {
    config: null,
    overlay: null,
    lastTicker: null,
    pollTimer: null,
    mutationObserver: null,
    mutationTimer: null,
    inflight: false,
    lastFetchAt: 0,
  };

  function isMarketPage() {
    // Match any /markets/... URL that contains a kx-prefixed ticker segment.
    return /\/kx[a-z0-9]/i.test(window.location.pathname);
  }

  async function refresh() {
    // Dispatch by page type. Each branch is responsible for cleaning up the
    // state owned by the OTHER branches when it takes over.

    // -- Resting orders tab --
    if (isRestingOrdersPage()) {
      if (state.overlay) teardownOverlay();
      ensureInjectedStyles();
      await refreshPortfolio();
      return;
    }

    // -- Positions tab (including bare /portfolio, since Positions is the
    //    default tab in Kalshi's UI) --
    if (isPositionsPage()) {
      if (state.overlay) teardownOverlay();
      ensureInjectedStyles();
      await refreshPositions();
      return;
    }

    // -- Anything that isn't a market page: clean up everything --
    if (!isMarketPage()) {
      teardownOverlay();
      clearPortfolioBadges();
      return;
    }

    // -- Market page path --

    // Entering a market page from the portfolio — wipe any leftover badges.
    if (portfolioInjection.badges.size > 0) clearPortfolioBadges();

    if (state.inflight) return;
    const now = Date.now();
    if (now - state.lastFetchAt < 1000) return;
    state.lastFetchAt = now;

    const ctx = extractContext();
    if (!ctx) {
      if (state.overlay) state.overlay.renderError("Could not read market context");
      return;
    }
    if (!state.overlay) state.overlay = Overlay();
    if (ctx.ticker !== state.lastTicker) {
      state.overlay.renderLoading();
      clearLadderBadges();
      state.lastTicker = ctx.ticker;
    }

    state.inflight = true;
    try {
      const res = await fetchFairValue(state.config, {
        ticker: ctx.ticker,
        title: ctx.title,
        yes_label: ctx.yes_label,
        teams: ctx.teams,
        orderbook: ctx.orderbook,
      });
      // Navigation during the await may have torn down the overlay.
      // Guard every render call against a null state.overlay to prevent the
      // "Cannot read properties of null (reading 'renderFair')" crash.
      if (!state.overlay) return;
      if (!res || res.status === "error") {
        state.overlay.renderError((res && res.message) || "Backend error");
        return;
      }
      if (res.status === "unmapped") {
        state.overlay.renderUnmapped(res.reason);
        return;
      }
      state.overlay.renderFair(res, ctx);
    } finally {
      state.inflight = false;
    }
  }

  function teardownOverlay() {
    if (state.overlay && state.overlay.host) state.overlay.host.remove();
    state.overlay = null;
    state.lastTicker = null;
    clearLadderBadges();
  }

  function watchRouteChanges() {
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = function (...args) { origPush.apply(this, args); setTimeout(refresh, 400); };
    history.replaceState = function (...args) { origReplace.apply(this, args); setTimeout(refresh, 400); };
    window.addEventListener("popstate", () => setTimeout(refresh, 400));
  }

  function watchMutations() {
    if (state.mutationObserver) state.mutationObserver.disconnect();
    state.mutationObserver = new MutationObserver(() => {
      if (state.mutationTimer) clearTimeout(state.mutationTimer);
      state.mutationTimer = setTimeout(refresh, state.config.mutationDebounceMs);
    });
    state.mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  async function boot() {
    state.config = await loadConfig();
    // Boot on both market pages AND the portfolio resting-orders tab. The
    // route-change watcher handles SPA navigation between the two.
    if (!isMarketPage() && !isPortfolioPage()) return;
    if (isMarketPage()) state.overlay = Overlay();
    await refresh();
    state.pollTimer = setInterval(refresh, state.config.pollIntervalMs);
    watchRouteChanges();
    watchMutations();
  }

  boot().catch((e) => console.error("[kalshi-sharp-fv] boot failed", e));
})();
