/* Красный квадрат на автобусе и грузовике. Легковые не выделяются, запись не идёт. */
window.HeavyWatch = (() => {
  const INPUT = 640;
  const CONFIDENCE = 0.45;
  const LABELS = { 5: "автобус", 7: "грузовик" };
  const anchors = buildAnchors();
  const scratch = document.createElement("canvas");
  scratch.width = INPUT;
  scratch.height = INPUT;
  const pixels = scratch.getContext("2d", { willReadFrequently: true });

  let session = null;
  let loading = null;
  let timer = 0;
  let busy = false;
  let generation = 0;

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

  function load() {
    if (session) return Promise.resolve(session);
    if (loading) return loading;
    if (!window.ort) return Promise.resolve(null);
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/";
    loading = ort.InferenceSession.create(modelUrl(), { executionProviders: ["wasm"] })
      .then((created) => {
        session = created;
        return created;
      })
      .catch((error) => {
        loading = null;
        throw error;
      });
    return loading;
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
    return { input, ratio, width, height };
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

  function decode(output, ratio, width, height) {
    const data = output.data;
    const count = output.dims[1];
    const widthOut = output.dims[2];
    const found = [];
    for (let i = 0; i < count; i += 1) {
      const base = i * widthOut;
      const objectness = data[base + 4];
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
        x: (centerX - boxW / 2) / ratio,
        y: (centerY - boxH / 2) / ratio,
        w: boxW / ratio,
        h: boxH / ratio,
        score,
        label: LABELS[best],
      };
      if (box.w < 16 || box.h < 14) continue;
      if (box.w > width * 0.92 && box.h > height * 0.92) continue;
      box.x = Math.max(0, Math.min(width - 1, box.x));
      box.y = Math.max(0, Math.min(height - 1, box.y));
      box.w = Math.min(width - box.x, box.w);
      box.h = Math.min(height - box.y, box.h);
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

  async function detect(video) {
    const ready = await load();
    if (!ready || video.readyState < 2 || !video.videoWidth) return [];
    const sample = letterbox(video);
    const tensor = new ort.Tensor("float32", sample.input, [1, 3, INPUT, INPUT]);
    const result = await ready.run({ images: tensor });
    return decode(result.output, sample.ratio, sample.width, sample.height);
  }

  function paint(canvas, video, boxes) {
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const pen = canvas.getContext("2d");
    pen.clearRect(0, 0, width, height);
    const weight = Math.max(2, Math.round(width / 320));
    pen.lineWidth = weight;
    pen.font = `${Math.max(14, Math.round(width / 46))}px Segoe UI, sans-serif`;
    for (const box of boxes) {
      pen.strokeStyle = "#e62828";
      pen.strokeRect(box.x, box.y, box.w, box.h);
      const top = Math.max(0, box.y - 22);
      const textW = pen.measureText(box.label).width;
      pen.fillStyle = "#d22424";
      pen.fillRect(box.x, top, textW + 10, 22);
      pen.fillStyle = "#ffffff";
      pen.fillText(box.label, box.x + 5, top + 16);
    }
  }

  function stop() {
    generation += 1;
    clearTimeout(timer);
    busy = false;
  }

  function start(entries) {
    stop();
    const token = generation;
    let index = 0;
    const step = async () => {
      if (token !== generation) return;
      const entry = entries[index % entries.length];
      index += 1;
      if (!busy && entry.video.readyState >= 2) {
        busy = true;
        try {
          const boxes = await detect(entry.video);
          if (token !== generation) return;
          paint(entry.canvas, entry.video, boxes);
          entry.onMarks(boxes);
        } catch (error) {
          console.error(error);
          if (token === generation) entry.onError(error);
        } finally {
          busy = false;
        }
      }
      if (token === generation) timer = setTimeout(step, 800);
    };
    entries.forEach((entry) => entry.onMarks([]));
    step();
  }

  return { start, stop };
})();
