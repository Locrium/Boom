const app = document.querySelector("#app");
let draft = { sites: ["youtube.com", "reddit.com", "x.com"], allowanceMinutes: 30, cooldownHours: 8 };
let groups = [];
let selectedGroupId = null;
const labels = { "youtube.com": "YouTube", "reddit.com": "Reddit", "x.com": "X" };
const groupTemplates = [
  { id: "social", name: "Social", icon: "#", sites: ["reddit.com", "x.com", "instagram.com", "facebook.com"] },
  { id: "video", name: "Video", icon: "▶", sites: ["youtube.com", "tiktok.com", "twitch.tv"] },
  { id: "news", name: "News", icon: "▤", sites: ["reuters.com", "bbc.com", "cnn.com"] }
];
const fmt = (ms) => `${Math.ceil(ms / 60_000)} min`;
const esc = (value) => value.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const brandMarkup = () => `<div class="brand"><img src="assets/logo-a.svg" alt=""><span>Boom<span class="dot">.</span></span></div>`;
let view = "loading";
let draftRevision = 0;
let saveQueue = Promise.resolve();
let themeMode = "system";
let allowEarlyUnlock = true;

function applyTheme(mode) {
  themeMode = ["system", "light", "dark"].includes(mode) ? mode : "system";
  if (themeMode === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = themeMode;
  document.querySelectorAll("[data-theme-choice]").forEach(button => button.classList.toggle("selected", button.dataset.themeChoice === themeMode));
}

chrome.storage.local.get({ themeMode: "system" }).then(({ themeMode: savedTheme }) => applyTheme(savedTheme));
chrome.storage.local.get({ allowEarlyUnlock: true }).then(({ allowEarlyUnlock: saved }) => {
  allowEarlyUnlock = saved;
  document.querySelector("#allow-early-unlock").checked = saved;
});
document.querySelector("#settings-trigger").onclick = () => {
  const group = groups.find(item => item.id === selectedGroupId);
  document.querySelector("#group-name-setting").value = group?.name || "";
  document.querySelector("#delete-group").disabled = groups.length <= 1;
  document.querySelector("#allow-early-unlock").checked = allowEarlyUnlock;
  document.querySelector("#settings-dialog").showModal();
};
document.querySelector("#settings-close").onclick = () => document.querySelector("#settings-dialog").close();
document.querySelector("#settings-dialog").onclick = (event) => { if (event.target === event.currentTarget) event.currentTarget.close(); };
document.querySelectorAll("[data-theme-choice]").forEach(button => button.onclick = async () => {
  applyTheme(button.dataset.themeChoice);
  await chrome.storage.local.set({ themeMode });
});
document.querySelector("#allow-early-unlock").onchange = async event => {
  allowEarlyUnlock = event.target.checked;
  await chrome.storage.local.set({ allowEarlyUnlock });
};
document.querySelector("#save-group-name").onclick = async () => {
  const input = document.querySelector("#group-name-setting");
  const name = input.value.trim().slice(0, 40);
  if (!name) { input.focus(); return; }
  groups = groups.map(group => group.id === selectedGroupId ? { ...group, name } : group);
  draftRevision += 1;
  await persistDraft();
  renderStart();
};
document.querySelector("#duplicate-group").onclick = async () => {
  await persistDraft();
  const source = groups.find(group => group.id === selectedGroupId);
  if (!source) return;
  const duplicate = { ...structuredClone(source), id: groupId(), name: uniqueGroupName(`${source.name} copy`) };
  groups.push(duplicate);
  selectedGroupId = duplicate.id;
  loadSelectedGroup();
  draftRevision += 1;
  await persistDraft();
  document.querySelector("#settings-dialog").close();
  renderStart();
};
document.querySelector("#delete-group").onclick = async () => {
  if (groups.length <= 1) return;
  const group = groups.find(item => item.id === selectedGroupId);
  if (!confirm(`Delete “${group?.name || "this group"}”?`)) return;
  groups = groups.filter(item => item.id !== selectedGroupId);
  selectedGroupId = groups[0].id;
  loadSelectedGroup();
  draftRevision += 1;
  await persistDraft();
  document.querySelector("#settings-dialog").close();
  renderStart();
};

function normalizeSite(value) {
  const raw = value.trim().toLowerCase();
  if (!raw) return null;
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    if (!url.hostname || !url.hostname.includes(".")) return null;
    return url.hostname.replace(/^www\./, "");
  } catch { return null; }
}

function addSite(site) {
  if (!site || draft.sites.includes(site)) return false;
  draft.sites.push(site);
  draftRevision += 1;
  void persistDraft();
  return true;
}

function groupId() { return `group-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`; }
function uniqueGroupName(base) {
  const existing = new Set(groups.map(group => group.name));
  if (!existing.has(base)) return base;
  let index = 2;
  while (existing.has(`${base} ${index}`)) index += 1;
  return `${base} ${index}`;
}
function loadSelectedGroup() {
  const group = groups.find(item => item.id === selectedGroupId) || groups[0];
  if (!group) return;
  selectedGroupId = group.id;
  draft = { sites: [...group.sites], allowanceMinutes: group.allowanceMinutes, cooldownHours: group.cooldownHours };
}
function hydrateGroups(state) {
  if (Array.isArray(state.groups) && state.groups.length) {
    groups = state.groups.map(group => ({
      id: group.id,
      name: group.name,
      sites: [...group.sites],
      allowanceMinutes: group.allowanceMinutes ?? 30,
      cooldownHours: group.cooldownHours ?? 8
    }));
    selectedGroupId = groups.some(group => group.id === state.selectedGroupId) ? state.selectedGroupId : groups[0].id;
  } else {
    selectedGroupId = "group-default";
    groups = [{ id: selectedGroupId, name: "Focus group", sites: [...state.sites], allowanceMinutes: state.allowanceMinutes, cooldownHours: state.cooldownHours }];
  }
  loadSelectedGroup();
}
function createGroupFromTemplate(template) {
  const group = {
    id: groupId(),
    name: uniqueGroupName(template.name),
    sites: [...template.sites],
    allowanceMinutes: 30,
    cooldownHours: 8
  };
  groups.push(group);
  selectedGroupId = group.id;
  loadSelectedGroup();
  draftRevision += 1;
  void persistDraft();
  renderStart();
}

function persistDraft() {
  groups = groups.map(group => group.id === selectedGroupId ? { ...group, sites: [...draft.sites], allowanceMinutes: draft.allowanceMinutes, cooldownHours: draft.cooldownHours } : group);
  const snapshot = {
    groups: structuredClone(groups),
    selectedGroupId,
    sites: [...draft.sites],
    allowanceMinutes: draft.allowanceMinutes,
    cooldownHours: draft.cooldownHours
  };
  saveQueue = saveQueue.then(() => chrome.storage.local.set(snapshot));
  return saveQueue;
}

function changeDraft(change) {
  change();
  draftRevision += 1;
  void persistDraft();
  renderStart();
}

function renderStart() {
  view = "setup";
  const cooldownPresets = [1, 2, 4, 8, 12, 24];
  const isCustomCooldown = !cooldownPresets.includes(draft.cooldownHours);
  const totalCooldownMinutes = Math.max(1, Math.round(draft.cooldownHours * 60));
  const customHours = Math.floor(totalCooldownMinutes / 60);
  const customMinutes = totalCooldownMinutes % 60;
  app.innerHTML = `${brandMarkup()}
    <label class="group-switch"><span>Active group</span><select id="group-select">${groups.map(group => `<option value="${esc(group.id)}" ${group.id===selectedGroupId?"selected":""}>${esc(group.name)}</option>`).join("")}</select></label>
    <h2>Sites in the group</h2><p class="group-copy">One shared allowance for all of them.</p>
    <div class="site-list">${draft.sites.map(site => `<span class="site-pill"><span>${esc(labels[site] || site)}</span><button class="site-only" data-only="${esc(site)}" aria-label="Use only ${esc(site)}">Only</button><button class="site-remove" data-remove="${esc(site)}" aria-label="Remove ${esc(site)}">×</button></span>`).join("") || `<span class="empty">No sites added yet</span>`}</div>
    <button class="add-group" id="add">＋ Add sites to group</button>
    <h2 class="time-title">How much time?</h2>
    <div class="stepper"><button class="round" id="minus" aria-label="Subtract 5 minutes">−</button><label class="minute-input"><input id="minutes" type="number" min="1" max="1440" step="1" value="${draft.allowanceMinutes}" aria-label="Allowance in minutes"><span>min</span></label><button class="round" id="plus" aria-label="Add 5 minutes">+</button></div>
    <p class="hint">Shared across all selected sites.</p>
    <div class="cooldown"><label>Reset becomes available after</label><select id="cooldown">${cooldownPresets.map(n=>`<option value="${n}" ${n===draft.cooldownHours?"selected":""}>${n} hours</option>`).join("")}<option value="custom" ${isCustomCooldown?"selected":""}>Custom…</option></select></div>
    <div class="custom-cooldown ${isCustomCooldown?"visible":""}" id="custom-cooldown"><div class="custom-title"><strong>Custom reset time</strong><span>Choose exactly how long sites stay locked.</span></div><div class="duration-fields"><label><span>Hours</span><input id="custom-hours" type="number" min="0" max="168" step="1" value="${customHours}"></label><label><span>Minutes</span><input id="custom-minutes" type="number" min="0" max="59" step="1" value="${customMinutes}"></label></div><p class="duration-error" id="duration-error"></p></div>
    <button class="primary" id="start">Start ${draft.allowanceMinutes}-minute allowance</button>
    <p class="foot">When it reaches 0, these sites lock.</p>`;
  document.querySelectorAll("[data-remove]").forEach(button => button.onclick = () => changeDraft(() => { draft.sites = draft.sites.filter(site => site !== button.dataset.remove); }));
  document.querySelectorAll("[data-only]").forEach(button => button.onclick = () => changeDraft(() => { draft.sites = [button.dataset.only]; }));
  document.querySelector("#group-select").onchange = async event => {
    await persistDraft();
    selectedGroupId = event.target.value;
    loadSelectedGroup();
    draftRevision += 1;
    await chrome.storage.local.set({ selectedGroupId });
    renderStart();
  };
  document.querySelector("#add").onclick = renderAddSites;
  document.querySelector("#minus").onclick = () => changeDraft(() => { draft.allowanceMinutes = Math.max(1, draft.allowanceMinutes - 5); });
  document.querySelector("#plus").onclick = () => changeDraft(() => { draft.allowanceMinutes = Math.min(1440, draft.allowanceMinutes + 5); });
  const minutesInput = document.querySelector("#minutes");
  const commitMinutes = () => {
    const parsed = Number.parseInt(minutesInput.value, 10);
    if (!Number.isFinite(parsed)) { minutesInput.value = draft.allowanceMinutes; return; }
    const next = Math.min(1440, Math.max(1, parsed));
    draft.allowanceMinutes = next;
    minutesInput.value = next;
    document.querySelector("#start").textContent = `Start ${next}-minute allowance`;
    draftRevision += 1;
    void persistDraft();
  };
  minutesInput.onchange = commitMinutes;
  minutesInput.onblur = commitMinutes;
  minutesInput.onkeydown = event => { if (event.key === "Enter") { commitMinutes(); minutesInput.blur(); } };
  const cooldownSelect = document.querySelector("#cooldown");
  const customPanel = document.querySelector("#custom-cooldown");
  cooldownSelect.onchange = event => {
    if (event.target.value === "custom") {
      customPanel.classList.add("visible");
      document.querySelector("#custom-hours").focus();
      return;
    }
    customPanel.classList.remove("visible");
    draft.cooldownHours = Number(event.target.value);
    draftRevision += 1;
    void persistDraft();
  };
  const commitCustomCooldown = () => {
    const hoursInput = document.querySelector("#custom-hours");
    const minutesInput = document.querySelector("#custom-minutes");
    const hours = Math.min(168, Math.max(0, Number.parseInt(hoursInput.value || "0", 10)));
    const minutes = Math.min(59, Math.max(0, Number.parseInt(minutesInput.value || "0", 10)));
    if (hours === 0 && minutes === 0) {
      document.querySelector("#duration-error").textContent = "Choose at least 1 minute.";
      return;
    }
    hoursInput.value = hours;
    minutesInput.value = minutes;
    document.querySelector("#duration-error").textContent = "";
    draft.cooldownHours = hours + minutes / 60;
    draftRevision += 1;
    void persistDraft();
  };
  document.querySelector("#custom-hours").onchange = commitCustomCooldown;
  document.querySelector("#custom-minutes").onchange = commitCustomCooldown;
  document.querySelector("#start").onclick = async () => {
    if (!draft.sites.length) return alert("Add at least one site to the group.");
    await chrome.runtime.sendMessage({ type: "start", ...draft });
    refresh();
  };
}

function renderAddSites() {
  view = "add-sites";
  app.innerHTML = `<button class="back" id="back">←</button>
    <div class="brand small">Add sites</div>
    <p class="add-intro">Choose how you want to add a site to this group.</p>
    <section class="template-section"><div class="template-heading"><strong>Create a template group</strong><span>Start a new group with common sites.</span></div><div class="template-grid">${groupTemplates.map(template => `<button class="template-card" data-template="${template.id}"><span>${template.icon}</span><strong>${template.name}</strong><small>${template.sites.length} sites</small></button>`).join("")}</div></section>
    <div class="or"><span>add to ${esc(groups.find(group => group.id === selectedGroupId)?.name || "this group")}</span></div>
    <button class="choice" id="current"><span class="choice-icon">◎</span><span><strong>Add current site</strong><small>Use the website open in this tab</small></span><span>›</span></button>
    <button class="choice only-current" id="only-current"><span class="choice-icon">1</span><span><strong>Only current site</strong><small>Replace this group’s sites with the open website</small></span><span>›</span></button>
    <div class="or"><span>or</span></div>
    <form class="manual" id="manual"><label for="website">Enter a website</label><div class="input-row"><input id="website" type="text" inputmode="url" placeholder="example.com" autocomplete="off"><button type="submit">Add</button></div><p class="error" id="error" role="alert"></p></form>
    <div class="current-group">${draft.sites.length} site${draft.sites.length === 1 ? "" : "s"} currently in this group</div>`;
  document.querySelector("#back").onclick = renderStart;
  document.querySelectorAll("[data-template]").forEach(button => button.onclick = () => {
    const template = groupTemplates.find(item => item.id === button.dataset.template);
    if (template) createGroupFromTemplate(template);
  });
  document.querySelector("#current").onclick = async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const site = normalizeSite(tab?.url || "");
    if (!site) return showError("Open a normal website first, then try again.");
    addSite(site);
    renderStart();
  };
  document.querySelector("#only-current").onclick = async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const site = normalizeSite(tab?.url || "");
    if (!site) return showError("Open a normal website first, then try again.");
    draft.sites = [site];
    draftRevision += 1;
    await persistDraft();
    renderStart();
  };
  document.querySelector("#manual").onsubmit = event => {
    event.preventDefault();
    const site = normalizeSite(document.querySelector("#website").value);
    if (!site) return showError("Enter a website like example.com.");
    addSite(site);
    renderStart();
  };
}

function showError(message) { document.querySelector("#error").textContent = message; }
function renderActive(state) { view = "active"; app.innerHTML = `${brandMarkup()}<div class="active"><p>Shared allowance for ${state.sites.map(site => esc(labels[site] || site)).join(", ")}</p><div class="ring"><strong>${fmt(state.remainingMs)}</strong><span>left</span></div><h2 class="center">Stay intentional.</h2><p class="status">Your selected sites lock when the timer reaches zero.</p></div>`; }
function renderLocked(state) { view = "locked"; allowEarlyUnlock = state.allowEarlyUnlock !== false; const left=Math.max(0,state.lockedUntil-Date.now()); const hours=Math.floor(left/3_600_000), mins=Math.ceil((left%3_600_000)/60_000); app.innerHTML=`${brandMarkup()}<div class="locked"><img class="locked-mark" src="assets/logo-a.svg" alt=""><h2>Time’s up.</h2><p>Your sites are locked.</p><p>Reset becomes available when the cooldown ends.</p><div class="disabled">Resets in ${hours}h ${mins}m</div>${allowEarlyUnlock?`<button class="unlock-now" id="unlock-now">Unlock now</button>`:""}</div>`; if(allowEarlyUnlock) document.querySelector("#unlock-now").onclick=async()=>{const next=await chrome.runtime.sendMessage({type:"unlockNow"}); if(!next.error) await refresh();}; }
async function refresh() {
  const revisionAtRequest = draftRevision;
  const state = await chrome.runtime.sendMessage({ type: "state" });
  if (state.isLocked) return renderLocked(state);
  if (state.startedAt) return renderActive(state);
  if (draftRevision !== revisionAtRequest || view === "add-sites") return;
  hydrateGroups(state);
  await persistDraft();
  renderStart();
}
refresh();
setInterval(async () => {
  if (view !== "active" && view !== "locked") return;
  const state = await chrome.runtime.sendMessage({ type: "state" });
  if (state.isLocked) renderLocked(state);
  else if (state.startedAt) renderActive(state);
  else refresh();
}, 5000);
