const BLOCK_RULE_ID = 7100;
const UNLOCK_ALARM = "unlock";
const BUDGET_ALARM = "budget-expiry";

const DEFAULT_STATE = {
  sites: ["youtube.com", "reddit.com", "x.com"],
  groups: null,
  selectedGroupId: null,
  allowanceMinutes: 30,
  allowanceSeconds: null,
  cooldownHours: 8,
  allowEarlyUnlock: true,
  startedAt: null,
  usedMs: 0,
  isLocked: false,
  lockedUntil: null
};

const DEFAULT_RUNTIME = {
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
const readRuntime = async () => ({ ...DEFAULT_RUNTIME, ...(await chrome.storage.session.get(DEFAULT_RUNTIME)) });
const saveRuntime = (data) => chrome.storage.session.set(data);

function hostFor(url) {
  try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch { return null; }
}

function isLimited(url, sites) {
  const host = hostFor(url);
  return Boolean(host && sites.some((site) => host === site || host.endsWith(`.${site}`)));
}

function remainingMs(state) {
  const totalMs = Number.isFinite(state.allowanceSeconds)
    ? state.allowanceSeconds * 1000
    : state.allowanceMinutes * 60_000;
  return Math.max(0, totalMs - state.usedMs);
}

function allowanceMs(state) {
  return Number.isFinite(state.allowanceSeconds) ? state.allowanceSeconds * 1000 : state.allowanceMinutes * 60_000;
}

async function updateRules(state) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  // Remove both the consolidated rule and any per-site rules left by older builds.
  const removeRuleIds = existing
    .filter((rule) => rule.id >= BLOCK_RULE_ID && rule.id < BLOCK_RULE_ID + 1000)
    .map((rule) => rule.id);
  const addRules = state.isLocked && state.sites.length ? [{
    id: BLOCK_RULE_ID,
    priority: 1,
    action: { type: "redirect", redirect: { extensionPath: "/locked.html" } },
    condition: { requestDomains: [...new Set(state.sites)].slice(0, 1000), resourceTypes: ["main_frame"] }
  }] : [];
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
}

async function scheduleBudgetExpiry(state, runtime) {
  await chrome.alarms.clear(BUDGET_ALARM);
  if (!state.startedAt || state.isLocked || !runtime.activeSince || !runtime.windowFocused) return;
  const left = remainingMs(state);
  if (left > 0) chrome.alarms.create(BUDGET_ALARM, { when: Date.now() + left });
}

async function unlock(state) {
  const next = { ...state, isLocked: false, lockedUntil: null, usedMs: 0, startedAt: null };
  await save(next);
  await saveRuntime(DEFAULT_RUNTIME);
  await updateRules(next);
  await chrome.alarms.clear(UNLOCK_ALARM);
  await chrome.alarms.clear(BUDGET_ALARM);
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
  const next = { ...state, usedMs: allowanceMs(state), isLocked: true, lockedUntil };
  await save(next);
  await saveRuntime({ activeTabId: null, activeSince: null, windowFocused: true });
  await chrome.alarms.clear(BUDGET_ALARM);
  await updateRules(next);
  chrome.alarms.create(UNLOCK_ALARM, { when: lockedUntil });
  await redirectLimitedTabs(next);
  return next;
}

async function consume(state) {
  state = await reconcileExpiry(state);
  const runtime = await readRuntime();
  if (!state.startedAt || state.isLocked || !runtime.activeSince || !runtime.windowFocused) return state;
  // activeSince is only set while a limited page is focused. Do not inspect the
  // current URL here: during navigation it has already changed, but the elapsed
  // time still belongs to the page that was active before the transition.
  const elapsed = Math.max(0, Date.now() - runtime.activeSince);
  const next = { ...state, usedMs: state.usedMs + elapsed };
  if (remainingMs(next) <= 0) return lock(next);
  const nextRuntime = { ...runtime, activeSince: Date.now() };
  await save(next);
  await saveRuntime(nextRuntime);
  await scheduleBudgetExpiry(next, nextRuntime);
  return next;
}

async function setActiveTab(tabId) {
  let state = await consume(await read());
  const runtime = await readRuntime();
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const activeSince = state.startedAt && !state.isLocked && runtime.windowFocused && tab && isLimited(tab.url, state.sites)
    ? Date.now()
    : null;
  const nextRuntime = { ...runtime, activeTabId: tabId, activeSince };
  await saveRuntime(nextRuntime);
  await scheduleBudgetExpiry(state, nextRuntime);
  return state;
}

async function restoreRuntime() {
  let state = await reconcileExpiry(await read());
  await updateRules(state);
  await chrome.alarms.clear(BUDGET_ALARM);
  if (state.isLocked) {
    chrome.alarms.create(UNLOCK_ALARM, { when: state.lockedUntil });
    await saveRuntime(DEFAULT_RUNTIME);
  } else if (state.startedAt) {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const runtime = { activeTabId: tab?.id ?? null, activeSince: tab && isLimited(tab.url, state.sites) ? Date.now() : null, windowFocused: true };
    await saveRuntime(runtime);
    await scheduleBudgetExpiry(state, runtime);
  } else {
    await saveRuntime(DEFAULT_RUNTIME);
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
  const runtime = await readRuntime();
  if (tabId === runtime.activeTabId && changeInfo.url) state = await setActiveTab(tabId);
  if (state.isLocked && isLimited(tab.url, state.sites)) {
    await chrome.tabs.update(tabId, { url: chrome.runtime.getURL("locked.html") });
  }
}));

chrome.windows.onFocusChanged.addListener((windowId) => enqueue(async () => {
  let state = await consume(await read());
  const runtime = await readRuntime();
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    const nextRuntime = { ...runtime, windowFocused: false, activeSince: null };
    await saveRuntime(nextRuntime);
    await scheduleBudgetExpiry(state, nextRuntime);
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  const nextRuntime = {
    windowFocused: true,
    activeTabId: tab?.id ?? null,
    activeSince: tab && state.startedAt && !state.isLocked && isLimited(tab.url, state.sites) ? Date.now() : null
  };
  await saveRuntime(nextRuntime);
  await scheduleBudgetExpiry(state, nextRuntime);
}));

chrome.alarms.onAlarm.addListener((alarm) => enqueue(async () => {
  if (alarm.name === UNLOCK_ALARM) await reconcileExpiry(await read());
  if (alarm.name === BUDGET_ALARM) await consume(await read());
}));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  enqueue(async () => {
    let state = await reconcileExpiry(await read());
    if (message.type === "state") {
      state = await consume(state);
    } else if (message.type === "start") {
      state = {
        ...state,
        sites: [...new Set(message.sites)],
        allowanceMinutes: message.allowanceMinutes,
        allowanceSeconds: message.allowanceSeconds ?? null,
        cooldownHours: message.cooldownHours,
        startedAt: Date.now(),
        usedMs: 0,
        isLocked: false,
        lockedUntil: null
      };
      await updateRules(state);
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const runtime = {
        activeTabId: tab?.id ?? null,
        activeSince: tab && isLimited(tab.url, state.sites) ? Date.now() : null,
        windowFocused: true
      };
      await save(state);
      await saveRuntime(runtime);
      await scheduleBudgetExpiry(state, runtime);
    } else if (message.type === "unlockNow" && state.isLocked && state.allowEarlyUnlock) {
      state = await unlock(state);
    }
    sendResponse({ ...state, remainingMs: remainingMs(state) });
  }).catch((error) => sendResponse({ error: error.message }));
  return true;
});
