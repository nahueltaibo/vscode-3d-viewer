// Replaces the engine's CreateOcctWorker (see esbuild.mjs), which loads occt-import-js from a CDN.
// The main thread fetches the bundled script and WASM through the webview resource loader, so the
// blob worker never fetches anything itself.

const WORKER_MAIN = `
let wasmBinary = null;
let occtPromise = null;
onmessage = async (ev) => {
  if (ev.data && ev.data.o3dvWasm) {
    wasmBinary = ev.data.o3dvWasm;
    return;
  }
  occtPromise ??= occtimportjs({ wasmBinary, locateFile: (path) => path });
  const occt = await occtPromise;
  postMessage(occt.ReadFile(ev.data.format, ev.data.buffer, ev.data.params));
};
`;

let assetsPromise = null;

function loadAssets(baseUrl) {
  const get = async (name, kind) => {
    const response = await fetch(baseUrl + name);
    if (!response.ok) {
      throw new Error(`Cannot load ${name}: HTTP ${response.status}`);
    }
    return kind === 'text' ? response.text() : response.arrayBuffer();
  };
  return Promise.all([get('occt-import-js.js', 'text'), get('occt-import-js.wasm', 'binary')]).then(
    ([script, wasm]) => ({
      workerUrl: URL.createObjectURL(new Blob([script, WORKER_MAIN], { type: 'text/javascript' })),
      wasm,
    }),
  );
}

export function createOcctWorker(baseUrl) {
  if (assetsPromise === null) {
    assetsPromise = loadAssets(baseUrl).catch((err) => {
      assetsPromise = null;
      throw err;
    });
  }
  return assetsPromise.then(({ workerUrl, wasm }) => {
    const worker = new Worker(workerUrl);
    // Messages arrive in order, so the WASM lands before the engine's import request.
    worker.postMessage({ o3dvWasm: wasm });
    return worker;
  });
}
