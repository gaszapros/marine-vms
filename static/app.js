const wall = document.querySelector("#wall");
const instruments = document.querySelector("#instruments");
const armBtn = document.querySelector("#armBtn");
const why = document.querySelector("#why");
const eventsEl = document.querySelector("#events");
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
    id: "salinas",
    name: "Перекрёсток Салинас",
    location: "Market St",
    src: "https://wzmedia.dot.ca.gov/D5/183atMarketSt.stream/playlist.m3u8",
  },
  {
    id: "sloat",
    name: "Шоссе у Слоат",
    location: "Sloat Ave",
    src: "https://wzmedia.dot.ca.gov/D5/1atSloatAve.stream/playlist.m3u8",
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

function instrument(label, value) {
  return `<div class="instrument"><span>${label}</span><b>${value}</b></div>`;
}

function ensureCard(cam) {
  let card = cards.get(cam.id);
  if (card) return card;
  card = document.createElement("article");
  card.className = "card";
  card.innerHTML = `
    <img alt="" />
    <header><strong></strong><span class="dot"></span></header>
    <div class="meta"><span class="motion"></span><span class="fps"></span></div>`;
  card.querySelector("img").src = url(`/api/cameras/${cam.id}/live`);
  wall.appendChild(card);
  cards.set(cam.id, card);
  return card;
}

function renderStatus(status) {
  const tel = status.telemetry || {};
  const speed = Number(tel.speed_kn || 0);
  instruments.innerHTML = [
    instrument("Скорость", `${speed.toFixed(1)} уз`),
    instrument("Курс", `${Math.round(tel.heading || 0)}°`),
    instrument("Позиция", `${Number(tel.lat || 0).toFixed(3)}, ${Number(tel.lon || 0).toFixed(3)}`),
    instrument("Режим", tel.mode || "manual"),
  ].join("");
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
  why.innerHTML = "";
  for (const cam of status.cameras) {
    if (!cam.enabled) continue;
    seen.add(cam.id);
    const card = ensureCard(cam);
    card.classList.toggle("rec", cam.recording);
    card.querySelector("strong").textContent = `${cam.name} · ${cam.location || ""}`;
    card.querySelector(".dot").textContent = cam.recording ? "REC" : cam.error || "LIVE";
    const red = cam.color_ratio ? ` · красный ${(cam.color_ratio * 100).toFixed(1)}%` : "";
    card.querySelector(".motion").textContent = `движение ${(cam.motion_ratio * 100).toFixed(1)}%${red}`;
    card.querySelector(".fps").textContent = `${cam.fps.toFixed(1)} к/с`;
    const item = document.createElement("li");
    const active = cam.matched.length ? cam.matched.join(", ") : cam.rule_name;
    item.textContent = cam.recording
      ? `${cam.name}: пишется — ${active || "правило"}`
      : `${cam.name}: ${cam.matched.length ? "условие есть, пауза после клипа" : "ждёт условие"}`;
    why.appendChild(item);
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
      return `<li><span>${rule.name} · ${cam ? cam.name : "все"} · ${rule.match_mode}</span>
        <span><button type="button" data-edit-rule="${rule.id}">править</button>
        <button type="button" data-del-rule="${rule.id}">убрать</button></span></li>`;
    })
    .join("");
}

let eventStamp = "";

function renderEvents(items) {
  const stamp = items.map((event) => `${event.id}:${event.ended_at || "open"}:${event.github_url ? 1 : 0}`).join("|");
  if (stamp === eventStamp) return;
  eventStamp = stamp;
  if (!items.length) {
    eventsEl.innerHTML = `<p class="hint">Клипов ещё нет. На стоянке трап и палуба дадут запись в течение полуминуты.</p>`;
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

async function tick() {
  try {
    const status = await api("/api/status");
    if (publicMode) {
      publicMode = false;
      stopPublicPlayers();
      wall.innerHTML = "";
      cards.clear();
    }
    renderStatus(status);
    renderEvents(await api("/api/events"));
  } catch (error) {
    console.error(error);
    if (!publicMode) {
      publicMode = true;
      showPublicCameras();
    }
  }
}

function stopPublicPlayers() {
  for (const player of publicPlayers) player.destroy();
  publicPlayers.length = 0;
}

function attachStream(video, src) {
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = src;
    video.play().catch(() => {});
    return;
  }
  if (window.Hls && Hls.isSupported()) {
    const player = new Hls();
    player.loadSource(src);
    player.attachMedia(video);
    player.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
    publicPlayers.push(player);
  }
}

function showPublicCameras() {
  stopPublicPlayers();
  cards.clear();
  wall.innerHTML = "";
  why.innerHTML = "";
  instruments.innerHTML = instrument("Режим", "прямой эфир");
  for (const cam of PUBLIC_CAMERAS) {
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `
      <video muted autoplay playsinline></video>
      <header><strong></strong><span class="dot">LIVE</span></header>
      <div class="meta"><span class="motion">прямой эфир</span><span class="fps"></span></div>`;
    card.querySelector("strong").textContent = `${cam.name} · ${cam.location}`;
    wall.appendChild(card);
    attachStream(card.querySelector("video"), cam.src);
    const item = document.createElement("li");
    item.textContent = `${cam.name}: прямой эфир`;
    why.appendChild(item);
  }
  eventsEl.innerHTML = `<p class="hint">Журнал и запись ведутся службой на компьютере. Здесь камеры идут в прямом эфире.</p>`;
}

conditionsEl.appendChild(conditionRow());
reloadConfig().catch(() => {}).finally(tick);
setInterval(tick, 1500);
