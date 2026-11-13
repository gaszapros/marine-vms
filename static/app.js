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
  {
    id: "i10-whiskey",
    name: "Шоссе I-10, Уиски-Бэй",
    location: "Уиски-Бэй, Луизиана",
    src: "https://ITSStreamingBR2.dotd.la.gov/public/shr-cam-005.streams/playlist.m3u8",
  },
  {
    id: "i10-henderson",
    name: "Шоссе I-10, Хендерсон",
    location: "Хендерсон, Луизиана",
    src: "https://ITSStreamingBR2.dotd.la.gov/public/shr-cam-007.streams/playlist.m3u8",
  },
  {
    id: "i10-scott",
    name: "Шоссе I-10, Скотт",
    location: "Скотт, Луизиана",
    src: "https://ITSStreamingBR2.dotd.la.gov/public/shr-cam-011.streams/playlist.m3u8",
  },
  {
    id: "i10-lafayette",
    name: "Шоссе I-10, Лафейет",
    location: "Лафейет, Луизиана",
    src: "https://ITSStreamingBR2.dotd.la.gov/public/shr-cam-013.streams/playlist.m3u8",
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
  renderSystem(status);
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
        <option value="heavy">Грузовой транспорт: подсветка камеры</option>
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
      fields.innerHTML = `<p class="hint">Когда в кадре грузовой транспорт, карточка камеры подсвечивается красным. У каждой камеры своя формула размера: фура должна быть крупнее легковых на этой глубине. Запись на судовом компьютере не начинается.</p>`;
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
    openSavedVideo({
      title: item ? item.rule_name : "Запись",
      meta: item ? item.reason : "",
      src: item && item.github_url ? item.github_url : url(`/api/events/${play}/clip`),
    });
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

const FLEET_KEY = "marine-fleet";
const CAMERA_ROLES = [
  { id: "port-bow", title: "Левый борт, нос" },
  { id: "starboard-bow", title: "Правый борт, нос" },
  { id: "port-stern", title: "Левый борт, корма" },
  { id: "starboard-stern", title: "Правый борт, корма" },
];

const PORT_SLOTS = {
  "port-bow": {
    place: "Порт Саванна",
    src: "https://5b5d5bdb0d55e.streamlock.net/live/camera_ga-ports.stream/playlist.m3u8",
  },
  "starboard-bow": {
    place: "Харлинген, вход в порт",
    src: "https://5b8d2cbe62ad6.streamlock.net/live2/ptz52.stream/playlist.m3u8",
  },
  "port-stern": {
    place: "Харлинген, гавань",
    src: "https://584b389d712f9.streamlock.net/live/binnenhaven.stream/playlist.m3u8",
  },
  "starboard-stern": {
    place: "Харлинген, порт",
    src: "https://584b389d712f9.streamlock.net/live/vt.stream/playlist.m3u8",
  },
};

function blankVessel(name, id) {
  const cameras = {};
  const demo = (name || "SHIP Name") === "SHIP Name";
  for (const role of CAMERA_ROLES) {
    const slot = demo ? PORT_SLOTS[role.id] : null;
    cameras[role.id] = { src: slot ? slot.src : "", place: slot ? slot.place : "" };
  }
  return { id: id || `vessel-${Date.now()}`, name: name || "SHIP Name", cameras };
}

function loadFleet() {
  const stored = loadJson(FLEET_KEY, null);
  const fleet = stored && Array.isArray(stored.vessels) && stored.vessels.length
    ? stored
    : { view: "fleet", selected: "vessel-1", vessels: [blankVessel("SHIP Name", "vessel-1")] };
  let renamed = false;
  const named = fleet.vessels.some((vessel) => vessel.name === "SHIP Name");
  if (!named) {
    const vessel = fleet.vessels.find((item) => item.name === "Азов")
      || fleet.vessels.find((item) => item.id === "vessel-1" && item.name === "Судно 1")
      || fleet.vessels.find((item) => item.name === "Судно 1");
    if (vessel) {
      vessel.name = "SHIP Name";
      renamed = true;
    }
  }
  for (const vessel of fleet.vessels) {
    vessel.cameras = vessel.cameras || {};
    const demo = vessel.name === "SHIP Name";
    for (const role of CAMERA_ROLES) {
      const current = vessel.cameras[role.id];
      const src = current && typeof current.src === "string" ? current.src.trim() : "";
      if (!current || typeof current.src !== "string") {
        vessel.cameras[role.id] = demo ? { ...PORT_SLOTS[role.id] } : { src: "", place: "" };
        renamed = true;
      } else if (demo && (!src || src.includes("sausalito_galilee") || src.includes("3diweorv2v1u5y63h") || current.place === "Сосалито, гавань" || current.place === "Порт Торредембарра")) {
        vessel.cameras[role.id] = { ...PORT_SLOTS[role.id] };
        renamed = true;
      } else if (typeof current.place !== "string") {
        current.place = "";
      }
    }
  }
  if (!fleet.vessels.some((vessel) => vessel.id === fleet.selected)) fleet.selected = fleet.vessels[0].id;
  if (fleet.view !== "stand") fleet.view = "fleet";
  if (renamed) saveFleet(fleet);
  return fleet;
}

function saveFleet(fleet) {
  localStorage.setItem(FLEET_KEY, JSON.stringify(fleet));
}

function vesselCameras(vessel) {
  return CAMERA_ROLES.map((role) => ({
    id: `${vessel.id}:${role.id}`,
    role: role.id,
    name: role.title,
    location: vessel.cameras[role.id].place || vessel.name,
    src: vessel.cameras[role.id].src.trim(),
    vesselId: vessel.id,
  }));
}

function allFleetCameras() {
  return loadFleet().vessels.flatMap(vesselCameras);
}

function selectedFleetCameras() {
  const fleet = loadFleet();
  const vessel = fleet.vessels.find((item) => item.id === fleet.selected) || fleet.vessels[0];
  return vessel ? vesselCameras(vessel) : [];
}

function watchView() {
  return loadFleet().view === "stand" ? "stand" : "fleet";
}

function visibleCameras() {
  if (!publicMode || watchView() === "stand") return allPublicCameras();
  return selectedFleetCameras();
}

function blankCondition(cameraId, id) {
  return {
    id: id || `cond-${Date.now()}`,
    name: "Грузовой транспорт",
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
    const rules = allPublicCameras().concat(allFleetCameras()).map((cam) => blankCondition(cam.id, `cond-${cam.id}`));
    for (const cam of allPublicCameras().concat(allFleetCameras())) seeded.add(cam.id);
    rememberSeed(seeded);
    saveRules(rules);
    return rules;
  }
  let changed = false;
  const rules = stored.map((rule) => {
    let next = rule;
    if (!(rule && rule.id && rule.when)) {
      changed = true;
      next = {
        id: `cond-${rule.cameraId || "x"}`,
        name: rule.name || "Грузовой транспорт",
        cameraId: rule.cameraId,
        when: "heavy",
        enabled: rule.enabled !== false,
        record: rule.mode === "call",
      };
    }
    if (next && next.name === "Не легковой автомобиль") {
      next = { ...next, name: "Грузовой транспорт" };
      changed = true;
    }
    return next;
  }).filter((rule) => rule && rule.cameraId);
  for (const cam of allPublicCameras().concat(allFleetCameras())) {
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
  if (!Array.isArray(items)) return [];
  let changed = false;
  const next = items.map((item) => {
    if (!item || item.ruleName !== "Не легковой автомобиль") return item;
    changed = true;
    return { ...item, ruleName: "Грузовой транспорт" };
  });
  if (changed) saveCases(next);
  return next;
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
  const cameras = visibleCameras();
  const ids = new Set(cameras.map((cam) => cam.id));
  const rules = watchRules().filter((rule) => ids.has(rule.cameraId));
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
  refreshQueueNav();
}

function refreshQueueNav() {
  const prev = document.querySelector("#queuePrev");
  const next = document.querySelector("#queueNext");
  const pos = document.querySelector("#queuePos");
  if (!prev || !next || !pos) return;
  const cards = [...queueEl.querySelectorAll(".case")];
  const max = queueEl.scrollWidth - queueEl.clientWidth;
  const idle = cards.length < 2 || max <= 2;
  prev.disabled = idle || queueEl.scrollLeft <= 2;
  next.disabled = idle || queueEl.scrollLeft >= max - 2;
  if (cards.length < 2) {
    pos.textContent = cards.length ? "1" : "";
    return;
  }
  const left = queueEl.scrollLeft;
  const right = left + queueEl.clientWidth;
  let start = cards.findIndex((card) => card.offsetLeft + card.offsetWidth > left + 12);
  if (start < 0) start = cards.length - 1;
  let end = cards.findIndex((card) => card.offsetLeft >= right - 12);
  const last = end === -1 ? cards.length : Math.max(start + 1, end);
  pos.textContent = start + 1 === last ? `${last} из ${cards.length}` : `${start + 1}–${last} из ${cards.length}`;
}

function scrollQueue(direction) {
  const cards = [...queueEl.querySelectorAll(".case")];
  if (!cards.length) return;
  const left = queueEl.scrollLeft;
  const target = direction > 0
    ? cards.find((card) => card.offsetLeft > left + 8)
    : [...cards].reverse().find((card) => card.offsetLeft < left - 8);
  if (!target) return;
  queueEl.scrollTo({ left: target.offsetLeft, behavior: "auto" });
  refreshQueueNav();
}

function renderPublicQueue() {
  const items = watchCases();
  if (!items.length) {
    emptyQueue("Тихо. Камера подсветится, когда включённое условие что-то найдёт. Ролик появится здесь, если у условия включена запись.");
    renderAlarm();
    return;
  }
  queueEl.innerHTML = items.map((item) => {
    const calling = item.status === "open" && !item.acked && openCalls.has(item.cameraId);
    const done = item.status !== "open";
    const label = item.status === "confirmed" ? "подтверждено" : item.status === "false" ? "ложная тревога" : "";
    const note = [item.clip ? "ролик" : "", label].filter(Boolean).join(" · ");
    return `<article class="event case${calling ? " calling" : ""}${done ? " done" : ""}">
      <img src="${item.frame || "data:image/gif;base64,R0lGODlhAQABAAAAACw="}" alt="" />
        <div class="case-copy">
          <strong>${item.ruleName}</strong>
          <span class="case-cam">${item.cameraName}</span>
          <time class="case-time">${clock(item.at)}</time>
          ${note ? `<span class="case-note">${note}</span>` : ""}
        </div>
        <span class="actions">
          <button type="button" data-open-case="${item.id}">Открыть</button>
          ${item.status === "open" && !item.acked ? `<button type="button" data-ack="${item.id}">Принял</button>` : ""}
          <button type="button" data-open-folder="${item.id}" data-folder-kind="case" title="Скачать запись этой карточки">Папка</button>
        </span>
    </article>`;
  }).join("");
  renderAlarm();
  refreshQueueNav();
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
    renderAlarm();
    return;
  }
  const marks = reviews();
  queueEl.innerHTML = visible.map((event) => {
    const mark = marks[String(event.id)] || "";
    const calling = wasReady && !mark && fresh.some((item) => item.id === event.id);
    const done = mark === "confirmed" || mark === "false";
    const label = mark === "confirmed" ? "подтверждено" : mark === "false" ? "ложная тревога" : "";
    const when = clock(event.started_at);
    const note = [label].filter(Boolean).join(" · ");
    return `<article class="event case${calling ? " calling" : ""}${done ? " done" : ""}">
      <img src="${url(`/api/events/${event.id}/thumb`)}" alt="" />
      <div class="case-copy">
        <strong>${event.rule_name}</strong>
        <span class="case-cam">${event.camera_name}</span>
        <time class="case-time">${when}</time>
        ${note ? `<span class="case-note">${note}</span>` : ""}
      </div>
      <span class="actions">
        <button type="button" data-play="${event.id}">Открыть</button>
        ${!mark ? `<button type="button" data-ack-event="${event.id}">Принял</button>` : ""}
        <button type="button" data-open-folder="${event.id}" data-folder-kind="event" title="Открыть файл этой записи">Папка</button>
      </span>
    </article>`;
  }).join("");
  renderAlarm();
  refreshQueueNav();
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
const clipWaiters = new Map();
let playerCaseId = null;
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

function canvasWatch(video) {
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 360;
  const context = canvas.getContext("2d");
  const stream = canvas.captureStream(8);
  const timer = setInterval(() => {
    if (video.readyState >= 2) context.drawImage(video, 0, 0, canvas.width, canvas.height);
  }, 125);
  return {
    stream,
    stop() { clearInterval(timer); },
  };
}

function captureWatch(video) {
  try {
    const direct = video.captureStream ? video.captureStream() : null;
    if (direct && direct.getVideoTracks().length) return { stream: direct, stop() {} };
  } catch (error) {}
  return canvasWatch(video);
}

function stopRecord(cameraId) {
  const job = recorders.get(cameraId);
  if (!job) return;
  recorders.delete(cameraId);
  clearTimeout(job.timer);
  openCalls.delete(cameraId);
  if (job.recorder && job.recorder.state === "recording") job.recorder.stop();
  else if (job.capture) job.capture.stop();
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
  const mime = window.MediaRecorder && (MediaRecorder.isTypeSupported("video/webm;codecs=vp8") ? "video/webm;codecs=vp8" : "video/webm");
  const begin = (capture) => {
    if (!capture || !capture.stream || !window.MediaRecorder || video.readyState < 2) {
      if (capture) capture.stop();
      return null;
    }
    let recorder;
    try {
      recorder = new MediaRecorder(capture.stream, { mimeType: mime, videoBitsPerSecond: 700000 });
    } catch {
      capture.stop();
      return null;
    }
    const chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size) chunks.push(event.data);
    };
    recorder.onstop = () => {
      capture.stop();
      const blob = new Blob(chunks, { type: mime });
      if (!clipsOpen || !blob.size) return;
      item.clip = true;
      saveClip(item.id, blob).then(() => patchCase(item.id, { clip: true })).catch(() => {});
      const waiting = clipWaiters.get(item.id);
      if (waiting) {
        clipWaiters.delete(item.id);
        waiting(blob);
      }
    };
    try {
      recorder.start(500);
    } catch {
      capture.stop();
      return null;
    }
    return recorder;
  };
  let capture = null;
  try {
    capture = captureWatch(video);
  } catch {
    capture = null;
  }
  let recorder = begin(capture);
  if (!recorder) {
    try {
      capture = canvasWatch(video);
    } catch {
      capture = null;
    }
    recorder = begin(capture);
  }
  if (!recorder) {
    finishFrame();
    return;
  }
  const started = Date.now();
  const timer = setTimeout(() => stopRecord(cam.id), 20000);
  recorders.set(cam.id, { recorder, timer, capture, started, item });
  finishFrame();
}

function noteRecord(cam, rule, active, video) {
  const job = recorders.get(cam.id);
  if (!active || !rule) {
    if (job && Date.now() - job.started < 6000) {
      clearTimeout(job.timer);
      job.timer = setTimeout(() => stopRecord(cam.id), 6000 - (Date.now() - job.started));
      return;
    }
    stopRecord(cam.id);
    heldRecords.delete(cam.id);
    return;
  }
  if (heldRecords.has(cam.id)) {
    if (job) {
      clearTimeout(job.timer);
      job.timer = setTimeout(() => stopRecord(cam.id), Math.max(0, job.started + 20000 - Date.now()));
    }
    return;
  }
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
    paintWatchChrome();
  } catch (error) {
    console.error(error);
    document.body.classList.remove("local");
    if (!publicMode) {
      publicMode = true;
      showPublicCameras();
    }
    renderSystem(null);
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
  if (card.classList.contains("slot-wait")) {
    const input = document.querySelector(`#vesselSlots [name="${card.dataset.role}"]`);
    if (input) input.focus();
    return;
  }
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
  for (const cam of visibleCameras()) {
    const card = document.createElement("article");
    card.className = "card";
    card.dataset.camera = cam.id;
    card.dataset.role = cam.role || "";
    const header = `<header><div><strong></strong><small class="place"></small></div><span class="signal"></span></header>`;
    if (!cam.src) {
      card.classList.add("slot-wait");
      card.innerHTML = `<div class="stage slot-empty"><p>Нет потока</p></div>${header}`;
      markCameraCard(card, cam.name);
      card.setAttribute("aria-label", `Подключить: ${cam.name}`);
      const place = card.querySelector(".place");
      if (place) place.textContent = cam.location || "";
      const signal = card.querySelector(".signal");
      if (signal) signal.textContent = "нет потока";
      wall.appendChild(card);
      continue;
    }
    card.innerHTML = `<div class="stage"><video muted autoplay playsinline></video></div>${header}`;
    card.dataset.kind = "hls";
    card.dataset.stream = cam.src;
    markCameraCard(card, cam.name);
    const place = card.querySelector(".place");
    if (place) place.textContent = cam.location || "";
    wall.appendChild(card);
    const video = card.querySelector("video");
    attachStream(video, cam.src);
    watches.push({
      cameraId: cam.id,
      video,
      live() {
        return watchRules().some((rule) => rule.cameraId === cam.id && rule.enabled && rule.when === "heavy");
      },
      onMarks(count) {
        const matched = watchRules().filter((rule) => rule.cameraId === cam.id && rule.enabled && rule.when === "heavy" && count > 0);
        card.classList.toggle("alert", matched.length > 0);
        const rule = matched[0];
        noteRecord(cam, rule || null, Boolean(rule), video);
      },
      onError() {
        const slot = card.querySelector(".signal");
        if (slot) slot.textContent = "нет сигнала";
      },
    });
  }
  if (window.HeavyWatch) HeavyWatch.start(watches);
  paintWatchChrome();
  renderFleet();
  renderExtraList();
  renderPlainRules();
  renderPublicQueue();
  if (publicMode) renderSystem(null);
}

function paintWatchChrome() {
  const stand = !publicMode || watchView() === "stand";
  document.querySelector("#fleetBlock").hidden = stand;
  document.querySelector("#standTools").hidden = !stand;
  wall.classList.toggle("fleet", publicMode && !stand);
}

function renderFleet() {
  const fleet = loadFleet();
  const list = document.querySelector("#fleetList");
  list.innerHTML = fleet.vessels.map((vessel) => `<li class="${vessel.id === fleet.selected ? "on" : ""}">
      <button type="button" class="pick" data-pick-vessel="${escapeHtml(vessel.id)}">${escapeHtml(vessel.name)}</button>
      ${fleet.vessels.length > 1 ? `<button type="button" data-drop-vessel="${escapeHtml(vessel.id)}">Убрать</button>` : ""}
    </li>`).join("");
  const vessel = fleet.vessels.find((item) => item.id === fleet.selected) || fleet.vessels[0];
  const form = document.querySelector("#vesselSlots");
  if (!vessel) {
    form.innerHTML = "";
    return;
  }
  form.innerHTML = CAMERA_ROLES.map((role) => `<label>${escapeHtml(role.title)}
      <input name="${role.id}" value="${escapeHtml(vessel.cameras[role.id].src)}" placeholder="https://…/playlist.m3u8" />
    </label>`).join("") + `<button type="submit">Сохранить потоки</button>`;
}

function showView(name) {
  document.querySelector("#watch").hidden = name !== "watch";
  document.querySelector("#setup").hidden = name !== "setup";
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

document.querySelector("#showSetup").addEventListener("click", () => showView("setup"));

const DOCK_KEY = "marine-online-dock";
const stageRow = document.querySelector(".stage-row");
const foldDock = document.querySelector("#foldDock");
const dock = document.querySelector("#dock");
const dockMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

function setDockFolded(folded, animate = true) {
  const motion = animate && !dockMotion.matches;
  if (!motion) stageRow.classList.add("no-motion");
  stageRow.classList.toggle("folded", folded);
  document.querySelector(".top").classList.toggle("dock-folded", folded);
  if (!folded || !motion) stageRow.classList.toggle("settled", folded);
  foldDock.setAttribute("aria-expanded", folded ? "false" : "true");
  foldDock.textContent = folded ? "Настройки" : "Свернуть";
  localStorage.setItem(DOCK_KEY, folded ? "1" : "0");
  if (!motion) requestAnimationFrame(() => stageRow.classList.remove("no-motion"));
}

dock.addEventListener("transitionend", (event) => {
  if (event.target !== dock || event.propertyName !== "width") return;
  if (stageRow.classList.contains("folded")) stageRow.classList.add("settled");
});

foldDock.addEventListener("click", () => {
  setDockFolded(!stageRow.classList.contains("folded"));
});
setDockFolded(localStorage.getItem(DOCK_KEY) === "1", false);

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
  const cam = visibleCameras()[0];
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
  if (clip.dataset.blob === "1" && clip.src.startsWith("blob:")) URL.revokeObjectURL(clip.src);
  clip.dataset.blob = "";
  clip.removeAttribute("src");
  clip.load();
  clip.hidden = true;
  const img = document.querySelector("#playerImg");
  img.hidden = true;
  img.removeAttribute("src");
  playerCaseId = null;
});

document.querySelector("#addVessel").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = new FormData(event.target).get("name").trim();
  if (!name) return;
  const fleet = loadFleet();
  const vessel = blankVessel(name);
  fleet.vessels.push(vessel);
  fleet.selected = vessel.id;
  fleet.view = "fleet";
  saveFleet(fleet);
  event.target.reset();
  showPublicCameras();
});

document.querySelector("#fleetList").addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target.closest("button") : null;
  if (!(target instanceof HTMLElement)) return;
  const fleet = loadFleet();
  if (target.dataset.pickVessel) {
    fleet.selected = target.dataset.pickVessel;
    saveFleet(fleet);
    showPublicCameras();
  }
  if (target.dataset.dropVessel && fleet.vessels.length > 1) {
    const id = target.dataset.dropVessel;
    fleet.vessels = fleet.vessels.filter((vessel) => vessel.id !== id);
    if (!fleet.vessels.some((vessel) => vessel.id === fleet.selected)) fleet.selected = fleet.vessels[0].id;
    saveFleet(fleet);
    const prefix = `${id}:`;
    saveRules(watchRules().filter((rule) => !String(rule.cameraId).startsWith(prefix)));
    showPublicCameras();
  }
});

document.querySelector("#vesselSlots").addEventListener("submit", (event) => {
  event.preventDefault();
  const fleet = loadFleet();
  const vessel = fleet.vessels.find((item) => item.id === fleet.selected);
  if (!vessel) return;
  const data = new FormData(event.target);
  for (const role of CAMERA_ROLES) {
    vessel.cameras[role.id].src = String(data.get(role.id) || "").trim();
  }
  saveFleet(fleet);
  showPublicCameras();
});

document.querySelector("#openStand").addEventListener("click", () => {
  const fleet = loadFleet();
  fleet.view = "stand";
  saveFleet(fleet);
  showPublicCameras();
});

document.querySelector("#openFleet").addEventListener("click", () => {
  const fleet = loadFleet();
  fleet.view = "fleet";
  saveFleet(fleet);
  showPublicCameras();
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

function recordingName(camera, at, ext, id) {
  const date = new Date(at || "");
  const stamp = Number.isNaN(date.getTime())
    ? "запись"
    : date.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "_");
  const who = String(camera || "камера").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 48) || "камера";
  const tail = String(id || "").replace(/[\\/:*?"<>|]+/g, "").slice(-12);
  return `${who} ${stamp}${tail ? ` ${tail}` : ""}.${ext}`;
}

function saveFile(blob, name) {
  const link = document.createElement("a");
  const href = URL.createObjectURL(blob);
  link.href = href;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1500);
}

function openCaseRecording(id) {
  const item = watchCases().find((row) => row.id === id);
  if (!item) return;
  const clip = item.clip ? loadClip(item.id) : Promise.resolve(null);
  clip.then(async (blob) => {
    if (blob) {
      const ext = /mp4/i.test(blob.type) ? "mp4" : "webm";
      saveFile(blob, recordingName(item.cameraName, item.at, ext, item.id));
      return;
    }
    if (!item.frame) return;
    const frame = await fetch(item.frame).then((response) => response.blob());
    saveFile(frame, recordingName(item.cameraName, item.at, "jpg", item.id));
  }).catch(() => {});
}

function openEventRecording(id) {
  const event = lastEvents.find((row) => String(row.id) === String(id));
  const direct = event && event.github_url;
  if (!publicMode) {
    fetch("/api/recordings/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event_id: Number(id) }),
    }).then(async (response) => {
      if (!response.ok) {
        if (direct) window.open(direct, "_blank", "noopener");
        return;
      }
      const body = await response.json();
      if (body.url) window.open(body.url, "_blank", "noopener");
    }).catch(() => {
      if (direct) window.open(direct, "_blank", "noopener");
    });
    return;
  }
  if (direct) window.open(direct, "_blank", "noopener");
}

function openSavedVideo({ title, meta, src, blob }) {
  const clip = document.querySelector("#playerVideo");
  const img = document.querySelector("#playerImg");
  clip.pause();
  if (clip.dataset.blob === "1" && clip.src.startsWith("blob:")) URL.revokeObjectURL(clip.src);
  clip.dataset.blob = "";
  clip.removeAttribute("src");
  clip.hidden = true;
  img.hidden = true;
  img.removeAttribute("src");
  document.querySelector("#playerTitle").textContent = title || "Запись";
  document.querySelector("#playerMeta").textContent = meta || "";
  document.querySelector("#player").showModal();
  if (blob) {
    clip.src = URL.createObjectURL(blob);
    clip.dataset.blob = "1";
  } else if (src) {
    clip.src = src;
  } else {
    return;
  }
  clip.hidden = false;
  clip.play().catch(() => {});
}

function openSavedCase(item) {
  const clip = document.querySelector("#playerVideo");
  const img = document.querySelector("#playerImg");
  clip.pause();
  if (clip.dataset.blob === "1" && clip.src.startsWith("blob:")) URL.revokeObjectURL(clip.src);
  clip.dataset.blob = "";
  clip.removeAttribute("src");
  clip.hidden = true;
  img.hidden = true;
  img.removeAttribute("src");
  playerCaseId = item.id;
  document.querySelector("#playerTitle").textContent = item.ruleName;
  document.querySelector("#playerMeta").textContent = `${item.cameraName} · ${clock(item.at)}`;
  document.querySelector("#player").showModal();
  const playBlob = (blob) => {
    if (playerCaseId !== item.id || !blob) return;
    clip.src = URL.createObjectURL(blob);
    clip.dataset.blob = "1";
    clip.hidden = false;
    img.hidden = true;
    clip.play().catch(() => {});
  };
  if (item.clip) {
    loadClip(item.id).then((blob) => {
      if (blob) playBlob(blob);
      else if (playerCaseId === item.id && item.frame) {
        img.hidden = false;
        img.src = item.frame;
      }
    });
    return;
  }
  const job = recorders.get(item.cameraId);
  if (job && job.item && job.item.id === item.id) {
    clipWaiters.set(item.id, playBlob);
    stopRecord(item.cameraId);
    return;
  }
  if (item.frame) {
    img.hidden = false;
    img.src = item.frame;
  }
}

function onQueueClick(event) {
  const target = event.target instanceof Element ? event.target.closest("button") : null;
  if (!(target instanceof HTMLElement)) return;
  if ("openFolder" in target.dataset) {
    if (target.dataset.folderKind === "event") openEventRecording(target.dataset.openFolder);
    else openCaseRecording(target.dataset.openFolder);
    return;
  }
  const caseId = target.dataset.openCase || target.dataset.ack || target.dataset.confirm || target.dataset.false;
  if (target.dataset.openCase) {
    const item = watchCases().find((row) => row.id === target.dataset.openCase);
    if (!item) return;
    openSavedCase(item);
  }
  if (target.dataset.ack) patchCase(caseId, { acked: true });
  if (target.dataset.confirm) patchCase(caseId, { status: "confirmed", acked: true });
  if (target.dataset.false) patchCase(caseId, { status: "false", acked: true });
  const eventId = target.dataset.ackEvent || target.dataset.confirmEvent || target.dataset.falseEvent;
  if (target.dataset.ackEvent) saveReview(eventId, "acked");
  if (target.dataset.confirmEvent) saveReview(eventId, "confirmed");
  if (target.dataset.falseEvent) saveReview(eventId, "false");
  if (eventId) renderLocalQueue(lastEvents);
}
queueEl.addEventListener("click", onQueueClick);
document.querySelector("#alarmZone").addEventListener("click", onQueueClick);
document.querySelector("#queuePrev").addEventListener("click", () => scrollQueue(-1));
document.querySelector("#queueNext").addEventListener("click", () => scrollQueue(1));
queueEl.addEventListener("scroll", refreshQueueNav, { passive: true });
let queueWheelSnap = 0;
queueEl.addEventListener("wheel", (event) => {
  if (queueEl.scrollWidth <= queueEl.clientWidth + 2) return;
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  if (!delta) return;
  event.preventDefault();
  queueEl.style.scrollSnapType = "none";
  queueEl.scrollLeft += delta;
  clearTimeout(queueWheelSnap);
  queueWheelSnap = setTimeout(() => { queueEl.style.scrollSnapType = ""; }, 140);
}, { passive: false });
let queueDrag = null;
queueEl.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || event.target.closest("button, a")) return;
  queueDrag = { id: event.pointerId, x: event.clientX, left: queueEl.scrollLeft, moved: false };
  queueEl.setPointerCapture(event.pointerId);
});
queueEl.addEventListener("pointermove", (event) => {
  if (!queueDrag || event.pointerId !== queueDrag.id) return;
  const dx = event.clientX - queueDrag.x;
  if (Math.abs(dx) > 4) {
    queueDrag.moved = true;
    queueEl.classList.add("dragging");
  }
  queueEl.scrollLeft = queueDrag.left - dx;
});
function endQueueDrag(event) {
  if (!queueDrag || event.pointerId !== queueDrag.id) return;
  const moved = queueDrag.moved;
  queueDrag = null;
  queueEl.classList.remove("dragging");
  if (moved) queueEl.dataset.dragged = "1";
}
queueEl.addEventListener("pointerup", endQueueDrag);
queueEl.addEventListener("pointercancel", endQueueDrag);
queueEl.addEventListener("click", (event) => {
  if (queueEl.dataset.dragged !== "1") return;
  delete queueEl.dataset.dragged;
  event.preventDefault();
  event.stopPropagation();
}, true);

document.addEventListener("pointerdown", () => {
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
});

function setPill(name, text, state) {
  const node = document.querySelector(`[data-sys="${name}"]`);
  if (!node) return;
  node.dataset.state = state;
  const value = node.querySelector("b");
  if (value) value.textContent = text;
}

function renderSystem(status) {
  if (!status) {
    const tiles = [...wall.querySelectorAll(".card")];
    const lost = tiles.filter((card) => (card.querySelector(".signal")?.textContent || "").includes("нет")).length;
    const live = Math.max(0, tiles.length - lost);
    setPill("link", "Нет", "warn");
    setPill("watch", "Берег", "idle");
    setPill("cams", tiles.length ? `${live}/${tiles.length}` : "0", lost ? "bad" : tiles.length ? "ok" : "idle");
    setPill("rec", recorders.size ? String(recorders.size) : "0", recorders.size ? "warn" : "idle");
    return;
  }
  const cams = (status.cameras || []).filter((cam) => cam.enabled);
  const lost = cams.filter((cam) => cam.error).length;
  const recording = cams.filter((cam) => cam.recording).length;
  setPill("link", "На связи", "ok");
  setPill("watch", status.armed ? "Принята" : "Снята", status.armed ? "ok" : "warn");
  setPill("cams", cams.length ? `${cams.length - lost}/${cams.length}` : "0", lost ? "bad" : cams.length ? "ok" : "idle");
  setPill("rec", recording ? String(recording) : "0", recording ? "warn" : "ok");
}

function renderAlarm() {
  const zone = document.querySelector("#alarmZone");
  if (!zone) return;
  if (publicMode) {
    const items = watchCases().filter((item) => item.status === "open" && !item.acked);
    const first = items[0];
    paintAlarm(zone, first && {
      title: first.ruleName,
      meta: `${first.cameraName} · ${clock(first.at)}`,
      more: items.length - 1,
      actions: `<button type="button" data-ack="${escapeHtml(first.id)}">Принял</button><button type="button" data-open-case="${escapeHtml(first.id)}">Открыть</button>`,
    });
    return;
  }
  const enabled = new Set(cameras.filter((cam) => cam.enabled).map((cam) => cam.id));
  const hidden = hiddenEvents();
  const marks = reviews();
  const items = lastEvents.filter((event) => enabled.has(event.camera_id) && !hidden.has(event.id) && !marks[String(event.id)]);
  const first = items[0];
  paintAlarm(zone, first && {
    title: first.rule_name,
    meta: `${first.camera_name} · ${first.started_at}`,
    more: items.length - 1,
    actions: `<button type="button" data-ack-event="${escapeHtml(first.id)}">Принял</button><button type="button" data-play="${escapeHtml(first.id)}">Открыть</button>`,
  });
}

function paintAlarm(zone, row) {
  zone.classList.toggle("hot", Boolean(row));
  if (!row) {
    zone.innerHTML = `<p class="alarm-quiet">Критических тревог нет</p>`;
    return;
  }
  const count = row.more > 0 ? ` · ${row.more + 1}` : "";
  zone.innerHTML = `<div class="alarm-live">
    <span class="alarm-flag">Критическая${count}</span>
    <div class="alarm-copy"><strong>${escapeHtml(row.title || "")}</strong><small>${escapeHtml(row.meta || "")}</small></div>
    ${row.more > 0 ? `<span class="alarm-more">ещё ${row.more}</span>` : ""}
    <span class="actions">${row.actions}</span>
  </div>`;
}

function applyLight(mode) {
  const night = mode === "night";
  if (night) document.documentElement.dataset.light = "night";
  else delete document.documentElement.dataset.light;
  document.querySelector("#lightDay").setAttribute("aria-pressed", night ? "false" : "true");
  document.querySelector("#lightNight").setAttribute("aria-pressed", night ? "true" : "false");
  try { localStorage.setItem("marine-light", night ? "night" : "day"); } catch (error) {}
}

function paintClock() {
  const now = new Date();
  const stamp = { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" };
  const utc = document.querySelector("#clockUtc");
  const local = document.querySelector("#clockLocal");
  if (utc) {
    utc.dateTime = now.toISOString();
    utc.querySelector("b").textContent = now.toLocaleTimeString("en-GB", { ...stamp, timeZone: "UTC" });
  }
  if (local) {
    local.dateTime = now.toISOString();
    local.querySelector("b").textContent = now.toLocaleTimeString("ru-RU", stamp);
  }
}

const topBar = document.querySelector(".top");
const watchPane = document.querySelector("#watch");
const expandHeaderBtn = document.querySelector("#expandHeader");
const phoneQuery = window.matchMedia("(max-width: 720px)");
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const FOLD_MS = 380;
let headerPin = false;
let headerPinAt = 0;
let headerPhase = "open";
let foldTimer = 0;

function syncExpandButton() {
  if (!expandHeaderBtn || !topBar) return;
  const folded = topBar.classList.contains("is-compact") || topBar.classList.contains("is-folding");
  expandHeaderBtn.setAttribute("aria-expanded", folded ? "false" : "true");
}

function flipHeader(change) {
  if (!topBar || reduceMotion.matches) {
    change();
    return;
  }
  const from = topBar.getBoundingClientRect().height;
  topBar.style.overflow = "hidden";
  topBar.style.height = from + "px";
  change();
  topBar.style.height = "auto";
  const to = topBar.getBoundingClientRect().height;
  topBar.style.height = from + "px";
  if (Math.abs(from - to) < 2) {
    topBar.style.height = "";
    topBar.style.overflow = "";
    return;
  }
  void topBar.offsetHeight;
  requestAnimationFrame(() => {
    topBar.style.transition = "height .34s ease";
    topBar.style.height = to + "px";
  });
  let settled = false;
  const done = (event) => {
    if (settled) return;
    if (event && (event.target !== topBar || event.propertyName !== "height")) return;
    settled = true;
    topBar.style.height = "";
    topBar.style.transition = "";
    topBar.style.overflow = "";
    topBar.removeEventListener("transitionend", done);
  };
  topBar.addEventListener("transitionend", done);
  setTimeout(done, 420);
}

function finishFold(event) {
  const sys = topBar && topBar.querySelector(".sys");
  if (event && sys && (event.target !== sys || event.propertyName !== "max-height")) return;
  if (headerPhase !== "folding" || !topBar) return;
  clearTimeout(foldTimer);
  if (sys) sys.removeEventListener("transitionend", finishFold);
  flipHeader(() => {
    if (!topBar || headerPhase !== "folding") return;
    topBar.classList.add("is-compact");
    headerPhase = "compact";
    syncExpandButton();
  });
}

function beginFold() {
  if (!topBar || headerPhase === "folding" || headerPhase === "compact") return;
  clearTimeout(foldTimer);
  headerPhase = "folding";
  topBar.classList.add("is-folding");
  syncExpandButton();
  const sys = topBar.querySelector(".sys");
  if (reduceMotion.matches || !sys) {
    finishFold();
    return;
  }
  sys.addEventListener("transitionend", finishFold);
  foldTimer = setTimeout(finishFold, FOLD_MS + 80);
}

function beginOpen() {
  if (!topBar || headerPhase === "open") return;
  clearTimeout(foldTimer);
  const sys = topBar.querySelector(".sys");
  if (sys) sys.removeEventListener("transitionend", finishFold);
  const wasCompact = topBar.classList.contains("is-compact");
  headerPhase = "open";
  if (wasCompact) {
    flipHeader(() => {
      topBar.classList.remove("is-compact", "is-folding");
      syncExpandButton();
    });
    return;
  }
  topBar.classList.remove("is-compact");
  if (!reduceMotion.matches) void topBar.offsetHeight;
  topBar.classList.remove("is-folding");
  syncExpandButton();
}

function syncCompactHeader() {
  if (!topBar) return;
  if (!phoneQuery.matches) {
    headerPin = false;
    beginOpen();
    return;
  }
  const scrolled = Boolean(watchPane && watchPane.scrollTop > 24);
  if (!scrolled) headerPin = false;
  else if (headerPin && watchPane.scrollTop > headerPinAt + 80) headerPin = false;
  if (scrolled && !headerPin) beginFold();
  else beginOpen();
}

if (expandHeaderBtn) {
  expandHeaderBtn.addEventListener("click", () => {
    headerPin = true;
    headerPinAt = watchPane ? watchPane.scrollTop : 0;
    beginOpen();
  });
}

if (watchPane) watchPane.addEventListener("scroll", syncCompactHeader, { passive: true });
phoneQuery.addEventListener("change", syncCompactHeader);
syncCompactHeader();

applyLight(document.documentElement.dataset.light === "night" ? "night" : "day");
document.querySelector("#lightDay").addEventListener("click", () => applyLight("day"));
document.querySelector("#lightNight").addEventListener("click", () => applyLight("night"));

renderPlainRules();
conditionsEl.appendChild(conditionRow());
paintClock();
setInterval(paintClock, 1000);
reloadConfig().catch(() => {}).finally(tick);
setInterval(tick, 1500);
