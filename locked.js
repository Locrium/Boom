chrome.storage.local.get({ themeMode: "system" }).then(({ themeMode }) => {
  if (themeMode === "light" || themeMode === "dark") document.documentElement.dataset.theme = themeMode;
});
