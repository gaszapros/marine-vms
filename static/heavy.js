/* Красный квадрат едет за автобусом и грузовиком. Легковые не выделяются, запись не идёт. */
window.HeavyWatch = (() => {
  const INPUT = 640;
  const CONFIDENCE = 0.4;
  const LABELS = { 5: "автобус", 7: "грузовик" };
  const anchors = buildAnchors();
  const scratch = document.createElement("canvas");
  scratch.width = INPUT;
  scratch.height = INPUT;
  const pixels = scratch.getContext("2d", { willReadFrequently: true });

  let generation = 0;
  let frame = 0;
  let worker = null;
  let workerReady = null;
  let job = 0;
  const HOLD = 2200;

  function buildAnchors() {
    const gx = [];
    const gy = [];
    const step = [];
    for (const stride of [8, 16, 32]) {
      const size = INPUT / stride;
      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
          gx.push(x);
          gy.push(y);
          step.push(stride);
        }
      }
    }
    return { gx, gy, step };
  }

  function modelUrl() {
    return new URL("yolox.onnx", document.baseURI).href;
  }

  function ensureWorker() {
    if (workerReady) return workerReady;
    worker = new Worker(new URL("heavy-worker.js?v=14", document.baseURI));
    workerReady = new Promise((resolve, reject) => {
      const fail = (message) => {
        worker.removeEventListener("message", onMessage);
        reject(new Error(message));
      };
      const onMessage = (event) => {
        if (event.data.type === "ready") {
          worker.removeEventListener("message", onMessage);
          resolve(worker);
        } else if (event.data.type === "error" && event.data.id == null) {
          fail(event.data.message);
        }
      };
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", (event) => fail(event.message || "worker error"));
      worker.postMessage({ type: "init", modelUrl: modelUrl() });
    }).catch((error) => {
      workerReady = null;
      throw error;
    });
    return workerReady;
  }

  function letterbox(video) {
    const width = video.videoWidth;
    const height = video.videoHeight;
    const ratio = Math.min(INPUT / height, INPUT / width);
    const resizedW = Math.max(1, Math.round(width * ratio));
    const resizedH = Math.max(1, Math.round(height * ratio));
    pixels.fillStyle = "rgb(114,114,114)";
    pixels.fillRect(0, 0, INPUT, INPUT);
    pixels.drawImage(video, 0, 0, resizedW, resizedH);
    const rgba = pixels.getImageData(0, 0, INPUT, INPUT).data;
    const input = new Float32Array(3 * INPUT * INPUT);
    const plane = INPUT * INPUT;
    for (let i = 0; i < plane; i += 1) {
      const offset = i * 4;
      input[i] = rgba[offset];
      input[plane + i] = rgba[offset + 1];
      input[plane * 2 + i] = rgba[offset + 2];
    }
    return {
      input,
      scaleX: resizedW / width,
      scaleY: resizedH / height,
      width,
      height,
    };
  }

  function overlap(left, right) {
    const x1 = Math.max(left.x, right.x);
    const y1 = Math.max(left.y, right.y);
    const x2 = Math.min(left.x + left.w, right.x + right.w);
    const y2 = Math.min(left.y + left.h, right.y + right.h);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const union = left.w * left.h + right.w * right.h - inter;
    return union <= 0 ? 0 : inter / union;
  }

  function decode(output, sample) {
    const data = output.data;
    const count = output.dims[1];
    const widthOut = output.dims[2];
    const found = [];
    for (let i = 0; i < count; i += 1) {
      const base = i * widthOut;
      const objectness = data[base + 4];
      if (objectness < 0.25) continue;
      let best = 0;
      let score = 0;
      for (let cls = 0; cls < 80; cls += 1) {
        const value = objectness * data[base + 5 + cls];
        if (value > score) {
          score = value;
          best = cls;
        }
      }
      if (!LABELS[best] || score < CONFIDENCE) continue;
      const centerX = (data[base] + anchors.gx[i]) * anchors.step[i];
      const centerY = (data[base + 1] + anchors.gy[i]) * anchors.step[i];
      const boxW = Math.exp(data[base + 2]) * anchors.step[i];
      const boxH = Math.exp(data[base + 3]) * anchors.step[i];
      const box = {
        x: (centerX - boxW / 2) / sample.scaleX,
        y: (centerY - boxH / 2) / sample.scaleY,
        w: boxW / sample.scaleX,
        h: boxH / sample.scaleY,
        score,
        label: LABELS[best],
      };
      if (box.w < 16 || box.h < 14) continue;
      if (box.w > sample.width * 0.92 && box.h > sample.height * 0.92) continue;
      box.x = Math.max(0, Math.min(sample.width - 1, box.x));
      box.y = Math.max(0, Math.min(sample.height - 1, box.y));
      box.w = Math.min(sample.width - box.x, box.w);
      box.h = Math.min(sample.height - box.y, box.h);
      if (box.w < 16 || box.h < 14) continue;
      found.push(box);
    }
    found.sort((left, right) => right.score - left.score);
    const kept = [];
    for (const box of found) {
      if (kept.some((item) => overlap(item, box) > 0.5)) continue;
      kept.push(box);
    }
    return kept;
  }

  function clampSpeed(value, limit) {
    return Math.max(-limit, Math.min(limit, value));
  }

  function place(track, now, width, height) {
    const limit = track.hits >= 2 ? 3 : 0.05;
    const dt = Math.min(limit, Math.max(0, (now - track.updated) / 1000));
    const x = Math.max(0, Math.min(width - track.w, track.x + track.vx * dt));
    const y = Math.max(0, Math.min(height - track.h, track.y + track.vy * dt));
    return { x, y, w: track.w, h: track.h, label: track.label };
  }

  function follow(entry, detections, seenAt) {
    const used = new Set();
    const width = entry.video.videoWidth;
    const height = entry.video.videoHeight;
    entry.tracks.forEach((track) => {
      const predicted = place(track, seenAt, width, height);
      let best = -1;
      let bestScore = 0.18;
      detections.forEach((det, index) => {
        if (used.has(index)) return;
        const same = overlap(predicted, det);
        const distance = Math.hypot(
          predicted.x + predicted.w / 2 - (det.x + det.w / 2),
          predicted.y + predicted.h / 2 - (det.y + det.h / 2),
        );
        const age = Math.max(0.05, (seenAt - track.updated) / 1000);
        const gate = Math.max(predicted.w, predicted.h, det.w, det.h) * (1.2 + age * 1.8);
        const close = distance < gate ? (1 - distance / gate) * 0.8 : 0;
        const score = Math.max(same, close) + (det.label === track.label ? 0.12 : 0);
        if (score > bestScore) {
          bestScore = score;
          best = index;
        }
      });
      if (best < 0) {
        track.misses += 1;
        return;
      }
      used.add(best);
      const det = detections[best];
      const dt = Math.max(0.05, (seenAt - track.updated) / 1000);
      const limit = Math.max(track.w, track.h, det.w, det.h) * 8;
      track.vx = clampSpeed(track.vx * 0.2 + ((det.x - track.x) / dt) * 0.8, limit);
      track.vy = clampSpeed(track.vy * 0.2 + ((det.y - track.y) / dt) * 0.8, limit);
      track.x = det.x;
      track.y = det.y;
      track.w = track.w * 0.2 + det.w * 0.8;
      track.h = track.h * 0.2 + det.h * 0.8;
      track.label = det.label;
      track.updated = seenAt;
      track.fresh = performance.now();
      track.hits += 1;
      track.misses = 0;
    });
    detections.forEach((det, index) => {
      if (used.has(index)) return;
      entry.tracks.push({
        x: det.x,
        y: det.y,
        w: det.w,
        h: det.h,
        vx: 0,
        vy: 0,
        label: det.label,
        updated: seenAt,
        fresh: performance.now(),
        hits: 1,
        misses: 0,
      });
    });
    const freshNow = performance.now();
    entry.tracks = entry.tracks.filter((track) => track.misses < 3 && freshNow - track.fresh < HOLD);
  }

  function detect(video) {
    if (video.readyState < 2 || !video.videoWidth) return Promise.resolve([]);
    const sample = letterbox(video);
    const id = job + 1;
    job = id;
    return ensureWorker().then((ready) => new Promise((resolve, reject) => {
      const onMessage = (event) => {
        if (!event.data || event.data.id !== id) return;
        ready.removeEventListener("message", onMessage);
        if (event.data.type === "error") {
          reject(new Error(event.data.message));
          return;
        }
        resolve(decode({ data: event.data.data, dims: event.data.dims }, sample));
      };
      ready.addEventListener("message", onMessage);
      ready.postMessage({ type: "run", id, input: sample.input }, [sample.input.buffer]);
    }));
  }

  function paint(canvas, video, boxes) {
    const viewW = video.clientWidth;
    const viewH = video.clientHeight;
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!viewW || !viewH || !width || !height) return;
    const dpr = window.devicePixelRatio || 1;
    const bitmapW = Math.round(viewW * dpr);
    const bitmapH = Math.round(viewH * dpr);
    if (canvas.width !== bitmapW) canvas.width = bitmapW;
    if (canvas.height !== bitmapH) canvas.height = bitmapH;
    const scale = Math.max(viewW / width, viewH / height);
    const offsetX = (viewW - width * scale) / 2;
    const offsetY = (viewH - height * scale) / 2;
    const pen = canvas.getContext("2d");
    pen.setTransform(dpr, 0, 0, dpr, 0, 0);
    pen.clearRect(0, 0, viewW, viewH);
    pen.lineWidth = 2;
    pen.font = "15px Segoe UI, sans-serif";
    for (const box of boxes) {
      const x = offsetX + box.x * scale;
      const y = offsetY + box.y * scale;
      const w = box.w * scale;
      const h = box.h * scale;
      pen.strokeStyle = "#e62828";
      pen.strokeRect(x, y, w, h);
      const top = Math.max(0, y - 20);
      const textW = pen.measureText(box.label).width;
      pen.fillStyle = "#d22424";
      pen.fillRect(x, top, textW + 10, 20);
      pen.fillStyle = "#ffffff";
      pen.fillText(box.label, x + 5, top + 15);
    }
  }

  function visible(entry, now) {
    const width = entry.video.videoWidth;
    const height = entry.video.videoHeight;
    if (!width || !height) return [];
    return entry.tracks
      .filter((track) => now - track.fresh < HOLD)
      .map((track) => place(track, now, width, height));
  }

  function draw(entries, token) {
    if (token !== generation) return;
    const now = performance.now();
    for (const entry of entries) {
      const boxes = visible(entry, now);
      paint(entry.canvas, entry.video, boxes);
      if (boxes.length !== entry.shown) {
        entry.shown = boxes.length;
        entry.onMarks(boxes);
      }
    }
    frame = requestAnimationFrame(() => draw(entries, token));
  }

  function stop() {
    generation += 1;
    cancelAnimationFrame(frame);
  }

  function start(entries) {
    stop();
    const token = generation;
    for (const entry of entries) {
      entry.tracks = [];
      entry.shown = 0;
      entry.onMarks([]);
    }
    let scan = 0;
    let burst = 0;
    const step = async () => {
      if (token !== generation) return;
      const nowPick = performance.now();
      const live = entries.filter((item) => item.tracks.some((track) => nowPick - track.fresh < HOLD));
      let entry;
      if (live.length && burst < 3) {
        entry = live[burst % live.length];
        burst += 1;
      } else {
        entry = entries[scan % entries.length];
        scan += 1;
        burst = 0;
      }
      if (entry.video.readyState >= 2) {
        const seenAt = performance.now();
        try {
          const boxes = await detect(entry.video);
          if (token !== generation) return;
          follow(entry, boxes, seenAt);
        } catch (error) {
          console.error(error);
          if (token === generation && entry.onError) entry.onError(error);
        }
      }
      if (token === generation) setTimeout(step, 30);
    };
    draw(entries, token);
    step();
  }

  return { start, stop };
})();
