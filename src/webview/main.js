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
import * as THREE from 'three';
import { createOcctWorker } from './occt.js';
import { createPartsPanel } from './parts.js';
import { createViewCube } from './viewcube.js';

globalThis.o3dvCreateOcctWorker = () => createOcctWorker(document.body.dataset.occtBase);

const vscode = acquireVsCodeApi();
const container = document.getElementById('viewer');
const statusEl = document.getElementById('status');
const settingsButton = document.getElementById('settings');
const settingsMenu = document.getElementById('settings-menu');
const upItem = document.getElementById('up');
const orthoItem = document.getElementById('ortho');
const edgesItem = document.getElementById('edges');

const canvas = document.createElement('canvas');
container.appendChild(canvas);
const viewer = new Viewer();
viewer.Init(canvas);
const loader = new ThreeModelLoader();
const viewCube = createViewCube(document.getElementById('viewcube'), viewFrom);
const parts = createPartsPanel({
  viewer,
  button: document.getElementById('parts'),
  panel: document.getElementById('parts-panel'),
  list: document.getElementById('parts-list'),
  showAll: document.getElementById('show-all'),
  highlightColor: () => {
    const [r, g, b] = cssColor('--vscode-focusBorder', [0, 127, 212]);
    return new RGBColor(r, g, b);
  },
  onOpenChange: (open) => vscode.setState({ ...vscode.getState(), partsOpen: open }),
});

// Viewer has no camera-change event, and every camera move ends in Render.
const renderViewer = viewer.Render.bind(viewer);
viewer.Render = () => {
  renderViewer();
  viewCube.render(viewer.GetCamera());
};

const VIEW_ANIMATION_MS = 300;
// Fixed-up-vector orbiting breaks when the view looks exactly along the up axis.
const POLE_TILT = 1e-3;

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

function toHex([r, g, b]) {
  return '#' + [r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('');
}

function mix(a, b, t) {
  return a.map((c, i) => c + (b[i] - c) * t);
}

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
  const bg = cssColor('--vscode-editor-background', isDarkTheme() ? [30, 30, 30] : [255, 255, 255]);
  const fg = cssColor('--vscode-editor-foreground', isDarkTheme() ? [212, 212, 212] : [51, 51, 51]);
  viewer.SetBackgroundColor(new RGBAColor(bg[0], bg[1], bg[2], 255));
  viewCube.setColors({
    face: toHex(mix(bg, fg, 0.18)),
    chamfer: toHex(mix(bg, fg, 0.1)),
    line: toHex(mix(bg, fg, 0.45)),
    text: toHex(fg),
    hover: toHex(cssColor('--vscode-focusBorder', [0, 127, 212])),
  });
  applyEdges();
}
// VS Code swaps body classes when the color theme changes.
new MutationObserver(applyTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] });

function applyEdges() {
  const color = isDarkTheme() ? new RGBColor(0, 0, 0) : new RGBColor(40, 40, 40);
  viewer.SetEdgeSettings(new EdgeSettings(state.showEdges, color, state.edgeThreshold));
  edgesItem.setAttribute('aria-checked', String(state.showEdges));
}

function applyUpAxis(animate) {
  viewer.SetUpVector(state.upAxis === 'Y' ? Direction.Y : Direction.Z, animate);
  upItem.querySelector('.value').textContent = state.upAxis;
  viewCube.setUpAxis(state.upAxis);
}

function worldUp() {
  return state.upAxis === 'Y' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
}

function worldFront() {
  return state.upAxis === 'Y' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, -1, 0);
}

let viewAnimation = 0;

// Swings the eye around the view center until it looks from dir, a unit vector in world space.
function viewFrom(dir) {
  const up = worldUp();
  const target = dir.clone();
  if (Math.abs(target.dot(up)) > 0.999) {
    // Top and bottom views keep the front at the bottom and top of the screen.
    target.addScaledVector(worldFront(), POLE_TILT).normalize();
  }

  const start = viewer.GetCamera().Clone();
  const { eye, center } = start;
  const offset = new THREE.Vector3(eye.x - center.x, eye.y - center.y, eye.z - center.z);
  const distance = offset.length();
  const from = offset.normalize();
  const rotation =
    from.dot(target) < -0.999
      ? new THREE.Quaternion().setFromAxisAngle(up, Math.PI)
      : new THREE.Quaternion().setFromUnitVectors(from, target);

  const id = ++viewAnimation;
  const t0 = performance.now();
  const step = (now) => {
    if (id !== viewAnimation) {
      return;
    }
    const t = Math.min((now - t0) / VIEW_ANIMATION_MS, 1);
    const eased = t * t * (3 - 2 * t);
    const d = from.clone().applyQuaternion(new THREE.Quaternion().slerp(rotation, eased));
    const camera = start.Clone();
    camera.eye.x = center.x + d.x * distance;
    camera.eye.y = center.y + d.y * distance;
    camera.eye.z = center.z + d.z * distance;
    camera.up.x = up.x;
    camera.up.y = up.y;
    camera.up.z = up.z;
    viewer.SetCamera(camera);
    if (t < 1) {
      requestAnimationFrame(step);
    }
  };
  requestAnimationFrame(step);
}
// Dragging the model takes over from a running view animation.
canvas.addEventListener('pointerdown', () => viewAnimation++);

// Rotates the eye 180° around the up axis through the view center.
function turnAround() {
  const camera = viewer.GetCamera().Clone();
  const { eye, center, up } = camera;
  const len = Math.hypot(up.x, up.y, up.z);
  const u = { x: up.x / len, y: up.y / len, z: up.z / len };
  const d = { x: eye.x - center.x, y: eye.y - center.y, z: eye.z - center.z };
  const along = 2 * (d.x * u.x + d.y * u.y + d.z * u.z);
  eye.x = center.x + along * u.x - d.x;
  eye.y = center.y + along * u.y - d.y;
  eye.z = center.z + along * u.z - d.z;
  viewer.SetCamera(camera);
}

// Frames the visible parts, but clips against the whole model so hidden parts can come back.
function fit(animate) {
  const all = viewer.GetBoundingSphere(() => true);
  const sphere = viewer.GetBoundingSphere(parts.isVisible) ?? all;
  if (sphere) {
    viewer.AdjustClippingPlanesToSphere(all);
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
      parts.load(importResult.model, keptCamera !== null);
      if (keptCamera) {
        viewer.AdjustClippingPlanesToSphere(viewer.GetBoundingSphere(() => true));
        viewer.SetCamera(keptCamera);
      } else {
        applyUpAxis(false);
        fit(false);
        if (msg.defaultView === 'back') {
          turnAround();
        }
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

function setMenuOpen(open) {
  settingsMenu.hidden = !open;
  settingsButton.setAttribute('aria-expanded', String(open));
}

settingsButton.addEventListener('click', () => setMenuOpen(settingsMenu.hidden));
document.addEventListener('pointerdown', (ev) => {
  if (!ev.target.closest('#settings, #settings-menu')) {
    setMenuOpen(false);
  }
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    setMenuOpen(false);
  }
});

document.getElementById('fit').addEventListener('click', () => fit(true));
upItem.addEventListener('click', () => {
  state.upAxis = state.upAxis === 'Y' ? 'Z' : 'Y';
  applyUpAxis(true);
  fit(true);
});
edgesItem.addEventListener('click', () => {
  state.showEdges = !state.showEdges;
  applyEdges();
});
orthoItem.addEventListener('click', () => {
  const ortho = viewer.GetProjectionMode() === ProjectionMode.Perspective;
  viewer.SetProjectionMode(ortho ? ProjectionMode.Orthographic : ProjectionMode.Perspective);
  orthoItem.setAttribute('aria-checked', String(ortho));
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
parts.setOpen(Boolean(vscode.getState()?.partsOpen));
vscode.postMessage({ type: 'ready' });
