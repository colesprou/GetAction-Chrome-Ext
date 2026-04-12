// Service worker — handles fetches on behalf of content scripts so they
// aren't subject to the Kalshi page's CSP.
//
// Message protocol:
//   { type: "fetchFairValue", payload: {...} }
//     → returns the parsed JSON response or { status: "error", ... }
//   { type: "ping", backendUrl }
//     → returns { ok, version } or { status: "error" }

const DEFAULT_CONFIG = {
  backendUrl: "http://localhost:8000",
  extensionToken: "dev-local-token",
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

async function timedFetch(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function handleFetchFairValue(payload) {
  const config = await loadConfig();
  try {
    const res = await timedFetch(
      `${config.backendUrl}/fair-value`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Extension-Token": config.extensionToken,
        },
        body: JSON.stringify(payload),
      },
      config.requestTimeoutMs,
    );
    if (!res.ok) {
      return { status: "error", code: `http_${res.status}`, message: await res.text() };
    }
    return await res.json();
  } catch (err) {
    return { status: "error", code: "network_error", message: String(err) };
  }
}

async function handleResolveEvent(payload) {
  const config = await loadConfig();
  try {
    const res = await timedFetch(
      `${config.backendUrl}/resolve-event`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Extension-Token": config.extensionToken,
        },
        body: JSON.stringify(payload),
      },
      config.requestTimeoutMs,
    );
    if (!res.ok) {
      return { status: "error", code: `http_${res.status}`, message: await res.text() };
    }
    return await res.json();
  } catch (err) {
    return { status: "error", code: "network_error", message: String(err) };
  }
}

async function handlePing(backendUrlOverride) {
  const config = await loadConfig();
  const url = (backendUrlOverride || config.backendUrl) + "/health";
  try {
    const res = await timedFetch(url, { method: "GET" }, 3000);
    if (!res.ok) {
      return { status: "error", code: `http_${res.status}`, message: await res.text() };
    }
    return await res.json();
  } catch (err) {
    return { status: "error", code: "network_error", message: String(err) };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "fetchFairValue") {
    handleFetchFairValue(msg.payload || {}).then(sendResponse);
    return true;
  }
  if (msg.type === "resolveEvent") {
    handleResolveEvent(msg.payload || {}).then(sendResponse);
    return true;
  }
  if (msg.type === "ping") {
    handlePing(msg.backendUrl).then(sendResponse);
    return true;
  }
});

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
