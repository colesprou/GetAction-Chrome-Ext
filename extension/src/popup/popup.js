const $ = (id) => document.getElementById(id);

async function loadSettings() {
  const stored = await chrome.storage.local.get(["backendUrl", "extensionToken", "testTicker"]);
  $("backendUrl").value = stored.backendUrl || "http://localhost:8000";
  $("extensionToken").value = stored.extensionToken || "dev-local-token";
  $("testTicker").value = stored.testTicker || "";
}

function setStatus(text, cls) {
  const el = $("status");
  el.textContent = text;
  el.className = "status" + (cls ? " " + cls : "");
}

$("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    backendUrl: $("backendUrl").value.trim(),
    extensionToken: $("extensionToken").value.trim(),
  });
  setStatus("Saved. Reload the Kalshi tab.", "ok");
});

$("ping").addEventListener("click", async () => {
  setStatus("Pinging…");
  const res = await chrome.runtime.sendMessage({
    type: "ping",
    backendUrl: $("backendUrl").value.trim(),
  });
  if (res && res.ok) {
    setStatus(`Backend OK — v${res.version}`, "ok");
  } else {
    setStatus(`Ping failed: ${res?.message || res?.code || "unknown"}`, "err");
  }
});

$("resetKpi").addEventListener("click", async () => {
  await chrome.storage.local.remove("kpiHeaderState");
  setStatus("KPI reset. Reload the Kalshi tab.", "ok");
});

$("test").addEventListener("click", async () => {
  const ticker = $("testTicker").value.trim();
  if (!ticker) {
    setStatus("Enter a ticker first", "err");
    return;
  }
  await chrome.storage.local.set({ testTicker: ticker });
  setStatus("Fetching fair value…");
  const res = await chrome.runtime.sendMessage({
    type: "fetchFairValue",
    payload: { ticker },
  });
  const out = $("result");
  out.hidden = false;
  out.textContent = JSON.stringify(res, null, 2);
  if (res?.status === "ok") {
    setStatus(`OK — fair YES ${res.fair.yes_cents}¢ / NO ${res.fair.no_cents}¢`, "ok");
  } else if (res?.status === "unmapped") {
    setStatus(`Unmapped: ${res.reason}`, "err");
  } else {
    setStatus(`Error: ${res?.message || res?.code || "unknown"}`, "err");
  }
});

loadSettings();
