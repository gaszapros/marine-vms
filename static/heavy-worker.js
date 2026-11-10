try {
  importScripts("https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/ort.min.js");
} catch (error) {
  self.postMessage({ type: "error", message: "import " + String(error && error.message ? error.message : error) });
}

let session = null;

self.onmessage = async (event) => {
  const message = event.data;
  if (message.type === "init") {
    try {
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/";
      session = await ort.InferenceSession.create(message.modelUrl, { executionProviders: ["wasm"] });
      self.postMessage({ type: "ready" });
    } catch (error) {
      self.postMessage({ type: "error", message: String(error && error.message ? error.message : error) });
    }
    return;
  }
  if (message.type !== "run" || !session) return;
  try {
    const tensor = new ort.Tensor("float32", message.input, [1, 3, 640, 640]);
    const result = await session.run({ images: tensor });
    const output = result.output;
    self.postMessage(
      { type: "result", id: message.id, dims: output.dims, data: output.data },
      [output.data.buffer],
    );
  } catch (error) {
    self.postMessage({
      type: "error",
      id: message.id,
      message: String(error && error.message ? error.message : error),
    });
  }
};
