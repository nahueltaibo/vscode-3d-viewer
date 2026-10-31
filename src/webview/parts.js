import { IntersectionMode } from 'online-3d-viewer';

// Rows are keyed by name path rather than node id, so hidden parts survive a reload of a rewritten file.
function buildTree(model) {
  const items = [];
  const visit = (node, parent, path, depth) => {
    const names = new Map();
    const children = [];
    for (const child of node.GetChildNodes()) {
      const meshIndices = child.GetMeshIndices();
      let name = child.GetName();
      if (!name && meshIndices.length === 1) {
        name = model.GetMesh(meshIndices[0]).GetName();
      }
      name ||= 'Part';
      const seen = names.get(name) ?? 0;
      names.set(name, seen + 1);
      const childPath = `${path}/${name}#${seen}`;
      const item = { name, path: childPath, depth, parent, children: [], keys: new Set() };
      for (const meshIndex of meshIndices) {
        item.keys.add(`${child.GetId()}:${meshIndex}`);
      }
      visit(child, item, childPath, depth + 1);
      for (const sub of item.children) {
        sub.keys.forEach((key) => item.keys.add(key));
      }
      // 3MF wraps each object's mesh in a child node of the same name.
      if (item.children.length === 1 && item.children[0].name === name && item.children[0].children.length === 0) {
        items.splice(items.indexOf(item.children[0]), 1);
        item.children = [];
      }
      if (item.keys.size > 0) {
        children.push(item);
        items.push(item);
      }
    }
    if (parent) {
      parent.children = children;
    }
    return children;
  };
  const roots = visit(model.GetRootNode(), null, '', 0);

  // Meshes on the root node itself have no row of their own.
  const rootKeys = model.GetRootNode().GetMeshIndices().map((i) => `${model.GetRootNode().GetId()}:${i}`);
  if (rootKeys.length > 0) {
    const item = { name: 'Model', path: '/#root', depth: 0, parent: null, children: [], keys: new Set(rootKeys) };
    roots.unshift(item);
    items.push(item);
  }
  return { roots, items };
}

const keyOf = (userData) => userData.originalMeshInstance.id.GetKey();

/**
 * Assembly tree with per-part visibility. Hover a row to highlight the part,
 * click a part in the 3D view to select its row.
 */
export function createPartsPanel({ viewer, button, panel, list, showAll, highlightColor, onOpenChange }) {
  let tree = { roots: [], items: [] };
  const hidden = new Set();
  const expanded = new Set();
  let hovered = null;
  let selected = null;

  const isVisible = (userData) => !hidden.has(keyOf(userData));

  function applyHighlight() {
    const keys = new Set([...(hovered?.keys ?? []), ...(selected?.keys ?? [])]);
    viewer.SetMeshesHighlight(highlightColor(), (userData) => keys.has(keyOf(userData)));
  }

  function applyVisibility() {
    viewer.SetMeshesVisibility(isVisible);
    for (const item of tree.items) {
      const hiddenCount = [...item.keys].filter((key) => hidden.has(key)).length;
      item.checkbox.checked = hiddenCount === 0;
      item.checkbox.indeterminate = hiddenCount > 0 && hiddenCount < item.keys.size;
      item.row.classList.toggle('hidden-part', hiddenCount === item.keys.size);
    }
  }

  function setExpanded(item, open) {
    if (open) {
      expanded.add(item.path);
    } else {
      expanded.delete(item.path);
    }
    item.row.dataset.expanded = String(open);
    item.childList.hidden = !open;
  }

  function select(item) {
    selected?.row.classList.remove('selected');
    selected = item;
    if (item) {
      item.row.classList.add('selected');
      for (let p = item.parent; p; p = p.parent) {
        setExpanded(p, true);
      }
      item.row.scrollIntoView({ block: 'nearest' });
    }
    applyHighlight();
  }

  function renderItem(item) {
    const li = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'part';
    row.style.paddingLeft = `${4 + item.depth * 14}px`;
    row.title = item.name;

    const twisty = document.createElement('span');
    twisty.className = 'twisty';
    if (item.children.length > 0) {
      twisty.textContent = '›';
      twisty.addEventListener('click', () => setExpanded(item, item.childList.hidden));
    }

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.setAttribute('aria-label', `Show ${item.name}`);
    checkbox.addEventListener('change', () => {
      for (const key of item.keys) {
        if (checkbox.checked) {
          hidden.delete(key);
        } else {
          hidden.add(key);
        }
      }
      applyVisibility();
    });

    const label = document.createElement('span');
    label.className = 'name';
    label.textContent = item.name;
    label.addEventListener('click', () => select(selected === item ? null : item));

    const isolate = document.createElement('button');
    isolate.className = 'isolate link';
    isolate.textContent = 'Isolate';
    isolate.title = `Show only ${item.name}`;
    isolate.addEventListener('click', () => {
      hidden.clear();
      for (const other of tree.items) {
        other.keys.forEach((key) => !item.keys.has(key) && hidden.add(key));
      }
      applyVisibility();
    });

    row.append(twisty, checkbox, label, isolate);
    row.addEventListener('pointerenter', () => {
      hovered = item;
      applyHighlight();
    });
    row.addEventListener('pointerleave', () => {
      hovered = null;
      applyHighlight();
    });

    const childList = document.createElement('ul');
    item.children.forEach((child) => childList.appendChild(renderItem(child)));
    li.append(row, childList);
    Object.assign(item, { row, checkbox, childList });
    setExpanded(item, item.children.length > 0 && (expanded.has(item.path) || item.depth === 0));
    return li;
  }

  viewer.SetMouseClickHandler((buttonIndex, coords) => {
    if (buttonIndex !== 1 || panel.hidden) {
      return;
    }
    const userData = viewer.GetMeshUserDataUnderMouse(IntersectionMode.MeshOnly, coords);
    const key = userData && keyOf(userData);
    // The deepest row holding the mesh is the part itself; its ancestors are assemblies.
    const item = key ? tree.items.filter((i) => i.keys.has(key)).sort((a, b) => b.depth - a.depth)[0] : null;
    select(item ?? null);
  });

  function setOpen(open) {
    panel.hidden = !open;
    button.setAttribute('aria-pressed', String(open));
    if (!open) {
      select(null);
    }
    onOpenChange(open);
  }

  button.addEventListener('click', () => setOpen(panel.hidden));
  showAll.addEventListener('click', () => {
    hidden.clear();
    applyVisibility();
  });

  return {
    isVisible,
    setOpen,

    /** Rebuilds the tree for a new model. keepState restores hidden parts by name path. */
    load(model, keepState) {
      const hiddenPaths = new Set();
      if (keepState) {
        for (const item of tree.items) {
          if (item.children.length === 0 && [...item.keys].every((key) => hidden.has(key))) {
            hiddenPaths.add(item.path);
          }
        }
      } else {
        expanded.clear();
      }
      hidden.clear();
      hovered = null;
      selected = null;

      tree = buildTree(model);
      for (const item of tree.items) {
        if (hiddenPaths.has(item.path)) {
          item.keys.forEach((key) => hidden.add(key));
        }
      }
      list.replaceChildren(...tree.roots.map(renderItem));
      button.hidden = tree.items.length < 2;
      if (button.hidden) {
        panel.hidden = true;
      }
      applyVisibility();
    },
  };
}
