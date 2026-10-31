import * as THREE from 'three';

const CHAMFER = 0.3;
const A = 1 - CHAMFER;
const SIZE_PX = 130;

// CAD frame: Z up, front faces -Y. right and up orient each label as seen from outside the face.
const FACES = [
  { label: 'FRONT', n: [0, -1, 0], right: [1, 0, 0], up: [0, 0, 1] },
  { label: 'BACK', n: [0, 1, 0], right: [-1, 0, 0], up: [0, 0, 1] },
  { label: 'RIGHT', n: [1, 0, 0], right: [0, 1, 0], up: [0, 0, 1] },
  { label: 'LEFT', n: [-1, 0, 0], right: [0, -1, 0], up: [0, 0, 1] },
  { label: 'TOP', n: [0, 0, 1], right: [1, 0, 0], up: [0, 1, 0] },
  { label: 'BOTTOM', n: [0, 0, -1], right: [1, 0, 0], up: [0, -1, 0] },
];

const vec = (a) => new THREE.Vector3(...a);

// Fan-triangulates a convex polygon, winding it so its normal points along outward.
function polygonGeometry(points, outward) {
  const normal = new THREE.Vector3()
    .subVectors(points[1], points[0])
    .cross(new THREE.Vector3().subVectors(points[2], points[0]));
  if (normal.dot(outward) < 0) {
    points = [...points].reverse();
  }
  const positions = [];
  for (let i = 1; i < points.length - 1; i++) {
    positions.push(...points[0].toArray(), ...points[i].toArray(), ...points[i + 1].toArray());
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

// 6 face squares, 12 edge bevels and 8 corner triangles; dir is the CAD-frame view direction.
function regions() {
  const list = [];
  for (const face of FACES) {
    const n = vec(face.n);
    const r = vec(face.right).multiplyScalar(A);
    const u = vec(face.up).multiplyScalar(A);
    const points = [
      n.clone().sub(r).sub(u),
      n.clone().add(r).sub(u),
      n.clone().add(r).add(u),
      n.clone().sub(r).add(u),
    ];
    list.push({ kind: 'face', face, dir: n, points });
  }
  const axes = [vec([1, 0, 0]), vec([0, 1, 0]), vec([0, 0, 1])];
  for (let i = 0; i < 3; i++) {
    for (let j = i + 1; j < 3; j++) {
      const k = 3 - i - j;
      for (const si of [-1, 1]) {
        for (const sj of [-1, 1]) {
          const onI = axes[i].clone().multiplyScalar(si).addScaledVector(axes[j], sj * A);
          const onJ = axes[i].clone().multiplyScalar(si * A).addScaledVector(axes[j], sj);
          const points = [
            onI.clone().addScaledVector(axes[k], -A),
            onJ.clone().addScaledVector(axes[k], -A),
            onJ.clone().addScaledVector(axes[k], A),
            onI.clone().addScaledVector(axes[k], A),
          ];
          const dir = axes[i].clone().multiplyScalar(si).addScaledVector(axes[j], sj);
          list.push({ kind: 'chamfer', dir, points });
        }
      }
    }
  }
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const points = [vec([sx, sy * A, sz * A]), vec([sx * A, sy, sz * A]), vec([sx * A, sy * A, sz])];
        list.push({ kind: 'chamfer', dir: vec([sx, sy, sz]), points });
      }
    }
  }
  return list;
}

function labelTexture(text, color, fontFamily) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d');
  let fontSize = 76;
  const font = () => `600 ${fontSize}px ${fontFamily}`;
  ctx.font = font();
  while (ctx.measureText(text).width > 236 && fontSize > 20) {
    fontSize -= 2;
    ctx.font = font();
  }
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 128);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/**
 * Chamfered navigation cube drawn on its own canvas. It mirrors the main camera's orientation
 * and calls onPick with the world-space direction of the clicked face, edge or corner.
 */
export function createViewCube(canvas, onPick) {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setSize(SIZE_PX, SIZE_PX);

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1.55, 1.55, 1.55, -1.55, 0.1, 10);
  scene.add(camera);
  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const light = new THREE.DirectionalLight(0xffffff, 1.4);
  light.position.set(0.4, 0.8, 1);
  camera.add(light);

  const cube = new THREE.Group();
  scene.add(cube);

  const pickable = [];
  const labels = [];
  for (const region of regions()) {
    const geometry = polygonGeometry(region.points, region.dir);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial());
    mesh.userData = region;
    cube.add(mesh);
    pickable.push(mesh);
    const outline = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), new THREE.LineBasicMaterial());
    cube.add(outline);
    region.outline = outline;

    if (region.kind === 'face') {
      const { face } = region;
      const label = new THREE.Mesh(
        new THREE.PlaneGeometry(2 * A, 2 * A),
        new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }),
      );
      const n = vec(face.n);
      // The four in-plane turns of the label; draw picks the one that reads upright on screen.
      const turns = [vec(face.up), vec(face.right).negate(), vec(face.up).negate(), vec(face.right)].map((up) => ({
        up,
        quaternion: new THREE.Quaternion().setFromRotationMatrix(
          new THREE.Matrix4().makeBasis(up.clone().cross(n), up, n),
        ),
      }));
      label.position.copy(n.clone().multiplyScalar(1.002));
      label.userData = { label: face.label, turns };
      cube.add(label);
      labels.push(label);
    }
  }

  const colors = {};
  let hovered = null;
  let lastCamera = null;

  function paint() {
    for (const mesh of pickable) {
      const base = mesh.userData.kind === 'face' ? colors.face : colors.chamfer;
      mesh.material.color.copy(mesh === hovered ? colors.hover : base);
      mesh.userData.outline.material.color.copy(colors.line);
    }
  }

  function orientLabels() {
    camera.updateMatrixWorld();
    const screenUp = new THREE.Vector3()
      .setFromMatrixColumn(camera.matrixWorld, 1)
      .applyQuaternion(cube.quaternion.clone().invert());
    for (const label of labels) {
      let best = label.userData.turns[0];
      for (const turn of label.userData.turns) {
        if (turn.up.dot(screenUp) > best.up.dot(screenUp)) {
          best = turn;
        }
      }
      label.quaternion.copy(best.quaternion);
    }
  }

  function draw() {
    if (lastCamera) {
      const { eye, center, up } = lastCamera;
      camera.position.set(eye.x - center.x, eye.y - center.y, eye.z - center.z).setLength(4);
      camera.up.set(up.x, up.y, up.z);
      camera.lookAt(0, 0, 0);
    }
    orientLabels();
    renderer.render(scene, camera);
  }

  function pick(ev) {
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, camera);
    return raycaster.intersectObjects(pickable, false)[0]?.object ?? null;
  }

  function setHovered(mesh) {
    if (mesh === hovered) {
      return;
    }
    hovered = mesh;
    canvas.style.cursor = mesh ? 'pointer' : '';
    paint();
    draw();
  }

  canvas.addEventListener('pointermove', (ev) => setHovered(pick(ev)));
  canvas.addEventListener('pointerleave', () => setHovered(null));
  canvas.addEventListener('click', (ev) => {
    const mesh = pick(ev);
    if (mesh) {
      onPick(mesh.userData.dir.clone().applyQuaternion(cube.quaternion).normalize());
    }
  });

  return {
    /** Follows the main viewer's camera, an Online3DViewer Camera with eye, center and up. */
    render(navCamera) {
      lastCamera = navCamera;
      draw();
    },

    setUpAxis(axis) {
      // Y-up worlds hold the CAD frame turned -90° around X, so CAD front (-Y) lands on +Z.
      cube.rotation.x = axis === 'Y' ? -Math.PI / 2 : 0;
      draw();
    },

    /** Takes #rrggbb strings for face, chamfer, line, hover and text. */
    setColors(theme) {
      for (const key of ['face', 'chamfer', 'line', 'hover']) {
        colors[key] = new THREE.Color().setStyle(theme[key], THREE.SRGBColorSpace);
      }
      const fontFamily = getComputedStyle(document.body).fontFamily || 'sans-serif';
      for (const label of labels) {
        label.material.map?.dispose();
        label.material.map = labelTexture(label.userData.label, theme.text, fontFamily);
        label.material.needsUpdate = true;
      }
      paint();
      draw();
    },
  };
}
