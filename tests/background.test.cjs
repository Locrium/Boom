const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

let now = 1_000_000;
let localStorage = {};
let sessionStorage = {};
let rules = [];
const alarms = new Map();
const tabs = new Map([
  [1, { id: 1, active: true, windowId: 1, url: "https://youtube.com/watch?v=test" }],
  [2, { id: 2, active: false, windowId: 1, url: "https://example.com" }]
]);
const listeners = {};
const event = (name) => ({ addListener(fn) { listeners[name] = fn; } });

function storageArea(which) {
  return {
    async get(keys) {
      const source = which();
      if (typeof keys === "string") return source[keys] === undefined ? {} : { [keys]: source[keys] };
      return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, source[key] === undefined ? fallback : source[key]]));
    },
    async set(value) {
      if (which === getLocal) localStorage = { ...localStorage, ...structuredClone(value) };
      else sessionStorage = { ...sessionStorage, ...structuredClone(value) };
    }
  };
}
const getLocal = () => localStorage;
const getSession = () => sessionStorage;

const chrome = {
  storage: { local: storageArea(getLocal), session: storageArea(getSession) },
  declarativeNetRequest: {
    async getDynamicRules() { return structuredClone(rules); },
    async updateDynamicRules({ removeRuleIds = [], addRules = [] }) {
      rules = rules.filter((rule) => !removeRuleIds.includes(rule.id)).concat(structuredClone(addRules));
    }
  },
  alarms: {
    create(name, info) { alarms.set(name, structuredClone(info)); },
    async clear(name) { return alarms.delete(name); },
    onAlarm: event("alarm")
  },
  tabs: {
    async query(query) {
      const all = [...tabs.values()];
      if (query.active) return all.filter((tab) => tab.active && (!query.windowId || tab.windowId === query.windowId));
      return all;
    },
    async get(id) { if (!tabs.has(id)) throw new Error("Missing tab"); return tabs.get(id); },
    async update(id, change) { const next = { ...tabs.get(id), ...change }; tabs.set(id, next); return next; },
    onActivated: event("activated"),
    onUpdated: event("updated")
  },
  windows: { WINDOW_ID_NONE: -1, onFocusChanged: event("focus") },
  runtime: {
    getURL(path) { return `chrome-extension://boom/${path.replace(/^\//, "")}`; },
    onInstalled: event("installed"),
    onStartup: event("startup"),
    onMessage: event("message")
  }
};

const context = vm.createContext({ chrome, console, URL, Set, Date: class extends Date { static now() { return now; } } });
vm.runInContext(fs.readFileSync("background.js", "utf8"), context, { filename: "background.js" });

function message(payload, sender = {}) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Message timed out")), 1000);
    listeners.message(payload, sender, (response) => { clearTimeout(timeout); resolve(response); });
  });
}

(async () => {
  await listeners.installed();
  let state = await message({ type: "start", sites: ["youtube.com", "reddit.com"], allowanceMinutes: 1, cooldownHours: 2 });
  assert.equal(state.remainingMs, 60_000, "allowance starts with the requested time");
  assert.equal(alarms.get("budget-expiry").when, now + 60_000, "one expiry alarm replaces heartbeat polling");
  assert.equal(rules.length, 0, "sites remain available before the allowance expires");

  now += 30_000;
  tabs.get(1).active = false;
  tabs.get(2).active = true;
  await listeners.activated({ tabId: 2 });
  state = await message({ type: "state" });
  assert.equal(state.remainingMs, 30_000, "only focused time on a limited site is consumed");
  assert.equal(alarms.has("budget-expiry"), false, "expiry alarm is cleared on an unlimited site");

  now += 45_000;
  state = await message({ type: "state" });
  assert.equal(state.remainingMs, 30_000, "time on an unlimited site is not consumed");

  tabs.get(2).active = false;
  tabs.set(1, { id: 1, active: true, windowId: 1, url: "https://youtube.com" });
  await listeners.activated({ tabId: 1 });
  assert.equal(alarms.get("budget-expiry").when, now + 30_000, "remaining budget is scheduled when focus returns");
  now += 30_001;
  await listeners.alarm({ name: "budget-expiry" });
  state = await message({ type: "state" });
  assert.equal(state.isLocked, true, "group locks when its event-driven expiry alarm fires");
  assert.equal(rules.length, 1, "one browser rule blocks the whole group");
  assert.deepEqual(rules[0].condition.requestDomains, ["youtube.com", "reddit.com"]);
  assert.equal(tabs.get(1).url, "chrome-extension://boom/locked.html", "an open limited tab is redirected immediately");
  assert.equal(alarms.has("unlock"), true, "cooldown unlock is scheduled");

  state = await message({ type: "unlockNow" });
  assert.equal(state.isLocked, false, "optional escape action unlocks immediately");
  assert.equal(rules.length, 0, "immediate unlock removes the blocking rule");

  await chrome.storage.local.set({ allowEarlyUnlock: false });
  tabs.set(1, { id: 1, active: true, windowId: 1, url: "https://youtube.com" });
  state = await message({ type: "start", sites: ["youtube.com"], allowanceMinutes: 1, cooldownHours: 0.025 });
  now += 60_001;
  await listeners.alarm({ name: "budget-expiry" });
  state = await message({ type: "unlockNow" });
  assert.equal(state.isLocked, true, "immediate unlock is rejected when disabled");
  assert.equal(state.lockedUntil, now + 90_000, "custom cooldown duration is exact");

  now = state.lockedUntil + 1;
  state = await message({ type: "state" });
  assert.equal(state.isLocked, false, "missed cooldown alarms are reconciled");
  assert.equal(state.startedAt, null, "a new allowance can start after cooldown");
  assert.equal(rules.length, 0, "blocking rule is removed after cooldown");

  console.log("PASS: event-driven timing, focused usage, blocking, cooldown, and optional early unlock");
})().catch((error) => { console.error(error); process.exitCode = 1; });
