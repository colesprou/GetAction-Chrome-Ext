const $ = (id) => document.getElementById(id);

// =========================================================================
// League + book configuration
// =========================================================================

// Available books per league. The "default" array is what ships out of the
// box; users can toggle any book on or off. The "tag" indicates sharp vs
// retail for the UI label.
const LEAGUE_BOOKS = {
  MLB: {
    label: "MLB — Baseball",
    tag: "sharp",
    books: ["Pinnacle", "Betcris", "BetOnline", "Circa Sports"],
  },
  NHL: {
    label: "NHL — Hockey",
    tag: "sharp",
    books: ["Pinnacle", "Betcris", "BetOnline", "Circa Sports"],
  },
  NBA: {
    label: "NBA — Basketball",
    tag: "retail",
    books: ["DraftKings", "FanDuel", "Caesars", "Fanatics"],
  },
  NFL: {
    label: "NFL — Football",
    tag: "sharp",
    books: ["Pinnacle", "Betcris", "BetOnline", "Circa Sports"],
  },
  ATP: {
    label: "ATP — Tennis",
    tag: "sharp",
    books: ["Pinnacle", "BetOnline", "Betcris"],
  },
  WTA: {
    label: "WTA — Tennis",
    tag: "sharp",
    books: ["Pinnacle", "BetOnline", "Betcris"],
  },
  ATP_CHALLENGER: {
    label: "ATP Challenger — Tennis",
    tag: "sharp",
    books: ["Pinnacle", "BetOnline"],
  },
  "England - Premier League": {
    label: "EPL — Soccer",
    tag: "sharp",
    books: ["Pinnacle", "BetOnline", "Betcris", "Circa Sports"],
  },
  "UEFA Champions League": {
    label: "UCL — Soccer",
    tag: "sharp",
    books: ["Pinnacle", "BetOnline", "Betcris", "Circa Sports"],
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
      const userBooks = prefs[league]; // undefined = use defaults, array = user overrides
      const section = document.createElement("div");
      section.className = "league-section";

      section.innerHTML = `
        <div class="league-header">
          <span class="league-name">${config.label}</span>
          <span class="league-tag ${config.tag}">${config.tag}</span>
        </div>
        <div class="book-list" data-league="${league}">
          ${config.books.map((book) => {
            const checked = userBooks ? userBooks.includes(book) : true;
            return `
              <label class="book-item">
                <input type="checkbox" value="${book}" ${checked ? "checked" : ""} />
                ${book}
              </label>`;
          }).join("")}
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
    // Only store if user deselected something (otherwise use defaults).
    const defaults = LEAGUE_BOOKS[league]?.books || [];
    const isDefault = checked.length === defaults.length &&
      checked.every((b) => defaults.includes(b));
    if (!isDefault) {
      prefs[league] = checked;
    }
  });
  await saveBookPrefs(prefs);
  setStatus("booksStatus", "Saved. Fair values will use your selections.", "ok");
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
