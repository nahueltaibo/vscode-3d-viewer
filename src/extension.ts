import * as vscode from 'vscode';
import * as path from 'path';

// Formats that can reference sibling files (materials, buffers, textures).
const HAS_COMPANIONS = new Set(['.obj', '.gltf', '.3ds', '.dae', '.fbx', '.wrl']);
const COMPANION_EXTS = new Set([
  '.mtl', '.bin', '.png', '.jpg', '.jpeg', '.bmp', '.gif', '.tga', '.tif', '.tiff', '.webp', '.dds',
]);
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
          upAxis: config.get<string>('upAxis', 'Y') === 'Z' ? 'Z' : 'Y',
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
    const nonce = makeNonce();
    // Textures arrive as File objects and are shown through blob: URLs.
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} blob: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `connect-src blob: data:`,
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
  #toolbar { position: absolute; top: 8px; left: 8px; display: flex; gap: 4px; z-index: 1; }
  #toolbar button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
    border: 1px solid var(--vscode-contrastBorder, transparent); border-radius: 2px; padding: 3px 8px; cursor: pointer;
    font: inherit; }
  #toolbar button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  #toolbar button[aria-pressed="true"] { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  #status { position: absolute; bottom: 8px; left: 8px; right: 8px; opacity: 0.8; pointer-events: none; z-index: 1;
    white-space: pre-wrap; }
  #status.error { color: var(--vscode-errorForeground); opacity: 1; }
</style>
</head>
<body>
<div id="viewer"></div>
<div id="toolbar">
  <button id="fit" title="Fit model to view">Fit</button>
  <button id="up" title="Toggle up axis">Y up</button>
  <button id="edges" title="Toggle edges" aria-pressed="false">Edges</button>
  <button id="proj" title="Toggle perspective / orthographic">Persp</button>
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
