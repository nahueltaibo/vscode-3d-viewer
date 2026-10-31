import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync } from 'fs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// Route the engine's CDN-based OCCT loader to src/webview/occt.js.
const localOcct = {
  name: 'local-occt',
  setup(build) {
    build.onLoad({ filter: /online-3d-viewer[\\/]build[\\/]engine[\\/]o3dv\.module\.js$/ }, (args) => {
      const source = readFileSync(args.path, 'utf8');
      const pattern = /function CreateOcctWorker \(worker\)\s*\{[\s\S]*?\r?\n\}\r?\n(?=\s*function LoadExternalLibrary )/;
      if (!pattern.test(source)) {
        throw new Error('CreateOcctWorker not found in online-3d-viewer; update the local-occt plugin.');
      }
      const contents = source.replace(
        pattern,
        'function CreateOcctWorker () { return globalThis.o3dvCreateOcctWorker (); }\n',
      );
      return { contents, loader: 'js' };
    });
  },
};

function copyOcctAssets() {
  const from = 'node_modules/occt-import-js/dist';
  mkdirSync('dist/occt', { recursive: true });
  for (const name of [
    'occt-import-js.js',
    'occt-import-js.wasm',
    'license.occt-import-js.txt',
    'license.occt.txt',
  ]) {
    copyFileSync(`${from}/${name}`, `dist/occt/${name}`);
  }
}

const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
};

const contexts = await Promise.all([
  esbuild.context({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  }),
  esbuild.context({
    ...common,
    entryPoints: ['src/webview/main.js'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
    plugins: [localOcct],
  }),
]);

copyOcctAssets();

if (watch) {
  await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
  await Promise.all(contexts.map((ctx) => ctx.rebuild()));
  await Promise.all(contexts.map((ctx) => ctx.dispose()));
}
