if (!globalThis.__boomHeartbeatStarted) {
  globalThis.__boomHeartbeatStarted = true;
  setInterval(() => chrome.runtime.sendMessage({ type: "heartbeat" }).catch(() => {}), 5000);
}
