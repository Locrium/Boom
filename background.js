const RULE_ID_BASE = 7100;
const UNLOCK_ALARM = "unlock";
const HEARTBEAT_SCRIPT = "boom-limited-sites-heartbeat";
const DEFAULT_STATE = {
  sites: ["youtube.com", "reddit.com", "x.com"],
  groups: null,
  selectedGroupId: null,
  allowanceMinutes: 30,
  cooldownHours: 8,
  startedAt: null,
  usedMs: 0,
  isLocked: false,
  lockedUntil: null,
  activeTabId: null,
  activeSince: null,
  windowFocused: true
};

let operationQueue = Promise.resolve();
function enqueue(work) {
  const result = operationQueue.then(work);
  operationQueue = result.catch((error) => console.error("Boom background error", error));
  return result;
}

const read = async () => ({ ...DEFAULT_STATE, ...(await chrome.storage.local.get(DEFAULT_STATE)) });
const save = (data) => chrome.storage.local.set(data);

function hostFor(url) {
  try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch { return null; }
}

function isLimited(url, sites) {
  const host = hostFor(url);
  return Boolean(host && sites.some((site) => host === site || host.endsWith(`.${site}`)));
}

function remainingMs(state) {
  return Math.max(0, state.allowanceMinutes * 60_000 - state.usedMs);
}

async function updateRules(state) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing
    .filter((rule) => rule.id >= RULE_ID_BASE && rule.id < RULE_ID_BASE + 1000)
    .map((rule) => rule.id);
  const addRules = state.isLocked ? state.sites.slice(0, 1000).map((site, index) => ({
    id: RULE_ID_BASE + index,
    priority: 1,
    action: { type: "redirect", redirect: { extensionPath: "/locked.html" } },
    condition: { requestDomains: [site], resourceTypes: ["main_frame"] }
  })) : [];
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
}

async function syncHeartbeatScript(sites = []) {
  await chrome.scripting.unregisterContentScripts({ ids: [HEARTBEAT_SCRIPT] }).catch(() => null);
  if (!sites.length) return;
  const matches = [...new Set(sites.map((site) => `*://*.${site}/*`))];
  await chrome.scripting.registerContentScripts([{
    id: HEARTBEAT_SCRIPT,
    matches,
    js: ["heartbeat.js"],
    runAt: "document_start",
    persistAcrossSessions: true
  }]);
}

async function ensureHeartbeatInTab(tab) {
  if (!tab?.id || !tab.url || !isLimited(tab.url, (await read()).sites)) return;
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["heartbeat.js"] }).catch(() => null);
}

async function unlock(state) {
  const next = {
    ...state,
    isLocked: false,
    lockedUntil: null,
    usedMs: 0,
    startedAt: null,
    activeSince: null
  };
  await save(next);
  await updateRules(next);
  await chrome.alarms.clear(UNLOCK_ALARM);
  await syncHeartbeatScript();
  return next;
}

async function reconcileExpiry(state) {
  if (state.isLocked && state.lockedUntil && state.lockedUntil <= Date.now()) return unlock(state);
  return state;
}

async function redirectLimitedTabs(state) {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs
    .filter((tab) => isLimited(tab.url, state.sites))
    .map((tab) => chrome.tabs.update(tab.id, { url: chrome.runtime.getURL("locked.html") }).catch(() => null)));
}

async function lock(state) {
  const lockedUntil = Date.now() + state.cooldownHours * 3_600_000;
  const next = {
    ...state,
    usedMs: state.allowanceMinutes * 60_000,
    isLocked: true,
    lockedUntil,
    activeSince: null
  };
  await save(next);
  await updateRules(next);
  await syncHeartbeatScript();
  chrome.alarms.create(UNLOCK_ALARM, { when: lockedUntil });
  await redirectLimitedTabs(next);
  return next;
}

async function consume(state) {
  state = await reconcileExpiry(state);
  if (!state.startedAt || state.isLocked || !state.activeSince || !state.windowFocused) return state;
  const tab = await chrome.tabs.get(state.activeTabId).catch(() => null);
  if (!tab || !isLimited(tab.url, state.sites)) {
    const next = { ...state, activeSince: null };
    await save(next);
    return next;
  }
  const elapsed = Math.max(0, Date.now() - state.activeSince);
  if (!elapsed) return state;
  const next = { ...state, usedMs: state.usedMs + elapsed, activeSince: Date.now() };
  if (remainingMs(next) <= 0) return lock(next);
  await save(next);
  return next;
}

async function setActiveTab(tabId) {
  let state = await consume(await read());
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const activeSince = state.startedAt && !state.isLocked && state.windowFocused && tab && isLimited(tab.url, state.sites)
    ? Date.now()
    : null;
  state = { ...state, activeTabId: tabId, activeSince };
  await save(state);
  if (activeSince) await ensureHeartbeatInTab(tab);
  return state;
}

async function restoreRuntime() {
  let state = await reconcileExpiry(await read());
  await updateRules(state);
  if (state.isLocked) {
    chrome.alarms.create(UNLOCK_ALARM, { when: state.lockedUntil });
  } else if (state.startedAt) {
    await syncHeartbeatScript(state.sites);
  } else {
    await syncHeartbeatScript();
  }
  return state;
}

chrome.runtime.onInstalled.addListener(() => enqueue(async () => {
  const existing = await chrome.storage.local.get("allowanceMinutes");
  if (existing.allowanceMinutes === undefined) await save(DEFAULT_STATE);
  await restoreRuntime();
}));

chrome.runtime.onStartup.addListener(() => enqueue(restoreRuntime));
chrome.tabs.onActivated.addListener(({ tabId }) => enqueue(() => setActiveTab(tabId)));
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => enqueue(async () => {
  let state = await reconcileExpiry(await read());
  if (tabId === state.activeTabId && changeInfo.url) state = await setActiveTab(tabId);
  if (state.isLocked && isLimited(tab.url, state.sites)) {
    await chrome.tabs.update(tabId, { url: chrome.runtime.getURL("locked.html") });
  }
}));

chrome.windows.onFocusChanged.addListener((windowId) => enqueue(async () => {
  let state = await consume(await read());
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    await save({ ...state, windowFocused: false, activeSince: null });
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  const activeSince = tab && state.startedAt && !state.isLocked && isLimited(tab.url, state.sites) ? Date.now() : null;
  await save({ ...state, windowFocused: true, activeTabId: tab?.id ?? null, activeSince });
}));

chrome.alarms.onAlarm.addListener((alarm) => enqueue(async () => {
  let state = await read();
  if (alarm.name === UNLOCK_ALARM) {
    await reconcileExpiry(state);
  }
}));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  enqueue(async () => {
    let state = await reconcileExpiry(await read());
    if (message.type === "heartbeat" && sender.tab?.id === state.activeTabId) {
      state = await consume(state);
    } else if (message.type === "start") {
      state = {
        ...state,
        sites: [...new Set(message.sites)],
        allowanceMinutes: message.allowanceMinutes,
        cooldownHours: message.cooldownHours,
        startedAt: Date.now(),
        usedMs: 0,
        isLocked: false,
        lockedUntil: null
      };
      await updateRules(state);
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      state.activeTabId = tab?.id ?? null;
      state.activeSince = tab && isLimited(tab.url, state.sites) ? Date.now() : null;
      await save(state);
      await syncHeartbeatScript(state.sites);
      const limitedTabs = (await chrome.tabs.query({})).filter((openTab) => isLimited(openTab.url, state.sites));
      await Promise.all(limitedTabs.map(ensureHeartbeatInTab));
    }
    sendResponse({ ...state, remainingMs: remainingMs(state) });
  }).catch((error) => sendResponse({ error: error.message }));
  return true;
});
