const wall = document.querySelector("#wall");
const armBtn = document.querySelector("#armBtn");
const eventsEl = document.querySelector("#events");
const queueEl = document.querySelector("#queue");
const cameraForm = document.querySelector("#cameraForm");
const ruleForm = document.querySelector("#ruleForm");
const conditionsEl = document.querySelector("#conditions");
const cards = new Map();
let cameras = [];
let rules = [];
let publicMode = false;
const publicPlayers = [];

const PUBLIC_CAMERAS = [
  {
    id: "cuomo",
    name: "Мост Куомо",
    location: "I-87, Нью-Йорк",
    src: "https://s58.nysdot.skyvdn.com:443/rtplive/TA_168/playlist.m3u8",
  },
  {
    id: "i66",
    name: "Шоссе I-66",
    location: "Гейнсвилл, Виргиния",
    src: "https://media-sfs8.vdotcameras.com:443/rtplive/NROCCTVI66E00501/playlist.m3u8",
  },
  {
    id: "i66-61",
    name: "Шоссе I-66, 61-я миля",
    location: "Фэрфакс, Виргиния",
    src: "https://media-sfs8.vdotcameras.com:443/rtplive/NROCCTVI66E00610/playlist.m3u8",
  },
  {
    id: "i10",
    name: "Шоссе I-10",
    location: "Атчафалайя, Луизиана",
    src: "https://ITSStreamingBR2.dotd.la.gov/public/shr-cam-001.streams/playlist.m3u8",
  },
];

function url(path) {
  return new URL(String(path).replace(/^\//, ""), document.baseURI).href;
}

async function api(path, options) {
  const response = await fetch(url(path), options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  const type = response.headers.get("content-type") || "";
  return type.includes("json") ? response.json() : response.text();
}

function ensureCard(cam) {
  let card = cards.get(cam.id);
  if (card) return card;
  card = document.createElement("article");
  card.className = "card";
  card.innerHTML = `
    <img alt="" />
    <header><div><strong></strong><small class="place"></small></div></header>`;
  card.dataset.kind = "mjpeg";
  card.dataset.stream = url(`/api/cameras/${cam.id}/live`);
  markCameraCard(card, cam.name);
  wall.appendChild(card);
  cards.set(cam.id, card);
  return card;
}

function renderStatus(status) {
  const tel = status.telemetry || {};
  armBtn.textContent = status.armed ? "Вахта принята" : "Вахта снята";
  armBtn.className = status.armed ? "arm on" : "arm off";
  const form = document.querySelector("#telemetryForm");
  if (document.activeElement.form !== form) {
    form.speed_kn.value = tel.speed_kn ?? "";
    form.heading.value = tel.heading ?? "";
    form.lat.value = tel.lat ?? "";
    form.lon.value = tel.lon ?? "";
  }
  const seen = new Set();
  for (const cam of status.cameras) {
    if (!cam.enabled) continue;
    seen.add(cam.id);
    const card = ensureCard(cam);
    card.classList.toggle("rec", cam.recording);
    card.classList.toggle("alert", Boolean(cam.watch_heavy && cam.heavy_count));
    markCameraCard(card, cam.name);
    const place = card.querySelector(".place");
    if (place) place.textContent = cam.location || "";
  }
  for (const [id, card] of cards) {
    if (!seen.has(id)) {
      card.remove();
      cards.delete(id);
    }
  }
}

function fillCameraSelect() {
  const select = document.querySelector("#ruleCamera");
  const current = select.value;
  select.innerHTML = cameras
    .map((cam) => `<option value="${cam.id}">${cam.name}</option>`)
    .join("");
  if (current) select.value = current;
}

function renderCameraList() {
  document.querySelector("#cameraList").innerHTML = cameras
    .map(
      (cam) => `<li><span>${cam.name} · ${cam.source_type}:${cam.source_uri}</span>
        <span><button type="button" data-edit-cam="${cam.id}">править</button>
        <button type="button" data-del-cam="${cam.id}">убрать</button></span></li>`
    )
    .join("");
}

function conditionRow(cond = { type: "motion", min_ratio: 0.02 }) {
  const wrap = document.createElement("div");
  wrap.className = "cond";
  const zone = cond.zone || { x: 0, y: 0, w: 1, h: 1 };
  wrap.innerHTML = `
    <label>Тип
      <select class="ctype">
        <option value="motion">Движение</option>
        <option value="speed">Скорость судна</option>
        <option value="schedule">Расписание</option>
        <option value="armed">Вахта принята</option>
        <option value="color">Красный автомобиль</option>
        <option value="heavy">Не легковой: подсветка камеры</option>
      </select>
    </label>
    <div class="fields"></div>
    <button type="button" class="drop">Убрать условие</button>`;
  wrap.querySelector(".ctype").value = cond.type;
  const fields = wrap.querySelector(".fields");
  const paint = () => {
    const type = wrap.querySelector(".ctype").value;
    if (type === "motion") {
      fields.innerHTML = `
        <label>Порог, % <input class="min" type="number" min="0" max="100" step="0.5" value="${((cond.min_ratio ?? 0.02) * 100).toFixed(1)}" /></label>
        <label class="check"><input class="usezone" type="checkbox" ${cond.zone ? "checked" : ""}/> зона кадра</label>
        <div class="row zone">
          <label>x <input class="zx" type="number" step="0.05" value="${zone.x}" /></label>
          <label>y <input class="zy" type="number" step="0.05" value="${zone.y}" /></label>
          <label>w <input class="zw" type="number" step="0.05" value="${zone.w}" /></label>
          <label>h <input class="zh" type="number" step="0.05" value="${zone.h}" /></label>
        </div>`;
    } else if (type === "speed") {
      fields.innerHTML = `
        <label>Сравнение
          <select class="op">
            <option value="lt">меньше</option>
            <option value="lte">не больше</option>
            <option value="gt">больше</option>
            <option value="gte">не меньше</option>
            <option value="between">между</option>
          </select>
        </label>
        <label>Узлы <input class="knots" type="number" step="0.1" value="${cond.knots ?? 3}" /></label>
        <label>Верх диапазона <input class="knotsmax" type="number" step="0.1" value="${cond.knots_max ?? 8}" /></label>`;
      fields.querySelector(".op").value = cond.op || "lt";
    } else if (type === "color") {
      fields.innerHTML = `
        <label>Доля кадра, % <input class="min" type="number" min="0" max="100" step="0.1" value="${((cond.min_ratio ?? 0.004) * 100).toFixed(1)}" /></label>
        <label class="check"><input class="usezone" type="checkbox" ${cond.zone ? "checked" : ""}/> зона кадра</label>
        <div class="row zone">
          <label>x <input class="zx" type="number" step="0.05" value="${zone.x}" /></label>
          <label>y <input class="zy" type="number" step="0.05" value="${zone.y}" /></label>
          <label>w <input class="zw" type="number" step="0.05" value="${zone.w}" /></label>
          <label>h <input class="zh" type="number" step="0.05" value="${zone.h}" /></label>
        </div>
        <p class="hint">Стоп-сигнал и светофор не считаются: нужно движущееся красное пятно размером с кузов.</p>`;
    } else if (type === "heavy") {
      fields.innerHTML = `<p class="hint">Когда в кадре автобус или грузовик, карточка камеры подсвечивается красным. Легковые не считаются. Запись не начинается.</p>`;
    } else if (type === "schedule") {
      fields.innerHTML = `
        <label>С <input class="start" type="time" value="${cond.start || "18:00"}" /></label>
        <label>До <input class="end" type="time" value="${cond.end || "06:00"}" /></label>
        <p class="hint">Пустые дни означают всю неделю. Дни: 0 пн … 6 вс, через запятую.</p>
        <label>Дни <input class="days" value="${(cond.days || []).join(",")}" /></label>`;
    } else {
      fields.innerHTML = `<p class="hint">Клип разрешён только когда вахта принята.</p>`;
    }
  };
  paint();
  wrap.querySelector(".ctype").addEventListener("change", () => {
    cond = { type: wrap.querySelector(".ctype").value };
    paint();
  });
  wrap.querySelector(".drop").addEventListener("click", () => wrap.remove());
  return wrap;
}

function readConditions() {
  return [...conditionsEl.querySelectorAll(".cond")].map((wrap) => {
    const type = wrap.querySelector(".ctype").value;
    if (type === "motion") {
      const item = { type, min_ratio: Number(wrap.querySelector(".min").value) / 100 };
      if (wrap.querySelector(".usezone").checked) {
        item.zone = {
          x: Number(wrap.querySelector(".zx").value),
          y: Number(wrap.querySelector(".zy").value),
          w: Number(wrap.querySelector(".zw").value),
          h: Number(wrap.querySelector(".zh").value),
        };
      }
      return item;
    }
    if (type === "color") {
      const item = { type, color: "red", min_ratio: Number(wrap.querySelector(".min").value) / 100 };
      if (wrap.querySelector(".usezone").checked) {
        item.zone = {
          x: Number(wrap.querySelector(".zx").value),
          y: Number(wrap.querySelector(".zy").value),
          w: Number(wrap.querySelector(".zw").value),
          h: Number(wrap.querySelector(".zh").value),
        };
      }
      return item;
    }
    if (type === "heavy") return { type: "heavy" };
    if (type === "speed") {
      return {
        type,
        op: wrap.querySelector(".op").value,
        knots: Number(wrap.querySelector(".knots").value),
        knots_max: Number(wrap.querySelector(".knotsmax").value),
      };
    }
    if (type === "schedule") {
      const raw = wrap.querySelector(".days").value.trim();
      const item = {
        type,
        start: wrap.querySelector(".start").value,
        end: wrap.querySelector(".end").value,
      };
      if (raw) item.days = raw.split(",").map((part) => Number(part.trim()));
      return item;
    }
    return { type: "armed" };
  });
}

function renderRules() {
  document.querySelector("#ruleList").innerHTML = rules
    .map((rule) => {
      const cam = cameras.find((item) => item.id === rule.camera_id);
      const display = (rule.conditions || []).some((cond) => cond.type === "heavy");
      const mode = display ? "показ, без записи" : rule.match_mode;
      return `<li><span>${rule.name} · ${cam ? cam.name : "все"} · ${mode}</span>
        <span><button type="button" data-edit-rule="${rule.id}">править</button>
        <button type="button" data-del-rule="${rule.id}">убрать</button></span></li>`;
    })
    .join("");
}

let eventStamp = "";

let lastEvents = [];

function renderEvents(items) {
  lastEvents = items;
  const stamp = items.map((event) => `${event.id}:${event.ended_at || "open"}:${event.github_url ? 1 : 0}`).join("|");
  if (stamp === eventStamp) return;
  eventStamp = stamp;
  renderLocalQueue(items);
  if (!items.length) {
    eventsEl.innerHTML = `<p class="hint">Записей на судовом компьютере ещё нет.</p>`;
    return;
  }
  eventsEl.innerHTML = items
    .map(
      (event) => `<article class="event">
        <img src="${url(`/api/events/${event.id}/thumb`)}" alt="" />
        <div>
          <strong>${event.rule_name}</strong>
          <small>${event.camera_name} · ${event.started_at}${event.ended_at ? " → " + event.ended_at.slice(11, 19) : " · идёт"}</small>
          <small>${event.reason || ""}</small>
        </div>
        <span>
          <button type="button" data-play="${event.id}">Смотреть</button>
          <a href="${url(`/api/events/${event.id}/clip`)}">Файл</a>
          ${event.github_url ? `<a href="${event.github_url}" target="_blank" rel="noopener">GitHub</a>` : ""}
        </span>
      </article>`
    )
    .join("");
}

async function reloadConfig() {
  cameras = await api("/api/cameras");
  rules = await api("/api/rules");
  fillCameraSelect();
  renderCameraList();
  renderRules();
}

cameraForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
  const data = Object.fromEntries(new FormData(cameraForm));
  const body = {
    name: data.name,
    location: data.location || "",
    source_type: data.source_type,
    source_uri: data.source_uri || "",
    enabled: cameraForm.enabled.checked,
    fps: 8,
  };
  const id = data.id;
  await api(id ? `/api/cameras/${id}` : "/api/cameras", {
    method: id ? "PUT" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  cameraForm.reset();
  cameraForm.enabled.checked = true;
  await reloadConfig();
  } catch (error) {
    alert(error.message);
  }
});

document.querySelector("#cameraReset").addEventListener("click", () => {
  cameraForm.reset();
  cameraForm.id.value = "";
  cameraForm.enabled.checked = true;
});

ruleForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
  const data = Object.fromEntries(new FormData(ruleForm));
  const body = {
    name: data.name,
    camera_id: Number(data.camera_id),
    enabled: ruleForm.enabled.checked,
    match_mode: data.match_mode,
    pre_roll_sec: Number(data.pre_roll_sec),
    post_roll_sec: Number(data.post_roll_sec),
    cooldown_sec: Number(data.cooldown_sec),
    conditions: readConditions(),
  };
  if (!body.conditions.length) return;
  const id = data.id;
  await api(id ? `/api/rules/${id}` : "/api/rules", {
    method: id ? "PUT" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  ruleForm.reset();
  conditionsEl.innerHTML = "";
  conditionsEl.appendChild(conditionRow());
  ruleForm.enabled.checked = true;
  await reloadConfig();
  } catch (error) {
    alert(error.message);
  }
});

document.querySelector("#addCond").addEventListener("click", () => {
  conditionsEl.appendChild(conditionRow());
});
document.querySelector("#ruleReset").addEventListener("click", () => {
  ruleForm.reset();
  ruleForm.id.value = "";
  conditionsEl.innerHTML = "";
  conditionsEl.appendChild(conditionRow());
  ruleForm.enabled.checked = true;
});

document.body.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const editCam = target.dataset.editCam;
  const delCam = target.dataset.delCam;
  const editRule = target.dataset.editRule;
  const delRule = target.dataset.delRule;
  const play = target.dataset.play;
  if (editCam) {
    const cam = cameras.find((item) => item.id === Number(editCam));
    cameraForm.id.value = cam.id;
    cameraForm.name.value = cam.name;
    cameraForm.location.value = cam.location || "";
    cameraForm.source_type.value = cam.source_type;
    cameraForm.source_uri.value = cam.source_uri || "";
    cameraForm.enabled.checked = !!cam.enabled;
  }
  if (delCam) {
    await api(`/api/cameras/${delCam}`, { method: "DELETE" });
    cards.get(Number(delCam))?.remove();
    cards.delete(Number(delCam));
    await reloadConfig();
  }
  if (editRule) {
    const rule = rules.find((item) => item.id === Number(editRule));
    ruleForm.id.value = rule.id;
    ruleForm.name.value = rule.name;
    ruleForm.camera_id.value = rule.camera_id ?? "";
    ruleForm.match_mode.value = rule.match_mode;
    ruleForm.pre_roll_sec.value = rule.pre_roll_sec;
    ruleForm.post_roll_sec.value = rule.post_roll_sec;
    ruleForm.cooldown_sec.value = rule.cooldown_sec;
    ruleForm.enabled.checked = !!rule.enabled;
    conditionsEl.innerHTML = "";
    for (const cond of rule.conditions) conditionsEl.appendChild(conditionRow(cond));
  }
  if (delRule) {
    await api(`/api/rules/${delRule}`, { method: "DELETE" });
    await reloadConfig();
  }
  if (play) {
    const item = (await api("/api/events")).find((row) => row.id === Number(play));
    document.querySelector("#playerTitle").textContent = item ? item.rule_name : "Клип";
    document.querySelector("#playerMeta").textContent = item ? item.reason : "";
    const img = document.querySelector("#playerImg");
    img.src = url(`/api/events/${play}/playback?t=${Date.now()}`);
    document.querySelector("#player").showModal();
  }
});

armBtn.addEventListener("click", async () => {
  const status = await api("/api/status");
  await api("/api/arm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ armed: !status.armed }),
  });
});

document.querySelector("#telemetryForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  await api("/api/telemetry", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      speed_kn: Number(data.speed_kn),
      heading: Number(data.heading),
      lat: Number(data.lat),
      lon: Number(data.lon),
      mode: "manual",
    }),
  });
});

for (const button of document.querySelectorAll("[data-scenario]")) {
  button.addEventListener("click", () => api(`/api/scenario/${button.dataset.scenario}`, { method: "POST" }));
}

const CAM_KEY = "marine-online-cameras";
const RULE_KEY = "marine-online-rules";
const CASE_KEY = "marine-online-cases";
const REVIEW_KEY = "marine-online-reviews";
const HIDDEN_KEY = "marine-online-hidden";

for (const [next, older] of [
  [CAM_KEY, ["shipweb-cameras", "marine-vms-cameras"]],
  [RULE_KEY, ["shipweb-rules", "marine-vms-rules"]],
  [CASE_KEY, ["shipweb-cases", "marine-vms-cases"]],
  [REVIEW_KEY, ["shipweb-reviews", "marine-vms-reviews"]],
  [HIDDEN_KEY, ["shipweb-hidden", "marine-vms-hidden"]],
]) {
  if (localStorage.getItem(next) != null) continue;
  for (const prev of older) {
    const saved = localStorage.getItem(prev);
    if (saved != null) {
      localStorage.setItem(next, saved);
      break;
    }
  }
}
const openCalls = new Map();
const seenEvents = new Set();
let queueReady = false;
let audioCtx = null;

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function extraCameras() {
  const items = loadJson(CAM_KEY, []);
  if (!Array.isArray(items)) return [];
  const builtIn = new Set(PUBLIC_CAMERAS.map((cam) => cam.src));
  return items.filter((cam) => cam && cam.id && cam.src && cam.name && !builtIn.has(cam.src));
}

function saveExtras(items) {
  localStorage.setItem(CAM_KEY, JSON.stringify(items));
}

function allPublicCameras() {
  return PUBLIC_CAMERAS.concat(extraCameras());
}

function blankCondition(cameraId, id) {
  return {
    id: id || `cond-${Date.now()}`,
    name: "Не легковой автомобиль",
    cameraId,
    when: "heavy",
    enabled: true,
    record: false,
  };
}

const SEEDED_KEY = "marine-online-seeded";

function seededCameras() {
  const items = loadJson(SEEDED_KEY, []);
  return new Set(Array.isArray(items) ? items : []);
}

function rememberSeed(ids) {
  localStorage.setItem(SEEDED_KEY, JSON.stringify([...ids]));
}

function watchRules() {
  const stored = loadJson(RULE_KEY, null);
  const seeded = seededCameras();
  if (!Array.isArray(stored) || !stored.length) {
    const rules = allPublicCameras().map((cam) => blankCondition(cam.id, `cond-${cam.id}`));
    for (const cam of allPublicCameras()) seeded.add(cam.id);
    rememberSeed(seeded);
    return rules;
  }
  let changed = false;
  const rules = stored.map((rule) => {
    if (rule && rule.id && rule.when) return rule;
    changed = true;
    return {
      id: `cond-${rule.cameraId || "x"}`,
      name: rule.name || "Не легковой автомобиль",
      cameraId: rule.cameraId,
      when: "heavy",
      enabled: rule.enabled !== false,
      record: rule.mode === "call",
    };
  }).filter((rule) => rule && rule.cameraId);
  for (const cam of allPublicCameras()) {
    if (seeded.has(cam.id)) continue;
    if (!rules.some((rule) => rule.cameraId === cam.id)) {
      rules.push(blankCondition(cam.id, `cond-${cam.id}`));
      changed = true;
    }
    seeded.add(cam.id);
    changed = true;
  }
  if (changed) {
    rememberSeed(seeded);
    saveRules(rules);
  }
  return rules;
}

function saveRules(items) {
  localStorage.setItem(RULE_KEY, JSON.stringify(items));
}

function watchCases() {
  const items = loadJson(CASE_KEY, []);
  return Array.isArray(items) ? items : [];
}

function saveCases(items) {
  localStorage.setItem(CASE_KEY, JSON.stringify(items.slice(0, 30)));
}

function reviews() {
  return loadJson(REVIEW_KEY, {});
}

function saveReview(id, status) {
  const all = reviews();
  all[String(id)] = status;
  localStorage.setItem(REVIEW_KEY, JSON.stringify(all));
}

function hiddenEvents() {
  return new Set(loadJson(HIDDEN_KEY, []));
}

function clock(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("ru", { hour: "2-digit", minute: "2-digit", second: "2-digit", day: "2-digit", month: "2-digit" });
}

function beep() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  if (!audioCtx) audioCtx = new Ctx();
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  const now = audioCtx.currentTime;
  const tone = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  tone.frequency.value = 880;
  tone.connect(gain);
  gain.connect(audioCtx.destination);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.12, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
  tone.start(now);
  tone.stop(now + 0.3);
}

function snapshot(video) {
  if (!video.videoWidth) return "";
  const canvas = document.createElement("canvas");
  const width = 320;
  const height = Math.max(1, Math.round(width * video.videoHeight / video.videoWidth));
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(video, 0, 0, width, height);
  try {
    return canvas.toDataURL("image/jpeg", 0.62);
  } catch {
    return "";
  }
}

function renderExtraList() {
  const items = extraCameras();
  const list = document.querySelector("#extraList");
  list.innerHTML = items.length
    ? items.map((cam) => `<li><span>${escapeHtml(cam.name)}</span>
        <button type="button" data-drop-extra="${escapeHtml(cam.id)}">Убрать</button></li>`).join("")
    : "";
}

let selectedConditionId = null;

function renderConditions() {
  const rules = watchRules();
  const cameras = allPublicCameras();
  if (!rules.some((rule) => rule.id === selectedConditionId)) {
    selectedConditionId = rules[0] ? rules[0].id : null;
  }
  const list = document.querySelector("#conditionList");
  list.innerHTML = rules.length
    ? rules.map((rule) => {
      const cam = cameras.find((item) => item.id === rule.cameraId);
      const cameraName = cam ? cam.name : "камера недоступна";
      return `<li class="${rule.id === selectedConditionId ? "on" : ""}">
        <label class="check"><input data-toggle-condition="${escapeHtml(rule.id)}" type="checkbox" ${rule.enabled ? "checked" : ""}/></label>
        <button type="button" class="pick" data-pick-condition="${escapeHtml(rule.id)}"><span>${escapeHtml(rule.name)}</span><small>${escapeHtml(cameraName)}</small></button>
        <span class="tag">${rule.record ? "запись" : "показать"}</span>
      </li>`;
    }).join("")
    : `<li><span class="hint">Условий пока нет.</span></li>`;
  const form = document.querySelector("#conditionForm");
  const rule = rules.find((item) => item.id === selectedConditionId);
  form.hidden = !rule;
  document.querySelector("#dropCondition").disabled = !rule;
  if (!rule) return;
  form.dataset.id = rule.id;
  form.name.value = rule.name;
  form.cameraId.innerHTML = cameras
    .map((cam) => `<option value="${escapeHtml(cam.id)}">${escapeHtml(cam.name)}</option>`)
    .join("");
  if (cameras.some((cam) => cam.id === rule.cameraId)) form.cameraId.value = rule.cameraId;
  form.when.value = "heavy";
  form.enabled.checked = Boolean(rule.enabled);
  form.record.checked = Boolean(rule.record);
}

function renderPlainRules() {
  renderConditions();
}

function releaseIdleCameras() {
  const rules = watchRules();
  for (const card of wall.querySelectorAll(".card[data-camera]")) {
    const enabled = rules.some((rule) => rule.cameraId === card.dataset.camera && rule.enabled && rule.when === "heavy");
    if (!enabled) card.classList.remove("alert");
  }
}

function persistConditionForm() {
  const form = document.querySelector("#conditionForm");
  const id = form.dataset.id;
  if (!id) return;
  const next = {
    id,
    name: form.name.value.trim() || "Нарушение",
    cameraId: form.cameraId.value,
    when: "heavy",
    enabled: form.enabled.checked,
    record: form.record.checked,
  };
  const rules = watchRules();
  const index = rules.findIndex((rule) => rule.id === id);
  if (index >= 0) rules[index] = next;
  else rules.push(next);
  saveRules(rules);
  selectedConditionId = id;
  renderConditions();
  releaseIdleCameras();
}

function emptyQueue(text) {
  queueEl.innerHTML = `<p class="hint">${text}</p>`;
}

function renderPublicQueue() {
  const items = watchCases();
  if (!items.length) {
    emptyQueue("Тихо. Камера подсветится, когда включённое условие что-то найдёт. Ролик появится здесь, если у условия включена запись.");
    return;
  }
  queueEl.innerHTML = items.map((item) => {
    const calling = item.status === "open" && !item.acked && openCalls.has(item.cameraId);
    const done = item.status !== "open";
    const label = item.status === "confirmed" ? "подтверждено" : item.status === "false" ? "ложная тревога" : "";
    return `<article class="event case${calling ? " calling" : ""}${done ? " done" : ""}">
      <img src="${item.frame || "data:image/gif;base64,R0lGODlhAQABAAAAACw="}" alt="" />
      <div>
        <strong>${item.ruleName}</strong>
        <small>${item.cameraName} · ${clock(item.at)}</small>
        <small>${item.clip ? "ролик" : ""}${label ? ` ${label}` : ""}</small>
      </div>
      <span class="actions">
        <button type="button" data-open-case="${item.id}">Открыть</button>
        ${item.status === "open" && !item.acked ? `<button type="button" data-ack="${item.id}">Принял</button>` : ""}
        ${item.status === "open" ? `<button type="button" data-confirm="${item.id}">Подтвердить</button><button type="button" data-false="${item.id}">Ложная тревога</button>` : ""}
      </span>
    </article>`;
  }).join("");
}

function renderLocalQueue(items) {
  if (publicMode) return;
  const enabled = new Set(cameras.filter((cam) => cam.enabled).map((cam) => cam.id));
  const hidden = hiddenEvents();
  const visible = items.filter((event) => enabled.has(event.camera_id) && !hidden.has(event.id));
  const fresh = visible.filter((event) => !seenEvents.has(event.id));
  const wasReady = queueReady;
  if (wasReady && fresh.length) beep();
  for (const event of visible) seenEvents.add(event.id);
  queueReady = true;
  if (!visible.length) {
    emptyQueue("Тихо. Неразобранных случаев нет.");
    return;
  }
  const marks = reviews();
  queueEl.innerHTML = visible.map((event) => {
    const mark = marks[String(event.id)] || "";
    const calling = wasReady && !mark && fresh.some((item) => item.id === event.id);
    const done = mark === "confirmed" || mark === "false";
    const label = mark === "confirmed" ? "подтверждено" : mark === "false" ? "ложная тревога" : "";
    return `<article class="event case${calling ? " calling" : ""}${done ? " done" : ""}">
      <img src="${url(`/api/events/${event.id}/thumb`)}" alt="" />
      <div>
        <strong>${event.rule_name}</strong>
        <small>${event.camera_name} · ${event.started_at}</small>
        <small>${label}</small>
      </div>
      <span class="actions">
        <button type="button" data-play="${event.id}">Открыть</button>
        ${!mark ? `<button type="button" data-ack-event="${event.id}">Принял</button>` : ""}
        ${!done ? `<button type="button" data-confirm-event="${event.id}">Подтвердить</button><button type="button" data-false-event="${event.id}">Ложная тревога</button>` : ""}
      </span>
    </article>`;
  }).join("");
}

function noteCall(cam, rule, active, video) {
  const current = openCalls.get(cam.id);
  if (!active) {
    openCalls.delete(cam.id);
    return;
  }
  if (current) return;
  const item = {
    id: `${cam.id}-${Date.now()}`,
    cameraId: cam.id,
    cameraName: cam.name,
    ruleName: rule.name,
    at: new Date().toISOString(),
    frame: snapshot(video),
    status: "open",
    acked: false,
  };
  openCalls.set(cam.id, item);
  saveCases([item, ...watchCases()]);
  renderPublicQueue();
  beep();
}

const recorders = new Map();
const heldRecords = new Set();
let clipsOpen = true;

function clipDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("marine-online", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("clips");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function saveClip(id, blob) {
  return clipDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction("clips", "readwrite");
    tx.objectStore("clips").put(blob, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

function loadClip(id) {
  return clipDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction("clips", "readonly");
    const request = tx.objectStore("clips").get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  })).catch(() => null);
}

function clearClips() {
  return clipDb().then((db) => new Promise((resolve) => {
    const tx = db.transaction("clips", "readwrite");
    tx.objectStore("clips").clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  })).catch(() => {});
}

function stopRecord(cameraId) {
  const job = recorders.get(cameraId);
  if (!job) return;
  recorders.delete(cameraId);
  clearTimeout(job.timer);
  openCalls.delete(cameraId);
  if (job.recorder && job.recorder.state === "recording") job.recorder.stop();
}

function startRecord(cam, rule, video) {
  const item = {
    id: `${cam.id}-${Date.now()}`,
    cameraId: cam.id,
    cameraName: cam.name,
    ruleName: rule.name,
    at: new Date().toISOString(),
    frame: snapshot(video),
    status: "open",
    acked: false,
    clip: false,
  };
  const finishFrame = () => {
    openCalls.set(cam.id, item);
    saveCases([item, ...watchCases()]);
    renderPublicQueue();
    beep();
  };
  let stream = null;
  try {
    stream = video.captureStream ? video.captureStream() : null;
  } catch {
    stream = null;
  }
  if (!stream || !window.MediaRecorder || video.readyState < 2) {
    finishFrame();
    return;
  }
  const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp8") ? "video/webm;codecs=vp8" : "video/webm";
  let recorder;
  try {
    recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 700000 });
  } catch {
    finishFrame();
    return;
  }
  const chunks = [];
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size) chunks.push(event.data);
  };
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: mime });
    if (!clipsOpen || !blob.size) return;
    item.clip = true;
    saveClip(item.id, blob).then(() => patchCase(item.id, { clip: true })).catch(() => {});
  };
  try {
    recorder.start();
  } catch {
    finishFrame();
    return;
  }
  const timer = setTimeout(() => stopRecord(cam.id), 20000);
  recorders.set(cam.id, { recorder, timer });
  finishFrame();
}

function noteRecord(cam, rule, active, video) {
  if (!active || !rule) {
    stopRecord(cam.id);
    heldRecords.delete(cam.id);
    return;
  }
  if (heldRecords.has(cam.id)) return;
  if (video.readyState < 2) return;
  heldRecords.add(cam.id);
  startRecord(cam, rule, video);
}

function patchCase(id, change) {
  const items = watchCases().map((item) => (item.id === id ? { ...item, ...change } : item));
  saveCases(items);
  const open = [...openCalls.entries()].find(([, item]) => item.id === id);
  if (open) openCalls.set(open[0], { ...open[1], ...change });
  renderPublicQueue();
}

function renderPlainAndQueue() {
  renderPlainRules();
  if (publicMode) renderPublicQueue();
}

async function tick() {
  try {
    const status = await api("/api/status");
    if (publicMode) {
      publicMode = false;
      stopPublicPlayers();
      wall.innerHTML = "";
      cards.clear();
    }
    document.body.classList.add("local");
    renderStatus(status);
    renderEvents(await api("/api/events"));
  } catch (error) {
    console.error(error);
    document.body.classList.remove("local");
    if (!publicMode) {
      publicMode = true;
      showPublicCameras();
    }
  }
}

function stopPublicPlayers() {
  heldRecords.clear();
  for (const id of [...recorders.keys()]) stopRecord(id);
  if (window.HeavyWatch) HeavyWatch.stop();
  for (const player of publicPlayers) player.destroy();
  publicPlayers.length = 0;
  armBtn.disabled = false;
}

function markCameraCard(card, name) {
  card.dataset.title = name;
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.setAttribute("aria-label", `Открыть крупно: ${name}`);
  const title = card.querySelector("strong");
  if (title) title.textContent = name;
}

let zoomPlayer = null;

function closeZoom() {
  if (zoomPlayer) {
    zoomPlayer.detachMedia();
    zoomPlayer.destroy();
    zoomPlayer = null;
  }
  const video = document.querySelector("#cameraViewVideo");
  const img = document.querySelector("#cameraViewImg");
  video.pause();
  video.removeAttribute("src");
  video.load();
  video.hidden = true;
  img.removeAttribute("src");
  img.hidden = true;
}

function openCamera(card) {
  const src = card.dataset.stream;
  if (!src) return;
  closeZoom();
  const name = card.dataset.title || "Камера";
  document.querySelector("#cameraViewTitle").textContent = name;
  const video = document.querySelector("#cameraViewVideo");
  const img = document.querySelector("#cameraViewImg");
  if (card.dataset.kind === "mjpeg") {
    img.hidden = false;
    img.alt = name;
    img.src = src;
  } else {
    video.hidden = false;
    video.muted = true;
    if (window.Hls && Hls.isSupported()) {
      zoomPlayer = new Hls();
      zoomPlayer.loadSource(src);
      zoomPlayer.attachMedia(video);
      zoomPlayer.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
    } else {
      video.src = src;
      video.play().catch(() => {});
    }
  }
  document.querySelector("#cameraView").showModal();
}

function attachStream(video, src) {
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  const mark = (text) => {
    if (text !== "нет сигнала") return;
    const note = video.closest(".card") && video.closest(".card").querySelector(".signal");
    if (note) note.textContent = text;
  };
  if (window.Hls && Hls.isSupported()) {
    const player = new Hls();
    player.loadSource(src);
    player.attachMedia(video);
    player.on(Hls.Events.ERROR, (_, data) => {
      if (data.fatal) mark("нет сигнала");
    });
    player.on(Hls.Events.MANIFEST_PARSED, () => {
      mark("идёт");
      video.play().catch(() => {});
    });
    publicPlayers.push(player);
    return;
  }
  video.src = src;
  video.addEventListener("error", () => mark("нет сигнала"));
  video.play().then(() => mark("идёт")).catch(() => mark("нет сигнала"));
}

function showPublicCameras() {
  stopPublicPlayers();
  cards.clear();
  wall.innerHTML = "";
  armBtn.disabled = true;
  armBtn.textContent = "На судовом компьютере";
  eventsEl.innerHTML = `<p class="hint">Журнал роликов ведётся на судовом компьютере. Здесь вахта видит живые камеры.</p>`;
  const watches = [];
  for (const cam of allPublicCameras()) {
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `
      <div class="stage"><video muted autoplay playsinline></video></div>
      <header><div><strong></strong><small class="place"></small></div><span class="signal"></span></header>`;
    card.dataset.kind = "hls";
    card.dataset.stream = cam.src;
    card.dataset.camera = cam.id;
    markCameraCard(card, cam.name);
    const place = card.querySelector(".place");
    if (place) place.textContent = cam.location || "";
    wall.appendChild(card);
    const video = card.querySelector("video");
    attachStream(video, cam.src);
    watches.push({
      video,
      live() {
        return watchRules().some((rule) => rule.cameraId === cam.id && rule.enabled && rule.when === "heavy");
      },
      onMarks(count) {
        const matched = watchRules().filter((rule) => rule.cameraId === cam.id && rule.enabled && rule.when === "heavy" && count > 0);
        card.classList.toggle("alert", matched.length > 0);
        const recording = matched.find((rule) => rule.record);
        noteRecord(cam, recording || null, Boolean(recording), video);
      },
      onError() {
        const slot = card.querySelector(".signal");
        if (slot) slot.textContent = "нет сигнала";
      },
    });
  }
  if (window.HeavyWatch) HeavyWatch.start(watches);
  renderExtraList();
  renderPlainRules();
  renderPublicQueue();
}

function showView(name) {
  document.querySelector("#watch").hidden = name !== "watch";
  document.querySelector("#setup").hidden = name !== "setup";
  document.querySelector("#showWatch").classList.toggle("on", name === "watch");
  document.querySelector("#showSetup").classList.toggle("on", name === "setup");
}

wall.addEventListener("click", (event) => {
  const card = event.target.closest(".card");
  if (card) openCamera(card);
});
wall.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const card = event.target.closest(".card");
  if (!card) return;
  event.preventDefault();
  openCamera(card);
});
const cameraView = document.querySelector("#cameraView");
cameraView.addEventListener("close", closeZoom);
cameraView.addEventListener("click", (event) => {
  if (event.target === cameraView) cameraView.close();
});

document.querySelector("#showWatch").addEventListener("click", () => showView("watch"));
document.querySelector("#showSetup").addEventListener("click", () => showView("setup"));

document.querySelector("#conditionList").addEventListener("click", (event) => {
  const pick = event.target.closest("[data-pick-condition]");
  if (!pick) return;
  selectedConditionId = pick.dataset.pickCondition;
  renderConditions();
});

document.querySelector("#conditionList").addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || !target.dataset.toggleCondition) return;
  const rules = watchRules().map((rule) => (
    rule.id === target.dataset.toggleCondition ? { ...rule, enabled: target.checked } : rule
  ));
  saveRules(rules);
  renderConditions();
  releaseIdleCameras();
});

document.querySelector("#conditionForm").addEventListener("change", () => {
  persistConditionForm();
});

document.querySelector("#conditionForm").addEventListener("submit", (event) => {
  event.preventDefault();
  persistConditionForm();
});

document.querySelector("#newCondition").addEventListener("click", () => {
  const cam = allPublicCameras()[0];
  if (!cam) return;
  const rule = blankCondition(cam.id);
  saveRules(watchRules().concat(rule));
  selectedConditionId = rule.id;
  renderConditions();
  document.querySelector("#conditionForm").name.focus();
});

document.querySelector("#dropCondition").addEventListener("click", () => {
  if (!selectedConditionId) return;
  const rules = watchRules().filter((rule) => rule.id !== selectedConditionId);
  saveRules(rules);
  selectedConditionId = rules[0] ? rules[0].id : null;
  renderConditions();
  releaseIdleCameras();
});

document.querySelector("#player").addEventListener("close", () => {
  const clip = document.querySelector("#playerVideo");
  clip.pause();
  clip.removeAttribute("src");
  clip.hidden = true;
});

document.querySelector("#addCamera").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const data = Object.fromEntries(new FormData(form));
  const name = data.name.trim();
  const src = data.src.trim();
  const field = form.querySelector("[name=src]");
  const ok = /^https?:\/\//i.test(src) || /^rtsp:\/\//i.test(src);
  field.setCustomValidity(ok ? "" : "Нужен адрес http, https или rtsp");
  if (!field.reportValidity()) return;
  if (document.body.classList.contains("local")) {
    try {
      await api("/api/cameras", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          location: (data.location || "").trim(),
          source_type: "rtsp",
          source_uri: src,
          enabled: true,
          fps: 8,
        }),
      });
      form.reset();
      await reloadConfig();
    } catch (error) {
      alert(error.message);
    }
    return;
  }
  const id = `extra-${Date.now()}`;
  saveExtras(extraCameras().concat([{ id, name, location: (data.location || "").trim(), src }]));
  const rules = watchRules();
  if (!rules.some((rule) => rule.cameraId === id)) rules.push(blankCondition(id));
  const seeded = seededCameras();
  seeded.add(id);
  rememberSeed(seeded);
  saveRules(rules);
  form.reset();
  showPublicCameras();
});

document.querySelector("#extraList").addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.dataset.dropExtra) return;
  const id = target.dataset.dropExtra;
  saveExtras(extraCameras().filter((cam) => cam.id !== id));
  saveRules(watchRules().filter((rule) => rule.cameraId !== id));
  openCalls.delete(id);
  stopRecord(id);
  showPublicCameras();
});

document.querySelector("#endWatch").addEventListener("click", () => {
  if (publicMode) {
    clipsOpen = false;
    heldRecords.clear();
    for (const id of [...recorders.keys()]) stopRecord(id);
    clipsOpen = true;
    saveCases([]);
    openCalls.clear();
    clearClips();
    renderPublicQueue();
    return;
  }
  const hidden = hiddenEvents();
  for (const event of lastEvents) hidden.add(event.id);
  localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden]));
  renderLocalQueue(lastEvents);
});

queueEl.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const caseId = target.dataset.openCase || target.dataset.ack || target.dataset.confirm || target.dataset.false;
  if (target.dataset.openCase) {
    const item = watchCases().find((row) => row.id === target.dataset.openCase);
    if (!item) return;
    const clip = document.querySelector("#playerVideo");
    clip.pause();
    clip.removeAttribute("src");
    clip.hidden = true;
    document.querySelector("#playerTitle").textContent = item.ruleName;
    document.querySelector("#playerMeta").textContent = `${item.cameraName} · ${clock(item.at)}`;
    document.querySelector("#playerImg").hidden = false;
    document.querySelector("#playerImg").src = item.frame || "";
    document.querySelector("#player").showModal();
    if (item.clip) {
      loadClip(item.id).then((blob) => {
        if (!blob) return;
        clip.src = URL.createObjectURL(blob);
        clip.hidden = false;
        document.querySelector("#playerImg").hidden = true;
        clip.play().catch(() => {});
      });
    }
  }
  if (target.dataset.ack) patchCase(caseId, { acked: true });
  if (target.dataset.confirm) patchCase(caseId, { status: "confirmed", acked: true });
  if (target.dataset.false) patchCase(caseId, { status: "false", acked: true });
  const eventId = target.dataset.ackEvent || target.dataset.confirmEvent || target.dataset.falseEvent;
  if (target.dataset.ackEvent) saveReview(eventId, "acked");
  if (target.dataset.confirmEvent) saveReview(eventId, "confirmed");
  if (target.dataset.falseEvent) saveReview(eventId, "false");
  if (eventId) renderLocalQueue(lastEvents);
});

document.addEventListener("pointerdown", () => {
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
});

function paintClock() {
  const node = document.querySelector("#watchClock");
  if (!node) return;
  const now = new Date();
  node.dateTime = now.toISOString();
  node.textContent = now.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

renderPlainRules();
conditionsEl.appendChild(conditionRow());
paintClock();
setInterval(paintClock, 1000);
reloadConfig().catch(() => {}).finally(tick);
setInterval(tick, 1500);
