/* Контур наблюдения: класс, трек, движение и события по кадру. */
window.Sense = (() => {
  const cameras = new Map();
  const COOL = 25000;

  function iou(left, right) {
    const x1 = Math.max(left.x, right.x);
    const y1 = Math.max(left.y, right.y);
    const x2 = Math.min(left.x + left.w, right.x + right.w);
    const y2 = Math.min(left.y + left.h, right.y + right.h);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const union = left.w * left.h + right.w * right.h - inter;
    return union <= 0 ? 0 : inter / union;
  }

  function blank(id) {
    return { id, tracks: [], next: 1, counts: [], lastAnomaly: 0, sent: new Map() };
  }

  function allow(state, key, now) {
    const at = state.sent.get(key) || 0;
    if (now - at < COOL) return false;
    state.sent.set(key, now);
    return true;
  }

  function motionOf(track) {
    const trail = track.trail;
    if (trail.length < 3) return null;
    const first = trail[0];
    const last = trail[trail.length - 1];
    const dt = Math.max(0.2, (last.t - first.t) / 1000);
    const dx = (last.x - first.x) / dt;
    const dy = (last.y - first.y) / dt;
    const speed = Math.hypot(dx, dy);
    const grown = last.h > first.h * 1.18;
    const shrunk = last.h < first.h * 0.82;
    let character = "проходит";
    if (speed < 0.015) character = "стоит";
    else if (grown) character = "приближается";
    else if (shrunk) character = "удаляется";
    let direction = "на месте";
    if (speed >= 0.015) {
      const horizontal = Math.abs(dx) >= Math.abs(dy);
      if (horizontal) direction = dx > 0 ? "вправо" : "влево";
      else direction = dy > 0 ? "вниз" : "вверх";
      if (Math.abs(dx) > 0.02 && Math.abs(dy) > 0.02) {
        direction = `${dx > 0 ? "вправо" : "влево"}-${dy > 0 ? "вниз" : "вверх"}`;
      }
    }
    const pace = speed < 0.04 ? "медленно" : speed < 0.12 ? "ровно" : "быстро";
    return { character, direction, pace, speed, dx, dy };
  }

  function event(track, cam, now, kind, title, severity) {
    return {
      id: `ev-${now}-${track.id}-${kind}`,
      at: now,
      kind,
      title,
      severity,
      category: track.category,
      label: track.label,
      trackId: track.id,
      cameraId: cam.id,
      cameraName: cam.name,
      vesselId: cam.vesselId || "",
      vesselName: cam.vesselName || "",
    };
  }

  function observe(cam, objects, now) {
    const state = cameras.get(cam.id) || blank(cam.id);
    cameras.set(cam.id, state);
    const used = new Set();
    for (const track of state.tracks) {
      let best = -1;
      let bestScore = 0.2;
      objects.forEach((obj, index) => {
        if (used.has(index) || obj.category !== track.category) return;
        const score = iou(track, obj);
        if (score > bestScore) {
          bestScore = score;
          best = index;
        }
      });
      if (best < 0) continue;
      used.add(best);
      const obj = objects[best];
      track.x = obj.x;
      track.y = obj.y;
      track.w = obj.w;
      track.h = obj.h;
      track.label = obj.label;
      track.seen = now;
      track.hits += 1;
      track.trail.push({ x: obj.x + obj.w / 2, y: obj.y + obj.h / 2, h: obj.h, t: now });
      if (track.trail.length > 12) track.trail.shift();
    }
    objects.forEach((obj, index) => {
      if (used.has(index)) return;
      state.tracks.push({
        id: state.next,
        category: obj.category,
        label: obj.label,
        x: obj.x,
        y: obj.y,
        w: obj.w,
        h: obj.h,
        born: now,
        seen: now,
        hits: 1,
        trail: [{ x: obj.x + obj.w / 2, y: obj.y + obj.h / 2, h: obj.h, t: now }],
        told: {},
      });
      state.next += 1;
    });
    state.tracks = state.tracks.filter((track) => now - track.seen < 1800);
    const events = [];
    for (const track of state.tracks) {
      const motion = motionOf(track);
      track.motion = motion;
      if (track.hits === 2 && allow(state, `${track.id}:object`, now)) {
        events.push(event(track, cam, now, "object", `Объект ${track.id}: ${track.label}`, "info"));
      }
      if (track.hits >= 4 && motion && !track.told.motion && allow(state, `${track.id}:motion`, now)) {
        track.told.motion = true;
        events.push(event(
          track,
          cam,
          now,
          "motion",
          `${track.label} ${track.id}: ${motion.character}, ${motion.direction}, ${motion.pace}`,
          "info",
        ));
      }
      if (track.category === "person" && track.hits >= 4 && motion && !track.told.activity && allow(state, `${track.id}:activity`, now)) {
        track.told.activity = true;
        const action = motion.character === "стоит" ? "стоит" : `идёт ${motion.direction}`;
        events.push(event(track, cam, now, "activity", `Человек ${track.id}: ${action}`, "watch"));
      }
      const cargo = track.category === "freight" || track.category === "vessel";
      if (cargo && motion && (motion.character === "приближается" || motion.character === "стоит") && track.hits >= 5 && !track.told.operation && allow(state, `${track.id}:operation`, now)) {
        track.told.operation = true;
        const title = track.category === "freight" ? `Грузовая операция, объект ${track.id}` : `Швартовная операция, объект ${track.id}`;
        events.push(event(track, cam, now, "operation", title, "watch"));
      }
      if (track.category === "vessel" && motion && (motion.pace === "быстро" || motion.character === "приближается") && track.w * track.h > 0.015 && !track.told.maritime && allow(state, `${track.id}:maritime`, now)) {
        track.told.maritime = true;
        events.push(event(track, cam, now, "maritime", `Сближение судна ${track.id}`, "alarm"));
      }
      if ((track.category === "aerial" || track.category === "drone") && track.hits === 2 && allow(state, `${track.id}:aerial`, now)) {
        const title = track.category === "drone" ? `Беспилотник ${track.id}` : `Воздушный объект ${track.id}`;
        events.push(event(track, cam, now, "aerial", title, "alarm"));
      }
    }
    state.counts.push(objects.length);
    if (state.counts.length > 8) state.counts.shift();
    const mean = state.counts.reduce((sum, value) => sum + value, 0) / state.counts.length;
    if (objects.length >= mean + 4 && objects.length >= 5 && now - state.lastAnomaly > 60000 && allow(state, "anomaly", now)) {
      state.lastAnomaly = now;
      events.push({
        id: `ev-${now}-anomaly`,
        at: now,
        kind: "anomaly",
        title: `Необычное число объектов: ${objects.length}`,
        severity: "alarm",
        category: "",
        label: "",
        trackId: 0,
        cameraId: cam.id,
        cameraName: cam.name,
        vesselId: cam.vesselId || "",
        vesselName: cam.vesselName || "",
      });
    }
    const moving = state.tracks.filter((track) => track.motion && track.motion.speed >= 0.04);
    const left = moving.some((track) => track.motion.dx < -0.03);
    const right = moving.some((track) => track.motion.dx > 0.03);
    if (left && right && allow(state, "cross", now)) {
      events.push({
        id: `ev-${now}-cross`,
        at: now,
        kind: "anomaly",
        title: "Встречное движение в одном кадре",
        severity: "watch",
        category: "",
        label: "",
        trackId: 0,
        cameraId: cam.id,
        cameraName: cam.name,
        vesselId: cam.vesselId || "",
        vesselName: cam.vesselName || "",
      });
    }
    return { tracks: state.tracks.map(copyTrack), events };
  }

  function copyTrack(track) {
    return {
      id: track.id,
      category: track.category,
      label: track.label,
      x: track.x,
      y: track.y,
      w: track.w,
      h: track.h,
      trail: track.trail.map((point) => ({ x: point.x, y: point.y })),
      direction: track.motion ? track.motion.direction : "",
    };
  }

  function snapshot() {
    const rows = [];
    for (const [cameraId, state] of cameras) {
      rows.push({ cameraId, tracks: state.tracks.length });
    }
    return rows;
  }

  function reset() {
    cameras.clear();
  }

  return { observe, snapshot, reset };
})();
