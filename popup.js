const app = document.querySelector("#app");
let draft = { sites: ["youtube.com", "reddit.com", "x.com"], allowanceSeconds: 1800, cooldownHours: 8 };
let groups = [];
let selectedGroupId = null;
const labels = { "youtube.com": "YouTube", "reddit.com": "Reddit", "x.com": "X" };
const groupTemplates = [
  { id: "social", name: "Social", icon: "#", sites: ["reddit.com", "x.com", "instagram.com", "facebook.com"] },
  { id: "video", name: "Video", icon: "▶", sites: ["youtube.com", "tiktok.com", "twitch.tv"] },
  { id: "news", name: "News", icon: "▤", sites: ["reuters.com", "bbc.com", "cnn.com"] }
];
const fmt = (ms) => ms < 60_000 ? `${Math.max(0, Math.ceil(ms / 1000))} sec` : `${Math.ceil(ms / 60_000)} min`;
const durationLabel = (seconds) => {
  const minutes = Math.floor(seconds / 60), remainder = seconds % 60;
  if (minutes && remainder) return `${minutes}m ${remainder}s`;
  if (minutes) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  return `${remainder} second${remainder === 1 ? "" : "s"}`;
};
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
  draft = { sites: [...group.sites], allowanceSeconds: group.allowanceSeconds ?? (group.allowanceMinutes ?? 30) * 60, cooldownHours: group.cooldownHours };
}
function hydrateGroups(state) {
  if (Array.isArray(state.groups) && state.groups.length) {
    groups = state.groups.map(group => ({
      id: group.id,
      name: group.name,
      sites: [...group.sites],
      allowanceSeconds: group.allowanceSeconds ?? (group.allowanceMinutes ?? 30) * 60,
      cooldownHours: group.cooldownHours ?? 8
    }));
    selectedGroupId = groups.some(group => group.id === state.selectedGroupId) ? state.selectedGroupId : groups[0].id;
  } else {
    selectedGroupId = "group-default";
    groups = [{ id: selectedGroupId, name: "Focus group", sites: [...state.sites], allowanceSeconds: state.allowanceSeconds ?? state.allowanceMinutes * 60, cooldownHours: state.cooldownHours }];
  }
  loadSelectedGroup();
}
function createGroupFromTemplate(template) {
  const group = {
    id: groupId(),
    name: uniqueGroupName(template.name),
    sites: [...template.sites],
    allowanceSeconds: 1800,
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
  groups = groups.map(group => group.id === selectedGroupId ? { ...group, sites: [...draft.sites], allowanceSeconds: draft.allowanceSeconds, cooldownHours: draft.cooldownHours } : group);
  const snapshot = {
    groups: structuredClone(groups),
    selectedGroupId,
    sites: [...draft.sites],
    allowanceMinutes: Math.floor(draft.allowanceSeconds / 60),
    allowanceSeconds: draft.allowanceSeconds,
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

async function selectGroup(id, nextView = renderStart) {
  await persistDraft();
  selectedGroupId = id;
  loadSelectedGroup();
  draftRevision += 1;
  await chrome.storage.local.set({ selectedGroupId });
  nextView();
}

function isUniqueGroupName(name, exceptId = null) {
  const normalized = name.trim().toLowerCase();
  return normalized && !groups.some(group => group.id !== exceptId && group.name.trim().toLowerCase() === normalized);
}

function renderStart() {
  view = "setup";
  const cooldownPresets = [1, 2, 4, 8, 12, 24];
  const isCustomCooldown = !cooldownPresets.includes(draft.cooldownHours);
  const totalCooldownMinutes = Math.max(1, Math.round(draft.cooldownHours * 60));
  const customHours = Math.floor(totalCooldownMinutes / 60);
  const customMinutes = totalCooldownMinutes % 60;
  const allowanceMinutes = Math.floor(draft.allowanceSeconds / 60);
  const allowanceRemainder = draft.allowanceSeconds % 60;
  const group = groups.find(item => item.id === selectedGroupId);
  const siteSummary = draft.sites.length ? `${esc(labels[draft.sites[0]] || draft.sites[0])}${draft.sites.length > 1 ? ` + ${draft.sites.length - 1} site${draft.sites.length === 2 ? "" : "s"}` : ""}` : "No sites yet";
  app.innerHTML = `${brandMarkup()}
    <div class="group-picker"><button class="group-summary" id="group-trigger" aria-expanded="false"><span><small>Active group</small><strong>${esc(group?.name || "Focus group")}</strong><em>${siteSummary}</em></span><span>⌄</span></button><div class="group-menu" id="group-menu" hidden>${groups.map(item => `<button data-select-group="${esc(item.id)}"><span>${item.id===selectedGroupId?"✓":""}</span><span><strong>${esc(item.name)}</strong><small>${item.sites.length} site${item.sites.length===1?"":"s"}</small></span></button>`).join("")}<hr><button id="new-group"><span>＋</span><span>New blank group</span></button><button id="template-group"><span>▦</span><span>Create from template</span></button><button id="manage-groups"><span>☷</span><span>Manage groups…</span></button></div></div>
    <button class="edit-sites-button" id="edit-sites">Edit sites</button>
    <section class="allowance-block"><span class="eyebrow">Time allowed</span><div class="stepper"><button class="round" id="minus" aria-label="Subtract 5 minutes">−</button><div class="allowance-value"><strong id="allowance-summary">${allowanceRemainder ? `${allowanceMinutes}:${String(allowanceRemainder).padStart(2,"0")}` : allowanceMinutes}</strong><span id="allowance-unit">${allowanceRemainder ? "" : "min"}</span></div><button class="round" id="plus" aria-label="Add 5 minutes">+</button></div><button class="fine-toggle" id="fine-toggle" aria-expanded="false">Fine tune</button></section>
    <div class="fine-panel" id="fine-panel"><label><span>Minutes</span><input id="minutes" type="number" min="0" max="1440" value="${allowanceMinutes}"></label><b>:</b><label><span>Seconds</span><input id="seconds" type="number" min="0" max="59" value="${String(allowanceRemainder).padStart(2,"0")}"></label><p id="allowance-error"></p></div>
    <div class="cooldown"><label>Reset becomes available after</label><select id="cooldown">${cooldownPresets.map(n=>`<option value="${n}" ${n===draft.cooldownHours?"selected":""}>${n} hours</option>`).join("")}<option value="custom" ${isCustomCooldown?"selected":""}>Custom…</option></select></div>
    <div class="custom-cooldown ${isCustomCooldown?"visible":""}" id="custom-cooldown"><div class="custom-title"><strong>Custom reset time</strong><span>Choose exactly how long sites stay locked.</span></div><div class="duration-fields"><label><span>Hours</span><input id="custom-hours" type="number" min="0" max="168" step="1" value="${customHours}"></label><label><span>Minutes</span><input id="custom-minutes" type="number" min="0" max="59" step="1" value="${customMinutes}"></label></div><p class="duration-error" id="duration-error"></p></div>
    <button class="primary" id="start">Start ${durationLabel(draft.allowanceSeconds)} allowance</button>
    <p class="foot">The group locks when focused browsing reaches zero.</p>`;
  const groupMenu = document.querySelector("#group-menu");
  document.querySelector("#group-trigger").onclick = event => { groupMenu.hidden = !groupMenu.hidden; event.currentTarget.setAttribute("aria-expanded", String(!groupMenu.hidden)); };
  document.querySelectorAll("[data-select-group]").forEach(button => button.onclick = () => selectGroup(button.dataset.selectGroup));
  document.querySelector("#new-group").onclick = renderNewGroup;
  document.querySelector("#template-group").onclick = renderTemplates;
  document.querySelector("#manage-groups").onclick = renderManageGroups;
  document.querySelector("#edit-sites").onclick = renderAddSites;
  document.querySelector("#minus").onclick = () => changeDraft(() => { draft.allowanceSeconds = Math.max(5, draft.allowanceSeconds - 300); });
  document.querySelector("#plus").onclick = () => changeDraft(() => { draft.allowanceSeconds = Math.min(86400, draft.allowanceSeconds + 300); });
  const finePanel = document.querySelector("#fine-panel");
  document.querySelector("#fine-toggle").onclick = event => {
    finePanel.classList.toggle("visible");
    event.currentTarget.setAttribute("aria-expanded", finePanel.classList.contains("visible"));
  };
  const minutesInput = document.querySelector("#minutes");
  const secondsInput = document.querySelector("#seconds");
  const commitAllowance = () => {
    const minutes = Math.min(1440, Math.max(0, Number.parseInt(minutesInput.value || "0", 10)));
    const seconds = Math.min(59, Math.max(0, Number.parseInt(secondsInput.value || "0", 10)));
    const total = minutes * 60 + seconds;
    if (total < 5) { document.querySelector("#allowance-error").textContent = "Minimum allowance is 5 seconds."; return; }
    document.querySelector("#allowance-error").textContent = "";
    draft.allowanceSeconds = total;
    minutesInput.value = minutes;
    secondsInput.value = String(seconds).padStart(2, "0");
    document.querySelector("#allowance-summary").textContent = seconds ? `${minutes}:${String(seconds).padStart(2,"0")}` : minutes;
    document.querySelector("#allowance-unit").textContent = seconds ? "" : "min";
    document.querySelector("#start").textContent = `Start ${durationLabel(total)} allowance`;
    draftRevision += 1;
    void persistDraft();
  };
  minutesInput.onchange = commitAllowance;
  secondsInput.onchange = commitAllowance;
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
    await chrome.runtime.sendMessage({ type: "start", ...draft, allowanceMinutes: Math.floor(draft.allowanceSeconds / 60) });
    refresh();
  };
}

function renderNewGroup() {
  view = "new-group";
  app.innerHTML = `${brandMarkup()}<div class="subhead"><button class="back" id="back">←</button><div><small>New group</small><strong>Start from scratch</strong></div></div><p class="add-intro">Create an empty group and add only what you need.</p><form class="new-group-form" id="new-group-form"><label>Group name<input id="new-group-name" maxlength="40" placeholder="Research" autofocus></label><label>First website <small>optional</small><input id="new-group-site" inputmode="url" placeholder="example.com"></label><label class="current-site-check"><input id="include-current-site" type="checkbox"> Add the website open in this tab</label><p class="error" id="error" role="alert"></p><div class="form-actions"><button type="button" id="cancel-new">Cancel</button><button class="primary compact" type="submit">Create group</button></div></form><button class="template-link" id="view-templates">View templates instead</button>`;
  document.querySelector("#back").onclick = renderStart;
  document.querySelector("#cancel-new").onclick = renderStart;
  document.querySelector("#view-templates").onclick = renderTemplates;
  document.querySelector("#new-group-form").onsubmit = async event => {
    event.preventDefault();
    const name = document.querySelector("#new-group-name").value.trim().slice(0, 40);
    if (!name) return showError("Enter a group name.");
    if (!isUniqueGroupName(name)) return showError("Use a unique group name.");
    const manualSiteValue = document.querySelector("#new-group-site").value;
    const manualSite = manualSiteValue ? normalizeSite(manualSiteValue) : null;
    if (manualSiteValue && !manualSite) return showError("Enter a website like example.com.");
    const sites = manualSite ? [manualSite] : [];
    if (document.querySelector("#include-current-site").checked) {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const currentSite = normalizeSite(tab?.url || "");
      if (!currentSite) return showError("Open a normal website first, then try again.");
      if (!sites.includes(currentSite)) sites.push(currentSite);
    }
    const group = { id: groupId(), name, sites, allowanceSeconds: 1800, cooldownHours: 8 };
    groups.push(group);
    selectedGroupId = group.id;
    loadSelectedGroup();
    draftRevision += 1;
    await persistDraft();
    sites.length ? renderStart() : renderAddSites();
  };
}

function renderTemplates() {
  view = "templates";
  app.innerHTML = `${brandMarkup()}<div class="subhead"><button class="back" id="back">←</button><div><small>New group</small><strong>Choose a template</strong></div></div><p class="add-intro">Start with a common set of sites. You can edit it afterward.</p><div class="template-list">${groupTemplates.map(template => `<button data-template="${template.id}"><span>${template.icon}</span><span><strong>${template.name}</strong><small>${template.sites.join(", ")}</small></span><span>›</span></button>`).join("")}</div><button class="template-link" id="blank-group">Start from scratch instead</button>`;
  document.querySelector("#back").onclick = renderStart;
  document.querySelector("#blank-group").onclick = renderNewGroup;
  document.querySelectorAll("[data-template]").forEach(button => button.onclick = () => {
    const template = groupTemplates.find(item => item.id === button.dataset.template);
    if (template) createGroupFromTemplate(template);
  });
}

function renderManageGroups() {
  view = "manage-groups";
  app.innerHTML = `${brandMarkup()}<div class="subhead"><button class="back" id="back">←</button><div><small>Groups</small><strong>Manage groups</strong></div></div><div class="manage-group-list">${groups.map(group => `<section class="manage-group-row ${group.id===selectedGroupId?"selected":""}" data-group-row="${esc(group.id)}"><div><strong>${esc(group.name)}</strong><small>${group.sites.length} site${group.sites.length===1?"":"s"}${group.id===selectedGroupId?" · active":""}</small></div><div class="manage-actions"><button data-activate="${esc(group.id)}">Use</button><button data-rename="${esc(group.id)}">Rename</button><button data-duplicate="${esc(group.id)}">Duplicate</button><button class="danger" data-delete="${esc(group.id)}" ${groups.length<=1?"disabled":""}>Delete</button></div></section>`).join("")}</div><button class="add-current" id="new-group">＋ New group</button><p class="manage-note">Names must be unique. The final group cannot be deleted.</p>`;
  document.querySelector("#back").onclick = renderStart;
  document.querySelector("#new-group").onclick = renderNewGroup;
  document.querySelectorAll("[data-activate]").forEach(button => button.onclick = () => selectGroup(button.dataset.activate, renderManageGroups));
  document.querySelectorAll("[data-rename]").forEach(button => button.onclick = () => {
    const id = button.dataset.rename, group = groups.find(item => item.id === id), row = document.querySelector(`[data-group-row="${CSS.escape(id)}"]`);
    row.innerHTML = `<form class="rename-form"><input value="${esc(group.name)}" maxlength="40"><button type="submit">Save</button><button type="button" id="cancel-rename">Cancel</button><p class="error"></p></form>`;
    row.querySelector("#cancel-rename").onclick = renderManageGroups;
    row.querySelector("form").onsubmit = async event => {
      event.preventDefault(); const input = row.querySelector("input"), name = input.value.trim().slice(0,40);
      if (!name || !isUniqueGroupName(name,id)) { row.querySelector(".error").textContent = "Use a unique group name."; return; }
      groups = groups.map(item => item.id===id ? {...item,name} : item); draftRevision += 1; await persistDraft(); renderManageGroups();
    };
    row.querySelector("input").focus();
  });
  document.querySelectorAll("[data-duplicate]").forEach(button => button.onclick = async () => {
    await persistDraft(); const source = groups.find(group => group.id===button.dataset.duplicate); if(!source)return;
    const duplicate={...structuredClone(source),id:groupId(),name:uniqueGroupName(`${source.name} copy`)}; groups.push(duplicate); selectedGroupId=duplicate.id; loadSelectedGroup(); draftRevision+=1; await persistDraft(); renderManageGroups();
  });
  document.querySelectorAll("[data-delete]").forEach(button => button.onclick = async () => {
    if(groups.length<=1)return; const id=button.dataset.delete, group=groups.find(item=>item.id===id); if(!confirm(`Delete “${group.name}”?`))return;
    groups=groups.filter(item=>item.id!==id); if(selectedGroupId===id){selectedGroupId=groups[0].id;loadSelectedGroup();} draftRevision+=1; await persistDraft(); renderManageGroups();
  });
}

function renderAddSites() {
  view = "add-sites";
  app.innerHTML = `${brandMarkup()}<div class="edit-header"><button class="back" id="back">←</button><div><small>${esc(groups.find(group=>group.id===selectedGroupId)?.name||"Group")}</small><strong>Edit sites</strong></div><button id="done">Done</button></div><div class="autosave-status">✓ Saved automatically</div>
    <div class="edit-site-list">${draft.sites.map(site => `<div class="edit-site-row"><span><strong>${esc(labels[site] || site)}</strong><small>${esc(site)}</small></span><button class="site-only" data-only="${esc(site)}">Only</button><button class="site-remove" data-remove="${esc(site)}" aria-label="Remove ${esc(site)}">×</button></div>`).join("") || `<span class="empty">No sites added yet</span>`}</div>
    <p class="add-intro">Add another site to this group.</p>
    <button class="choice" id="current"><span class="choice-icon">◎</span><span><strong>Add current site</strong><small>Use the website open in this tab</small></span><span>›</span></button>
    <button class="choice only-current" id="only-current"><span class="choice-icon">1</span><span><strong>Only current site</strong><small>Replace this group’s sites with the open website</small></span><span>›</span></button>
    <div class="or"><span>or</span></div>
    <form class="manual" id="manual"><label for="website">Enter a website</label><div class="input-row"><input id="website" type="text" inputmode="url" placeholder="example.com" autocomplete="off"><button type="submit">Add</button></div><p class="error" id="error" role="alert"></p></form>
    <div class="current-group">${draft.sites.length} site${draft.sites.length === 1 ? "" : "s"} currently in this group</div>`;
  document.querySelector("#back").onclick = renderStart;
  document.querySelector("#done").onclick = renderStart;
  document.querySelectorAll("[data-remove]").forEach(button => button.onclick = async () => { draft.sites = draft.sites.filter(site => site !== button.dataset.remove); draftRevision += 1; await persistDraft(); renderAddSites(); });
  document.querySelectorAll("[data-only]").forEach(button => button.onclick = async () => { draft.sites = [button.dataset.only]; draftRevision += 1; await persistDraft(); renderAddSites(); });
  document.querySelector("#current").onclick = async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const site = normalizeSite(tab?.url || "");
    if (!site) return showError("Open a normal website first, then try again.");
    addSite(site);
    renderAddSites();
  };
  document.querySelector("#only-current").onclick = async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const site = normalizeSite(tab?.url || "");
    if (!site) return showError("Open a normal website first, then try again.");
    draft.sites = [site];
    draftRevision += 1;
    await persistDraft();
    renderAddSites();
  };
  document.querySelector("#manual").onsubmit = event => {
    event.preventDefault();
    const site = normalizeSite(document.querySelector("#website").value);
    if (!site) return showError("Enter a website like example.com.");
    addSite(site);
    renderAddSites();
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
  if (draftRevision !== revisionAtRequest || !["loading", "setup"].includes(view)) return;
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
