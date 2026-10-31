# 3D Model Viewer for VS Code

[![VS Marketplace](https://vsmarketplacebadges.dev/version/nahueltaibo.o3dv-viewer.svg?label=VS%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=nahueltaibo.o3dv-viewer) [![Open VSX](https://img.shields.io/open-vsx/v/nahueltaibo/o3dv-viewer?label=Open%20VSX)](https://open-vsx.org/extension/nahueltaibo/o3dv-viewer)

Open STEP, STL, 3MF and other 3D models in a VS Code tab instead of switching to a separate app. Keep the tab open while your CAD script rebuilds the file, and the view refreshes without losing your camera.

Everything runs offline inside VS Code. Rendering and import come from [Online3DViewer](https://github.com/kovacsv/Online3DViewer).

![A 3MF assembly open in the viewer, with the view cube in the top-right corner](docs/screenshot.png)

## Install

Open the Extensions view, search for **3D Model Viewer (Online3DViewer)** and click **Install**. Or from a terminal:

```sh
code --install-extension nahueltaibo.o3dv-viewer
```

It's on the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=nahueltaibo.o3dv-viewer) and on [Open VSX](https://open-vsx.org/extension/nahueltaibo/o3dv-viewer) for VSCodium, Cursor and other VS Code forks.

You'll need VS Code 1.90 or newer and a GPU with WebGL 2, which any machine from the last decade has. Remote SSH, WSL and Dev Containers work too.

## Open a model

Click a model in the Explorer. These formats open in the viewer straight away:

STEP, IGES, BREP, FCStd, STL, 3MF, GLB, 3DS, FBX, PLY and AMF.

OBJ, OFF, glTF, DAE, WRL and BIM are text formats, so they still open in the text editor. Right-click the tab and pick **Reopen Editor With… → 3D Model Viewer**. To always open one in the viewer, add it to your settings:

```json
"workbench.editorAssociations": { "*.obj": "o3dv.viewer.text" }
```

## Move around

- **Mouse:** left-drag orbits, right-drag pans and the wheel zooms.
- **View cube:** the cube in the top-right corner turns with the model. Click a face, edge or corner to jump to that view, such as FRONT, TOP or the front-right-top corner.
- **Fit:** the button above the cube frames the whole model.
- **Settings menu:** the gear in the top-left corner switches the up axis between Y and Z, turns on orthographic projection and draws feature edges.
- **Parts:** for assemblies, the list button next to the gear opens the part tree. Untick a part to hide it, or hover its row and click **Isolate** to show only that part. Point at a row to highlight the part, or click a part in the view to find its row. Hidden parts stay hidden when the file reloads.

## What else it does

- **Live reload.** When the file changes on disk, the model reloads and your camera stays put.
- **CAD formats.** STEP, IGES, BREP and FCStd load through a bundled build of Open CASCADE, in the background. A 17 MB STEP assembly takes a few seconds.
- **Materials and textures.** OBJ, glTF, 3DS, DAE, FBX and WRL pick up `.mtl`, `.bin` and texture files from the same folder. The status line at the bottom lists any that are missing.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `o3dv.upAxis` | `auto` | Up axis for new views. `auto` uses Z for STEP, IGES and BREP, which CAD tools export Z-up, and Y for everything else. |
| `o3dv.defaultView` | `front` | Side the camera starts on. `front` matches the CAD front view. Use `back` if your models face +Y. |
| `o3dv.showEdges` | `false` | Draws feature edges when a model opens. |
| `o3dv.edgeThreshold` | `30` | Minimum angle between faces, in degrees, for an edge to be drawn. |

## Not supported yet

3DM, IFC and Draco-compressed glTF. Online3DViewer loads these from the internet, and this extension doesn't bundle them yet.

## Feedback

Found a bug or missing a format? [Open an issue](https://github.com/nahueltaibo/vscode-3d-viewer/issues). To build it yourself, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. The bundled Open CASCADE build is LGPL 2.1. All third-party licenses are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
