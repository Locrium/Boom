const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

let now = 1_000_000;
let storage = {};
let rules = [];
const alarms = new Map();
const tabs = new Map([
  [1, { id: 1, active: true, windowId: 1, url: "https://youtube.com/watch?v=test" }],
  [2, { id: 2, active: false, windowId: 1, url: "https://example.com" }]
]);
const listeners = {};
const event = (name) => ({ addListener(fn) { listeners[name] = fn; } });

const chrome = {
  storage: { local: {
    async get(keys) {
      if (typeof keys === "string") return storage[keys] === undefined ? {} : { [keys]: storage[keys] };
      return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, storage[key] === undefined ? fallback : storage[key]]));
    },
    async set(value) { storage = { ...storage, ...structuredClone(value) }; }
  } },
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
  let state = await message({ type: "start", sites: ["youtube.com"], allowanceMinutes: 1, cooldownHours: 2 });
  assert.equal(state.remainingMs, 60_000, "allowance starts with the requested time");
  assert.equal(alarms.has("usage-tick"), true, "a fallback usage alarm is scheduled");

  now += 60_001;
  state = await message({ type: "heartbeat" }, { tab: { id: 1 } });
  assert.equal(state.isLocked, true, "group locks when active usage reaches the allowance");
  assert.equal(rules.length, 1, "a browser blocking rule is installed");
  assert.equal(rules[0].condition.requestDomains[0], "youtube.com");
  assert.equal(tabs.get(1).url, "chrome-extension://boom/locked.html", "an already-open limited tab is redirected immediately");
  assert.equal(alarms.has("unlock"), true, "unlock is scheduled for the cooldown end");

  now = state.lockedUntil + 1;
  state = await message({ type: "state" });
  assert.equal(state.isLocked, false, "expired cooldown is reconciled even if the alarm was missed");
  assert.equal(state.startedAt, null, "a new allowance can be started after cooldown");
  assert.equal(rules.length, 0, "blocking rules are removed after cooldown");
  assert.equal(alarms.has("unlock"), false, "stale unlock alarm is cleared");

  tabs.set(1, { id: 1, active: true, windowId: 1, url: "https://youtube.com" });
  state = await message({ type: "start", sites: ["youtube.com"], allowanceMinutes: 1, cooldownHours: 1 });
  now += 30_000;
  state = await message({ type: "heartbeat" }, { tab: { id: 2 } });
  assert.equal(state.remainingMs, 60_000, "heartbeats from inactive tabs do not consume time");
  state = await message({ type: "heartbeat" }, { tab: { id: 1 } });
  assert.equal(state.remainingMs, 30_000, "only the active limited tab consumes time");

  state = await message({ type: "start", sites: ["youtube.com"], allowanceMinutes: 1, cooldownHours: 0.025 });
  now += 60_001;
  state = await message({ type: "heartbeat" }, { tab: { id: 1 } });
  assert.equal(state.isLocked, true, "a custom cooldown session still locks normally");
  assert.equal(state.lockedUntil, now + 90_000, "a 1 minute 30 second custom cooldown is scheduled exactly");
  now += 90_001;
  state = await message({ type: "state" });
  assert.equal(state.isLocked, false, "a custom cooldown unlocks when its exact duration passes");
  assert.equal(rules.length, 0, "custom cooldown removes blocking rules when complete");

  console.log("PASS: allowance, blocking, preset/custom cooldown unlock, and active-tab accounting");
})().catch((error) => { console.error(error); process.exitCode = 1; });
