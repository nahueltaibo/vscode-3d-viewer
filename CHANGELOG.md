# Changelog

## 0.3.0

- Adds a **Turn** button that turns the view 180° around the up axis.
- Adds the `o3dv.defaultView` setting. Set it to `back` for models whose front faces +Y.

## 0.2.0

- Opens STEP, IGES, BREP and FCStd files with a bundled Open CASCADE build. They work offline.
- STEP, IGES and BREP start Z up. The `o3dv.upAxis` setting defaults to `auto`.
- Edges are off by default.

## 0.1.0

- First release. Views STL, 3MF, GLB, 3DS, FBX, PLY, AMF, OBJ, OFF, glTF, DAE, WRL and BIM files.
- Reloads on file change and keeps the camera.
