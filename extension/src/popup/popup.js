const $ = (id) => document.getElementById(id);

// =========================================================================
// League + book configuration
// =========================================================================

// All sportsbooks available on Optic Odds, categorized.
const SHARP_BOOKS = ["Pinnacle", "Betcris", "BetOnline", "Circa Sports"];
const RETAIL_BOOKS = ["DraftKings", "FanDuel", "Caesars", "BetMGM", "ESPN BET", "Hard Rock", "Fanatics", "Bovada", "BookMaker", "BetAmapola"];
const EXCHANGE_BOOKS = ["Novig", "Polymarket"];
const ALL_BOOKS = [...SHARP_BOOKS, ...RETAIL_BOOKS, ...EXCHANGE_BOOKS];

// Per-league config.
//   defaults: books checked on first install (the recommended set).
//   available: every book Optic returns for this league (verified live).
//   tag: "sharp" or "retail" — UI label to indicate quality of the default set.
const LEAGUE_BOOKS = {
  MLB: {
    label: "MLB — Baseball",
    tag: "sharp",
    defaults: ["Pinnacle", "Betcris", "BetOnline", "Circa Sports"],
    available: ALL_BOOKS,
  },
  NHL: {
    label: "NHL — Hockey",
    tag: "sharp",
    defaults: ["Pinnacle", "Betcris", "BetOnline", "Circa Sports"],
    available: ALL_BOOKS,
  },
  NBA: {
    label: "NBA — Basketball",
    tag: "retail",
    defaults: ["DraftKings", "FanDuel", "Caesars", "Fanatics"],
    available: ALL_BOOKS,
  },
  NFL: {
    label: "NFL — Football (seasonal)",
    tag: "sharp",
    defaults: ["Pinnacle", "Betcris", "BetOnline", "Circa Sports"],
    available: ALL_BOOKS,
  },
  ATP: {
    label: "ATP — Tennis",
    tag: "sharp",
    defaults: ["Pinnacle", "BetOnline", "Betcris"],
    available: [...SHARP_BOOKS, "DraftKings", "FanDuel", "Caesars", "BetMGM", "Fanatics", "Hard Rock", "Novig"],
  },
  WTA: {
    label: "WTA — Tennis",
    tag: "sharp",
    defaults: ["Pinnacle", "BetOnline", "Betcris"],
    available: [...SHARP_BOOKS, "DraftKings", "FanDuel", "Caesars", "BetMGM", "Fanatics", "Hard Rock", "Novig"],
  },
  ATP_CHALLENGER: {
    label: "ATP Challenger — Tennis",
    tag: "sharp",
    defaults: ["Pinnacle", "BetOnline"],
    available: ["Pinnacle", "BetOnline", "Betcris", "DraftKings", "FanDuel", "Caesars", "Fanatics", "Hard Rock", "Novig"],
  },
  "England - Premier League": {
    label: "EPL — English Premier League",
    tag: "sharp",
    defaults: ["Pinnacle", "BetOnline", "Betcris", "Circa Sports"],
    available: [...SHARP_BOOKS, "DraftKings", "FanDuel", "Caesars", "BetMGM", "ESPN BET", "Hard Rock", "Fanatics", "Bovada", "BookMaker", "Polymarket"],
  },
  "UEFA Champions League": {
    label: "UCL — Champions League",
    tag: "sharp",
    defaults: ["Pinnacle", "BetOnline", "Betcris", "Circa Sports"],
    available: [...SHARP_BOOKS, "DraftKings", "FanDuel", "Caesars", "BetMGM", "ESPN BET", "Hard Rock", "Fanatics", "Bovada", "BookMaker", "Polymarket"],
  },
};

const STORAGE_KEY_BOOKS = "sharpBookPrefs";

// =========================================================================
// Tab switching
// =========================================================================

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    $(`panel-${tab.dataset.panel}`).classList.add("active");
  });
});

// =========================================================================
// Connection panel
// =========================================================================

async function loadConnectionSettings() {
  const stored = await chrome.storage.local.get(["backendUrl", "extensionToken"]);
  $("backendUrl").value = stored.backendUrl || "http://localhost:8000";
  $("extensionToken").value = stored.extensionToken || "dev-local-token";
}

function setStatus(elId, text, cls) {
  const el = $(elId);
  el.textContent = text;
  el.className = "status" + (cls ? " " + cls : "");
}

$("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    backendUrl: $("backendUrl").value.trim(),
    extensionToken: $("extensionToken").value.trim(),
  });
  setStatus("connStatus", "Saved. Reload the Kalshi tab.", "ok");
});

$("ping").addEventListener("click", async () => {
  setStatus("connStatus", "Pinging…");
  const res = await chrome.runtime.sendMessage({
    type: "ping",
    backendUrl: $("backendUrl").value.trim(),
  });
  if (res && res.ok) {
    setStatus("connStatus", `Backend OK — v${res.version}`, "ok");
    $("versionText").textContent = `v${res.version}`;
  } else {
    setStatus("connStatus", `Failed: ${res?.message || res?.code || "unknown"}`, "err");
  }
});

// =========================================================================
// Sharp Books panel
// =========================================================================

async function loadBookPrefs() {
  const stored = await chrome.storage.local.get(STORAGE_KEY_BOOKS);
  return stored[STORAGE_KEY_BOOKS] || {};
}

async function saveBookPrefs(prefs) {
  await chrome.storage.local.set({ [STORAGE_KEY_BOOKS]: prefs });
}

function renderBooksList() {
  loadBookPrefs().then((prefs) => {
    const container = $("leagueBooksList");
    container.innerHTML = "";

    for (const [league, config] of Object.entries(LEAGUE_BOOKS)) {
      // User overrides: if the user has saved a selection for this league,
      // use it. Otherwise, use the defaults.
      const userBooks = prefs[league]; // undefined = use defaults
      const activeBooks = userBooks || config.defaults;

      const section = document.createElement("div");
      section.className = "league-section";

      // Show ALL available books, checking those that are active.
      // Group them: sharp first, then retail, then exchanges.
      const bookCheckboxes = config.available.map((book) => {
        const checked = activeBooks.includes(book);
        const isSharp = SHARP_BOOKS.includes(book);
        const isExchange = EXCHANGE_BOOKS.includes(book);
        const bookClass = isSharp ? "sharp" : isExchange ? "exchange" : "retail";
        return `
          <label class="book-item ${bookClass}">
            <input type="checkbox" value="${book}" ${checked ? "checked" : ""} />
            ${book}
          </label>`;
      }).join("");

      section.innerHTML = `
        <div class="league-header">
          <span class="league-name">${config.label}</span>
          <span class="league-tag ${config.tag}">${config.tag}</span>
        </div>
        <div class="book-list" data-league="${league}">
          ${bookCheckboxes}
        </div>
      `;
      container.appendChild(section);
    }
  });
}

$("saveBooks").addEventListener("click", async () => {
  const prefs = {};
  document.querySelectorAll(".book-list").forEach((list) => {
    const league = list.dataset.league;
    const checked = Array.from(list.querySelectorAll("input:checked")).map(
      (cb) => cb.value,
    );
    // Only store if user changed something from defaults.
    const defaults = LEAGUE_BOOKS[league]?.defaults || [];
    const isDefault = checked.length === defaults.length &&
      defaults.every((b) => checked.includes(b)) &&
      checked.every((b) => defaults.includes(b));
    if (!isDefault) {
      prefs[league] = checked;
    }
  });
  await saveBookPrefs(prefs);
  const count = Object.keys(prefs).length;
  const msg = count > 0
    ? `Saved. ${count} league(s) have custom books. Reload Kalshi tab.`
    : "Saved (all defaults). Reload Kalshi tab.";
  setStatus("booksStatus", msg, "ok");
});

$("resetBooks").addEventListener("click", async () => {
  await saveBookPrefs({});
  renderBooksList();
  setStatus("booksStatus", "Reset to defaults.", "ok");
});

// =========================================================================
// Tools panel
// =========================================================================

$("test").addEventListener("click", async () => {
  const ticker = $("testTicker").value.trim();
  if (!ticker) {
    setStatus("testStatus", "Enter a ticker first", "err");
    return;
  }
  await chrome.storage.local.set({ testTicker: ticker });
  setStatus("testStatus", "Fetching fair value…");
  const res = await chrome.runtime.sendMessage({
    type: "fetchFairValue",
    payload: { ticker },
  });
  const out = $("result");
  out.hidden = false;
  out.textContent = JSON.stringify(res, null, 2);
  if (res?.status === "ok") {
    const f = res.fair;
    setStatus("testStatus", `OK — fair YES ${f.yes_cents}¢ / NO ${f.no_cents}¢`, "ok");
  } else if (res?.status === "unmapped") {
    setStatus("testStatus", `Unmapped: ${res.reason}`, "err");
  } else {
    setStatus("testStatus", `Error: ${res?.message || res?.code || "unknown"}`, "err");
  }
});

$("resetKpi").addEventListener("click", async () => {
  await chrome.storage.local.remove("kpiHeaderState");
  setStatus("testStatus", "KPI reset. Reload the Kalshi tab.", "ok");
});

// =========================================================================
// Init
// =========================================================================

loadConnectionSettings();
renderBooksList();

// Restore last test ticker
chrome.storage.local.get("testTicker").then((stored) => {
  if (stored.testTicker) $("testTicker").value = stored.testTicker;
});
