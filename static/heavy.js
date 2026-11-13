/* Камера подсвечивается, когда в кадре грузовой транспорт. Размер сверяется с масштабом этой камеры. */
window.HeavyWatch = (() => {
  const INPUT = 640;
  const CONFIDENCE = 0.5;
  const CAR = 2;
  const BUS = 5;
  const TRUCK = 7;
  const BINS = 8;
  const anchors = buildAnchors();
  const profiles = new Map();
  let pixels = null;

  function sheet() {
    if (pixels) return pixels;
    const scratch = document.createElement("canvas");
    scratch.width = INPUT;
    scratch.height = INPUT;
    pixels = scratch.getContext("2d", { willReadFrequently: true });
    return pixels;
  }

  let generation = 0;
  let worker = null;
  let workerReady = null;
  let job = 0;

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
    worker = new Worker(new URL("heavy-worker.js?v=18", document.baseURI));
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
    const frame = sheet();
    frame.fillStyle = "rgb(114,114,114)";
    frame.fillRect(0, 0, INPUT, INPUT);
    frame.drawImage(video, 0, 0, resizedW, resizedH);
    let rgba;
    try {
      rgba = frame.getImageData(0, 0, INPUT, INPUT).data;
    } catch (error) {
      pixels = null;
      throw error;
    }
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
      small: width < 480,
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

  function profileFor(cameraId) {
    const key = cameraId || "camera";
    let bins = profiles.get(key);
    if (!bins) {
      bins = Array.from({ length: BINS }, () => []);
      profiles.set(key, bins);
    }
    return bins;
  }

  function rememberCar(profile, yFrac, box) {
    const index = Math.min(BINS - 1, Math.max(0, Math.floor(yFrac * BINS)));
    const bin = profile[index];
    bin.push({ h: box.h, w: box.w });
    if (bin.length > 12) bin.shift();
  }

  function carScale(profile, yFrac) {
    const index = Math.min(BINS - 1, Math.max(0, Math.floor(yFrac * BINS)));
    const samples = [];
    for (const shift of [-1, 0, 1]) {
      const bin = profile[index + shift];
      if (bin) samples.push(...bin);
    }
    if (samples.length < 4) return null;
    const heights = samples.map((item) => item.h).sort((left, right) => left - right);
    const widths = samples.map((item) => item.w).sort((left, right) => left - right);
    const mid = Math.floor((heights.length - 1) * 0.35);
    return { h: heights[mid], w: widths[mid] };
  }

  function freightSize(box, sample, profile) {
    const yFrac = (box.y + box.h / 2) / sample.height;
    const car = carScale(profile, yFrac);
    if (car) {
      return box.h >= car.h * 1.55 && box.h <= car.h * 3.2 && box.w >= car.w * 1.2 && box.w <= car.w * 4.2;
    }
    const heightFrac = box.h / sample.height;
    const widthFrac = box.w / sample.width;
    return heightFrac >= 0.08 && heightFrac <= 0.5 && widthFrac >= 0.045 && widthFrac <= 0.55;
  }

  function countFreight(output, sample, cameraId) {
    const data = output.data;
    const count = output.dims[1];
    const widthOut = output.dims[2];
    const profile = profileFor(cameraId);
    const found = [];
    for (let i = 0; i < count; i += 1) {
      const base = i * widthOut;
      const objectness = data[base + 4];
      if (objectness < 0.15) continue;
      let best = 0;
      let score = 0;
      for (let cls = 0; cls < 80; cls += 1) {
        const value = objectness * data[base + 5 + cls];
        if (value > score) {
          score = value;
          best = cls;
        }
      }
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
      };
      if (box.w > sample.width * 0.92 && box.h > sample.height * 0.92) continue;
      const yFrac = (box.y + box.h / 2) / sample.height;
      const heightFrac = box.h / sample.height;
      if (best === CAR && score >= 0.45 && heightFrac >= 0.02 && heightFrac <= 0.4) {
        rememberCar(profile, yFrac, box);
        continue;
      }
      const truck = objectness * data[base + 5 + TRUCK];
      const car = objectness * data[base + 5 + CAR];
      const bus = objectness * data[base + 5 + BUS];
      if (best !== TRUCK || truck < CONFIDENCE || truck < car + 0.06 || truck < bus) continue;
      if (!freightSize(box, sample, profile)) continue;
      found.push(box);
    }
    found.sort((left, right) => right.score - left.score);
    const kept = [];
    for (const box of found) {
      if (kept.some((item) => overlap(item, box) > 0.5)) continue;
      kept.push(box);
    }
    return kept.length;
  }

  function detect(video, cameraId) {
    if (video.readyState < 2 || !video.videoWidth) return Promise.resolve(0);
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
        resolve(countFreight({ data: event.data.data, dims: event.data.dims }, sample, cameraId));
      };
      ready.addEventListener("message", onMessage);
      ready.postMessage({ type: "run", id, input: sample.input }, [sample.input.buffer]);
    }));
  }

  function stop() {
    generation += 1;
  }

  function start(entries) {
    stop();
    const token = generation;
    for (const entry of entries) {
      entry.seen = 0;
      entry.shown = 0;
      entry.onMarks(0);
    }
    let index = 0;
    const step = async () => {
      if (token !== generation) return;
      const live = entries.filter((entry) => !entry.live || entry.live());
      for (const entry of entries) {
        if (live.includes(entry) || !entry.shown) continue;
        entry.seen = 0;
        entry.shown = 0;
        entry.onMarks(0);
      }
      if (!live.length) {
        if (token === generation) setTimeout(step, 400);
        return;
      }
      const entry = live[index % live.length];
      index += 1;
      if (entry.video.readyState >= 2) {
        try {
          const count = await detect(entry.video, entry.cameraId);
          if (token !== generation) return;
          const now = performance.now();
          if (count > 0) entry.seen = now;
          const active = count > 0 || (entry.seen > 0 && now - entry.seen < 2500);
          const shown = active ? 1 : 0;
          if (shown !== entry.shown || shown) {
            entry.shown = shown;
            entry.onMarks(shown);
          }
        } catch (error) {
          console.error(error);
          if (token === generation && entry.onError) entry.onError(error);
        }
      }
      if (token === generation) setTimeout(step, 40);
    };
    step();
  }

  return { start, stop };
})();
