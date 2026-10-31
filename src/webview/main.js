import {
  Direction,
  EdgeSettings,
  ImportErrorCode,
  ImportSettings,
  InputFilesFromFileObjects,
  ProjectionMode,
  RGBAColor,
  RGBColor,
  ThreeModelLoader,
  Viewer,
} from 'online-3d-viewer';
import { createOcctWorker } from './occt.js';

globalThis.o3dvCreateOcctWorker = () => createOcctWorker(document.body.dataset.occtBase);

const vscode = acquireVsCodeApi();
const container = document.getElementById('viewer');
const statusEl = document.getElementById('status');
const upButton = document.getElementById('up');
const edgesButton = document.getElementById('edges');
const projButton = document.getElementById('proj');

const canvas = document.createElement('canvas');
container.appendChild(canvas);
const viewer = new Viewer();
viewer.Init(canvas);
const loader = new ThreeModelLoader();

const state = {
  upAxis: 'Y',
  showEdges: false,
  edgeThreshold: 30,
  hasModel: false,
};

function resize() {
  viewer.Resize(container.clientWidth, container.clientHeight);
}
new ResizeObserver(resize).observe(container);
resize();

function cssColor(name, fallback) {
  const value = getComputedStyle(document.body).getPropertyValue(name).trim();
  const m = /^#([0-9a-f]{6})/i.exec(value);
  if (!m) {
    return fallback;
  }
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function isDarkTheme() {
  return document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');
}

function applyTheme() {
  const [r, g, b] = cssColor('--vscode-editor-background', isDarkTheme() ? [30, 30, 30] : [255, 255, 255]);
  viewer.SetBackgroundColor(new RGBAColor(r, g, b, 255));
  applyEdges();
}
// VS Code swaps body classes when the color theme changes.
new MutationObserver(applyTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] });

function applyEdges() {
  const color = isDarkTheme() ? new RGBColor(0, 0, 0) : new RGBColor(40, 40, 40);
  viewer.SetEdgeSettings(new EdgeSettings(state.showEdges, color, state.edgeThreshold));
  edgesButton.setAttribute('aria-pressed', String(state.showEdges));
}

function applyUpAxis(animate) {
  viewer.SetUpVector(state.upAxis === 'Y' ? Direction.Y : Direction.Z, animate);
  upButton.textContent = `${state.upAxis} up`;
}

function fit(animate) {
  const sphere = viewer.GetBoundingSphere(() => true);
  if (sphere) {
    viewer.AdjustClippingPlanesToSphere(sphere);
    viewer.FitSphereToWindow(sphere, animate);
  }
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

function errorText(err) {
  const base = {
    [ImportErrorCode.NoImportableFile]: 'No importable file found.',
    [ImportErrorCode.FailedToLoadFile]: 'Failed to load file for import.',
    [ImportErrorCode.ImportFailed]: 'Failed to import model.',
  }[err.code] ?? 'Unknown error.';
  return err.message ? `${base} (${err.message})` : base;
}

function describe(model) {
  let triangles = 0;
  model.EnumerateMeshInstances((instance) => {
    triangles += instance.TriangleCount();
  });
  const meshes = model.MeshInstanceCount();
  return `${meshes} mesh${meshes === 1 ? '' : 'es'}, ${triangles.toLocaleString()} triangles`;
}

// ThreeModelLoader ignores LoadModel while busy, so keep only the newest request.
let pendingLoad = null;

function requestLoad(msg) {
  if (loader.InProgress()) {
    pendingLoad = msg;
  } else {
    load(msg);
  }
}

function loadFinished() {
  // inProgress is cleared only after the callback returns.
  setTimeout(() => {
    if (pendingLoad) {
      const next = pendingLoad;
      pendingLoad = null;
      requestLoad(next);
    }
  }, 0);
}

function load(msg) {
  state.upAxis = msg.upAxis;
  state.showEdges = msg.showEdges;
  state.edgeThreshold = msg.edgeThreshold;
  applyEdges();

  // On reload after a file change, keep the user's camera instead of refitting.
  const keptCamera = msg.keepCamera && state.hasModel ? viewer.GetCamera() : null;
  const files = msg.files.map((f) => new File([f.data], f.name));

  setStatus('Loading model…');
  loader.LoadModel(InputFilesFromFileObjects(files), new ImportSettings(), {
    onLoadStart: () => {},
    onFileListProgress: () => {},
    onFileLoadProgress: () => {},
    onImportStart: () => setStatus('Importing model…'),
    onVisualizationStart: () => setStatus('Visualizing model…'),
    onModelFinished: (importResult, threeObject) => {
      viewer.Clear();
      viewer.SetMainObject(threeObject);
      if (keptCamera) {
        viewer.AdjustClippingPlanesToSphere(viewer.GetBoundingSphere(() => true));
        viewer.SetCamera(keptCamera);
      } else {
        applyUpAxis(false);
        fit(false);
      }
      state.hasModel = true;
      const missing = importResult.missingFiles ?? [];
      setStatus(
        missing.length ? `${describe(importResult.model)} — missing: ${missing.join(', ')}` : describe(importResult.model),
        missing.length > 0,
      );
      loadFinished();
    },
    onTextureLoaded: () => viewer.Render(),
    onLoadError: (err) => {
      setStatus(errorText(err), true);
      loadFinished();
    },
  });
}

document.getElementById('fit').addEventListener('click', () => fit(true));
upButton.addEventListener('click', () => {
  state.upAxis = state.upAxis === 'Y' ? 'Z' : 'Y';
  applyUpAxis(true);
  fit(true);
});
edgesButton.addEventListener('click', () => {
  state.showEdges = !state.showEdges;
  applyEdges();
});
projButton.addEventListener('click', () => {
  const ortho = viewer.GetProjectionMode() === ProjectionMode.Perspective;
  viewer.SetProjectionMode(ortho ? ProjectionMode.Orthographic : ProjectionMode.Perspective);
  projButton.textContent = ortho ? 'Ortho' : 'Persp';
  viewer.Render();
});

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg.type === 'load') {
    requestLoad(msg);
  } else if (msg.type === 'error') {
    setStatus(msg.message, true);
  }
});

applyTheme();
vscode.postMessage({ type: 'ready' });
