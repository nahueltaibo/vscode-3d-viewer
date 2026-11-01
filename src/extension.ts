import * as vscode from 'vscode';
import * as path from 'path';

// Formats that can reference sibling files (materials, buffers, textures).
const HAS_COMPANIONS = new Set(['.obj', '.gltf', '.3ds', '.dae', '.fbx', '.wrl']);
const COMPANION_EXTS = new Set([
  '.mtl', '.bin', '.png', '.jpg', '.jpeg', '.bmp', '.gif', '.tga', '.tif', '.tiff', '.webp', '.dds',
]);
// The engine loads these without rotation, and CAD tools write them Z-up.
const Z_UP_EXTS = new Set(['.step', '.stp', '.iges', '.igs', '.brep', '.brp']);
const COMPANION_BUDGET_BYTES = 256 * 1024 * 1024;
const RELOAD_DEBOUNCE_MS = 300;

interface ModelFile {
  name: string;
  data: Uint8Array;
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new ModelViewerProvider(context.extensionUri);
  for (const viewType of ['o3dv.viewer', 'o3dv.viewer.text']) {
    context.subscriptions.push(
      vscode.window.registerCustomEditorProvider(viewType, provider, {
        // Keeps the WebGL scene and camera alive when the tab is hidden.
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: true,
      }),
    );
  }
}

export function deactivate() {}

class ModelViewerProvider implements vscode.CustomReadonlyEditorProvider {
  constructor(private readonly extensionUri: vscode.Uri) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): Promise<void> {
    const distUri = vscode.Uri.joinPath(this.extensionUri, 'dist');
    panel.webview.options = { enableScripts: true, localResourceRoots: [distUri] };
    panel.webview.html = this.getHtml(panel.webview, distUri);

    const uri = document.uri;
    const send = async (keepCamera: boolean) => {
      try {
        const files = await readModelFiles(uri);
        const config = vscode.workspace.getConfiguration('o3dv', uri);
        panel.webview.postMessage({
          type: 'load',
          files,
          keepCamera,
          upAxis: resolveUpAxis(config.get<string>('upAxis', 'auto'), uri),
          defaultView: config.get<string>('defaultView', 'front'),
          showEdges: config.get<boolean>('showEdges', false),
          edgeThreshold: config.get<number>('edgeThreshold', 30),
        });
      } catch (err) {
        panel.webview.postMessage({ type: 'error', message: `Cannot read ${uri.fsPath}: ${err}` });
      }
    };

    const disposables: vscode.Disposable[] = [];
    disposables.push(
      panel.webview.onDidReceiveMessage((msg) => {
        if (msg?.type === 'ready') {
          send(false);
        }
      }),
    );

    // Watch the whole folder so edits to .mtl or texture files also trigger a reload.
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), '*'),
    );
    let timer: NodeJS.Timeout | undefined;
    const onChange = (changed: vscode.Uri) => {
      if (!isRelevantChange(uri, changed)) {
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => send(true), RELOAD_DEBOUNCE_MS);
    };
    disposables.push(watcher, watcher.onDidChange(onChange), watcher.onDidCreate(onChange));

    panel.onDidDispose(() => {
      clearTimeout(timer);
      disposables.forEach((d) => d.dispose());
    });
  }

  private getHtml(webview: vscode.Webview, distUri: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'webview.js'));
    const occtBaseUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'occt')).toString() + '/';
    const nonce = makeNonce();
    // Textures load through blob: URLs. STEP/IGES import runs occt-import-js in a blob: worker,
    // which inherits this policy; its embind glue needs 'unsafe-eval' on top of WASM compilation.
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} blob: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}' 'wasm-unsafe-eval' 'unsafe-eval'`,
      `worker-src blob:`,
      `connect-src ${webview.cspSource} blob: data:`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden;
    background: var(--vscode-editor-background); color: var(--vscode-editor-foreground);
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  #viewer { position: absolute; inset: 0; }
  #viewer canvas { display: block; outline: none; }
  .tool { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
    border: 1px solid var(--vscode-contrastBorder, transparent); border-radius: 2px; padding: 3px 8px; cursor: pointer;
    font: inherit; display: inline-flex; align-items: center; }
  .tool:hover { background: var(--vscode-button-secondaryHoverBackground); }
  #settings-area { position: absolute; top: 8px; left: 8px; z-index: 2; display: flex; gap: 4px; }
  #settings, #parts { padding: 4px 6px; }
  #parts[hidden] { display: none; }
  #parts[aria-pressed="true"] { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  #parts-panel { position: absolute; top: 40px; left: 8px; width: 260px; max-height: calc(100% - 80px); z-index: 1;
    display: flex; flex-direction: column; border-radius: 4px;
    background: var(--vscode-sideBar-background, var(--vscode-editorWidget-background));
    border: 1px solid var(--vscode-widget-border, var(--vscode-contrastBorder, transparent));
    box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.36)); }
  #parts-panel[hidden] { display: none; }
  #parts-panel header { display: flex; align-items: center; justify-content: space-between; padding: 4px 8px;
    font-weight: 600; border-bottom: 1px solid var(--vscode-widget-border, transparent); }
  #parts-panel .link { background: none; border: none; padding: 0 2px; font: inherit; font-weight: normal; cursor: pointer;
    color: var(--vscode-textLink-foreground); }
  #parts-list, #parts-list ul { list-style: none; margin: 0; padding: 0; }
  #parts-list { overflow: auto; padding: 2px 0; }
  #parts-list ul[hidden] { display: none; }
  .part { display: flex; align-items: center; gap: 4px; height: 22px; padding-right: 6px; white-space: nowrap; }
  .part:hover { background: var(--vscode-list-hoverBackground); }
  .part.selected { background: var(--vscode-list-inactiveSelectionBackground); }
  .part.hidden-part .name { opacity: 0.5; }
  .part input { margin: 0; }
  .part .twisty { width: 12px; text-align: center; cursor: pointer; }
  .part[data-expanded="true"] .twisty { transform: rotate(90deg); }
  .part .name { flex: 1; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
  .part .isolate { visibility: hidden; }
  .part:hover .isolate { visibility: visible; }
  #settings-menu { position: absolute; top: calc(100% + 4px); left: 0; min-width: 180px; padding: 4px 0;
    background: var(--vscode-menu-background, var(--vscode-editorWidget-background));
    color: var(--vscode-menu-foreground, var(--vscode-editor-foreground));
    border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border, transparent)); border-radius: 4px;
    box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.36)); }
  #settings-menu[hidden] { display: none; }
  #settings-menu button { display: flex; width: 100%; align-items: center; gap: 8px; padding: 4px 12px 4px 8px;
    background: none; border: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
  #settings-menu button:hover, #settings-menu button:focus-visible { outline: none;
    background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground));
    color: var(--vscode-menu-selectionForeground, inherit); }
  #settings-menu .check { width: 14px; visibility: hidden; }
  #settings-menu [aria-checked="true"] .check { visibility: visible; }
  #settings-menu .value { margin-left: auto; opacity: 0.8; }
  #navigation { position: absolute; top: 8px; right: 8px; display: flex; flex-direction: column; align-items: center;
    gap: 4px; z-index: 1; }
  #status { position: absolute; bottom: 8px; left: 8px; right: 8px; opacity: 0.8; pointer-events: none; z-index: 1;
    white-space: pre-wrap; }
  #status.error { color: var(--vscode-errorForeground); opacity: 1; }
</style>
</head>
<body data-occt-base="${occtBaseUri}">
<div id="viewer"></div>
<div id="settings-area">
  <button id="settings" class="tool" title="Settings" aria-label="Settings" aria-haspopup="menu" aria-expanded="false">
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke-width="2.6" stroke-dasharray="2.4 2.31"/>
      <circle cx="8" cy="8" r="4.2" stroke-width="2.2"/>
    </svg>
  </button>
  <button id="parts" class="tool" title="Parts" aria-label="Parts" aria-pressed="false" hidden>
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <rect x="1" y="2.5" width="2.5" height="2.5"/><rect x="5" y="3" width="10" height="1.5"/>
      <rect x="1" y="6.75" width="2.5" height="2.5"/><rect x="5" y="7.25" width="10" height="1.5"/>
      <rect x="1" y="11" width="2.5" height="2.5"/><rect x="5" y="11.5" width="10" height="1.5"/>
    </svg>
  </button>
  <div id="settings-menu" role="menu" hidden>
    <button id="up" role="menuitem"><span class="check"></span>Up axis<span class="value">Y</span></button>
    <button id="ortho" role="menuitemcheckbox" aria-checked="false"><span class="check">✓</span>Orthographic</button>
    <button id="edges" role="menuitemcheckbox" aria-checked="false"><span class="check">✓</span>Edges</button>
  </div>
</div>
<div id="parts-panel" hidden>
  <header>Parts<button id="show-all" class="link">Show all</button></header>
  <ul id="parts-list"></ul>
</div>
<div id="navigation">
  <button id="fit" class="tool" title="Fit model to view">Fit</button>
  <canvas id="viewcube" title="Click a face, edge or corner to view the model from there"></canvas>
</div>
<div id="status">Loading…</div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

// readFile returns a Node Buffer. Webview postMessage only transfers views whose
// constructor.name is a typed-array name, and JSON-encodes anything else.
async function readBytes(uri: vscode.Uri): Promise<Uint8Array> {
  const data = await vscode.workspace.fs.readFile(uri);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

async function readModelFiles(uri: vscode.Uri): Promise<ModelFile[]> {
  const main: ModelFile = { name: path.posix.basename(uri.path), data: await readBytes(uri) };
  if (!HAS_COMPANIONS.has(extOf(uri.path))) {
    return [main];
  }

  const dir = vscode.Uri.joinPath(uri, '..');
  const files = [main];
  let budget = COMPANION_BUDGET_BYTES;
  for (const [name, type] of await vscode.workspace.fs.readDirectory(dir)) {
    if (type !== vscode.FileType.File || name === main.name || !COMPANION_EXTS.has(extOf(name))) {
      continue;
    }
    const fileUri = vscode.Uri.joinPath(dir, name);
    const { size } = await vscode.workspace.fs.stat(fileUri);
    if (size > budget) {
      continue;
    }
    budget -= size;
    files.push({ name, data: await readBytes(fileUri) });
  }
  return files;
}

function isRelevantChange(modelUri: vscode.Uri, changed: vscode.Uri): boolean {
  if (changed.toString() === modelUri.toString()) {
    return true;
  }
  return HAS_COMPANIONS.has(extOf(modelUri.path)) && COMPANION_EXTS.has(extOf(changed.path));
}

function resolveUpAxis(setting: string, uri: vscode.Uri): 'Y' | 'Z' {
  if (setting === 'Y' || setting === 'Z') {
    return setting;
  }
  return Z_UP_EXTS.has(extOf(uri.path)) ? 'Z' : 'Y';
}

function extOf(p: string): string {
  return path.posix.extname(p).toLowerCase();
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
