/* Камера подсвечивается, когда в кадре грузовой транспорт. Размер сверяется с масштабом этой камеры. */
window.HeavyWatch = (() => {
  const INPUT = 640;
  const CAR = 2;
  const BUS = 5;
  const TRUCK = 7;
  const KINDS = [
    { id: 0, category: "person", label: "человек" },
    { id: 2, category: "car", label: "легковой" },
    { id: 4, category: "aerial", label: "воздушный" },
    { id: 5, category: "freight", label: "грузовой" },
    { id: 7, category: "freight", label: "грузовой" },
    { id: 8, category: "vessel", label: "судно" },
  ];
  const anchors = buildAnchors();
  const FORMULAS = {
    cuomo: { y0: 0.45, y1: 0.98, carH0: 0.024, carH1: 0.058, carW0: 0.018, carW1: 0.038, mul: 1.65, mild: 1.15, score: 0.18 },
    i66: { y0: 0.12, y1: 0.98, carH0: 0.02, carH1: 0.11, carW0: 0.015, carW1: 0.09, mul: 1.6, mild: 1.2, score: 0.2 },
    "i66-61": { y0: 0.28, y1: 0.98, carH0: 0.02, carH1: 0.07, carW0: 0.016, carW1: 0.045, mul: 1.55, mild: 1.2, score: 0.2 },
    i10: { y0: 0.18, y1: 0.58, carH0: 0.04, carH1: 0.055, carW0: 0.045, carW1: 0.065, mul: 1.4, mild: 1.15, score: 0.28 },
    "i10-whiskey": { y0: 0.08, y1: 0.96, carH0: 0.015, carH1: 0.09, carW0: 0.012, carW1: 0.07, mul: 1.6, mild: 1.2, score: 0.2 },
    "i10-henderson": { y0: 0.15, y1: 0.62, carH0: 0.055, carH1: 0.09, carW0: 0.04, carW1: 0.06, mul: 1.75, mild: 1.6, score: 0.4 },
    "i10-scott": { y0: 0.15, y1: 0.98, carH0: 0.05, carH1: 0.16, carW0: 0.04, carW1: 0.12, mul: 1.35, mild: 1.15, score: 0.22 },
    "i10-lafayette": { y0: 0.38, y1: 0.98, carH0: 0.028, carH1: 0.1, carW0: 0.028, carW1: 0.09, mul: 1.45, mild: 1.15, score: 0.2 },
    default: { y0: 0.2, y1: 0.98, carH0: 0.03, carH1: 0.1, carW0: 0.02, carW1: 0.07, mul: 1.6, mild: 1.25, score: 0.28 },
  };
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

  function line(y, y0, y1, start, end) {
    const span = y1 - y0;
    const share = span <= 0 ? 0 : Math.min(1, Math.max(0, (y - y0) / span));
    return start + (end - start) * share;
  }

  function matchesFormula(cameraId, y, height, width, truck, car, bus) {
    const formula = FORMULAS[cameraId] || FORMULAS.default;
    if (y < formula.y0 || y > formula.y1 || height <= 0 || width <= 0) return false;
    if (height > 0.72 || width > 0.85) return false;
    const carH = line(y, formula.y0, formula.y1, formula.carH0, formula.carH1);
    const carW = line(y, formula.y0, formula.y1, formula.carW0, formula.carW1);
    const big = height >= carH * formula.mul && width >= carW * formula.mul
      && !(car >= 0.45 && truck < 0.08 && height < carH * (formula.mul + 0.35));
    const labeled = truck >= formula.score && truck >= car && height >= carH * formula.mild && width >= carW * formula.mild;
    const confused = bus >= formula.score && truck >= formula.score * 0.45 && height >= carH * formula.mul && width >= carW * formula.mild;
    return big || labeled || confused;
  }

  function countFreight(output, sample, cameraId) {
    const data = output.data;
    const count = output.dims[1];
    const widthOut = output.dims[2];
    const found = [];
    for (let i = 0; i < count; i += 1) {
      const base = i * widthOut;
      const objectness = data[base + 4];
      if (objectness < 0.12) continue;
      const truck = objectness * data[base + 5 + TRUCK];
      const car = objectness * data[base + 5 + CAR];
      const bus = objectness * data[base + 5 + BUS];
      if (Math.max(truck, car, bus) < 0.15) continue;
      const centerX = (data[base] + anchors.gx[i]) * anchors.step[i];
      const centerY = (data[base + 1] + anchors.gy[i]) * anchors.step[i];
      const boxW = Math.exp(data[base + 2]) * anchors.step[i];
      const boxH = Math.exp(data[base + 3]) * anchors.step[i];
      const box = {
        x: (centerX - boxW / 2) / sample.scaleX,
        y: (centerY - boxH / 2) / sample.scaleY,
        w: boxW / sample.scaleX,
        h: boxH / sample.scaleY,
        score: Math.max(truck, bus),
      };
      if (box.w > sample.width * 0.92 && box.h > sample.height * 0.92) continue;
      const yFrac = (box.y + box.h / 2) / sample.height;
      if (!matchesFormula(cameraId, yFrac, box.h / sample.height, box.w / sample.width, truck, car, bus)) continue;
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

  function readObjects(output, sample) {
    const data = output.data;
    const count = output.dims[1];
    const widthOut = output.dims[2];
    const found = [];
    for (let i = 0; i < count; i += 1) {
      const base = i * widthOut;
      const objectness = data[base + 4];
      if (objectness < 0.2) continue;
      let best = null;
      for (const kind of KINDS) {
        const score = objectness * data[base + 5 + kind.id];
        if (!best || score > best.score) best = { kind, score };
      }
      if (!best || best.score < 0.35) continue;
      const centerX = (data[base] + anchors.gx[i]) * anchors.step[i];
      const centerY = (data[base + 1] + anchors.gy[i]) * anchors.step[i];
      const boxW = Math.exp(data[base + 2]) * anchors.step[i];
      const boxH = Math.exp(data[base + 3]) * anchors.step[i];
      const w = boxW / sample.scaleX / sample.width;
      const h = boxH / sample.scaleY / sample.height;
      const x = (centerX - boxW / 2) / sample.scaleX / sample.width;
      const y = (centerY - boxH / 2) / sample.scaleY / sample.height;
      if (w < 0.012 || h < 0.012 || w > 0.92 || h > 0.92) continue;
      let category = best.kind.category;
      let label = best.kind.label;
      if (category === "aerial" && w < 0.08 && h < 0.08) {
        category = "drone";
        label = "беспилотник";
      }
      found.push({ category, label, score: best.score, x, y, w, h });
    }
    found.sort((left, right) => right.score - left.score);
    const kept = [];
    for (const box of found) {
      if (kept.some((item) => overlap(item, box) > 0.45)) continue;
      kept.push(box);
    }
    return kept.slice(0, 24);
  }

  function detect(video, cameraId) {
    if (video.readyState < 2 || !video.videoWidth) return Promise.resolve({ freight: 0, objects: [] });
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
        const output = { data: event.data.data, dims: event.data.dims };
        resolve({
          freight: countFreight(output, sample, cameraId),
          objects: readObjects(output, sample),
        });
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
          const scene = await detect(entry.video, entry.cameraId);
          if (token !== generation) return;
          const count = scene.freight || 0;
          if (entry.onScene) entry.onScene(scene.objects || []);
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
