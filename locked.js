chrome.storage.local.get({ themeMode: "system" }).then(({ themeMode }) => {
  if (themeMode === "light" || themeMode === "dark") document.documentElement.dataset.theme = themeMode;
});
chrome.runtime.sendMessage({ type: "state" }).then((state) => {
  if (!state.isLocked) { history.back(); return; }
  const left = Math.max(0, state.lockedUntil - Date.now());
  const hours = Math.floor(left / 3_600_000);
  const minutes = Math.ceil((left % 3_600_000) / 60_000);
  document.querySelector("#reset-time").textContent = `Resets in ${hours}h ${minutes}m`;
  const button = document.querySelector("#unlock-now");
  button.hidden = state.allowEarlyUnlock === false;
  button.onclick = async () => {
    const next = await chrome.runtime.sendMessage({ type: "unlockNow" });
    if (!next.error && !next.isLocked) history.back();
  };
});
