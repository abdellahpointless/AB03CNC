// Measuring on a 3D view, as in a CAD program: a click (not a drag) picks a flat face (its exact height on the
// surface drawn), a hole (its fitted Ø) or a point; one feature measures itself, a second the distance between the
// two; the dimension stands off the part with its label. Used by the simulator (Toolpath3D, on the part cut) and by
// CAM AI on the model before any program (CamPartView).
import * as THREE from 'three';
import { locale } from '../i18n/format';
import { between, holeAxis, placeDimension, type Feature, type MeasureMode } from './measure';
import type { Hole } from './stockSim';
import type { Vec } from './toolpath';

/** What the clicks measure (mm): a hole's Ø, the distance between two picks (with its X/Y/Z parts), the first of two picked, or why not. */
export type Measurement =
  | { kind: 'hole'; mm: number; depth: number; tool: string }
  | { kind: 'distance'; mm: number; d?: Vec }
  | { kind: 'picked' | 'none' | 'notParallel' }
  | null;

export interface MeasureHost {
  /** The view's element: the clicks come from it, the labels go in it. */
  el: HTMLElement;
  /** What the marks hang from: its own frame is the part's (picks are in it). */
  root: THREE.Object3D;
  camera: THREE.Camera;
  invalidate: () => void;
  /** Called after each frame drawn (the labels follow the part on screen). */
  setAfterRender: (f: (() => void) | null) => void;
  /** What can be measured (meshes in `root`'s frame). */
  parts: () => THREE.Mesh[];
  /** What stands in front and only takes a point (the vise, the parallels). */
  blockers?: () => THREE.Object3D[];
  /** The hole a click on a part picked. */
  holeAt: (p: Vec, hit: THREE.Intersection) => Hole | null;
  mode: () => MeasureMode;
  onMeasure: (m: Measurement) => void;
  /** The tool that made a hole (the simulator: from its plunges). */
  toolName?: (tool: number | null) => string;
}

export function disposeTree(o: THREE.Object3D) {
  o.traverse((x) => {
    const m = x as THREE.Mesh;
    m.geometry?.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach((y) => {
      (y as THREE.SpriteMaterial).map?.dispose();
      y.dispose();
    });
  });
}

const ACCENT = 0x22d3ee;
const v = (p: Vec) => new THREE.Vector3(p[0], p[1], p[2]);

/** A circle round an axis (a hole's rim). */
export function ring(centre: Vec, u: Vec, r: number, mat: THREE.Material): THREE.Line {
  const ax = v(u);
  const e1 = new THREE.Vector3(Math.abs(ax.x) < 0.9 ? 1 : 0, Math.abs(ax.x) < 0.9 ? 0 : 1, 0).cross(ax).normalize();
  const e2 = ax.clone().cross(e1);
  const pts = Array.from({ length: 97 }, (_, i) => v(centre).addScaledVector(e1, r * Math.cos((i / 96) * Math.PI * 2)).addScaledVector(e2, r * Math.sin((i / 96) * Math.PI * 2)));
  return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat);
}

/** Starts measuring on a view; returns how to start the picks again and how to stop. */
export function attachMeasure(h: MeasureHost): { reset: () => void; stop: () => void } {
  const { el, root } = h;
  let alive = true;
  const marks = new THREE.Group();
  root.add(marks);
  const marked = new THREE.Group();
  const dims = new THREE.Group();
  marks.add(marked, dims);
  const tags: { el: HTMLDivElement; at: THREE.Vector3 }[] = [];
  // The part's extent, in its own frame: its outermost flat faces (exact), not the outermost
  // vertex (a corner of the sampled surface can stick out a little).
  const extent = () => {
    const min: Vec = [Infinity, Infinity, Infinity];
    const max: Vec = [-Infinity, -Infinity, -Infinity];
    for (const c of h.parts()) {
      const P = c.geometry.getAttribute('position').array as Float32Array;
      for (let i = 0; i < P.length; i += 9)
        for (let k = 0; k < 3; k++) {
          const z = P[i + k];
          if (Math.abs(P[i + 3 + k] - z) > 0.005 || Math.abs(P[i + 6 + k] - z) > 0.005) continue;
          // Flat and square to axis k: which way it faces.
          const e1 = [P[i + 3] - P[i], P[i + 4] - P[i + 1], P[i + 5] - P[i + 2]];
          const e2 = [P[i + 6] - P[i], P[i + 7] - P[i + 1], P[i + 8] - P[i + 2]];
          const n = e1[(k + 1) % 3] * e2[(k + 2) % 3] - e1[(k + 2) % 3] * e2[(k + 1) % 3];
          if (n > 0) max[k] = Math.max(max[k], z);
          else if (n < 0) min[k] = Math.min(min[k], z);
        }
    }
    const bb = new THREE.Box3();
    for (const c of h.parts()) {
      c.geometry.computeBoundingBox();
      bb.union(c.geometry.boundingBox!);
    }
    for (let k = 0; k < 3; k++) {
      if (!Number.isFinite(min[k])) min[k] = bb.min.getComponent(k);
      if (!Number.isFinite(max[k])) max[k] = bb.max.getComponent(k);
    }
    return { min, max, size: bb.getSize(new THREE.Vector3()).length() || 100 };
  };
  // Lines and faces fade in fast: each pick gets its own materials.
  const fresh = <M extends THREE.Material>(m: M, to: number) => {
    m.transparent = true;
    m.opacity = 0;
    const t0 = performance.now();
    const step = (now: number) => {
      if (!alive) return;
      const k = Math.min(1, (now - t0) / 180);
      m.opacity = to * k;
      h.invalidate();
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    return m;
  };
  const line = (pts: Vec[], mat: THREE.Material) => new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts.map(v)), mat);
  const clear = (g: THREE.Group) => {
    disposeTree(g);
    g.clear();
  };
  const clearTags = () => {
    tags.forEach((t) => t.el.remove());
    tags.length = 0;
  };
  // The label: off the part, following it on screen, popping in.
  const tag = (text: string, at: Vec) => {
    const d = document.createElement('div');
    d.className = 'pointer-events-none absolute left-0 top-0 whitespace-nowrap rounded-md bg-[#22d3ee] px-2 py-0.5 font-mono text-[13px] font-bold text-[#062a33] shadow-[0_4px_16px_rgba(0,0,0,0.45)]';
    d.textContent = text;
    d.style.opacity = '0';
    d.style.scale = '0.8';
    d.style.transition = 'opacity 160ms ease-out, scale 240ms cubic-bezier(0.22, 1, 0.36, 1)';
    el.appendChild(d);
    tags.push({ el: d, at: v(at) });
    requestAnimationFrame(() => {
      d.style.opacity = '1';
      d.style.scale = '1';
    });
    h.invalidate();
  };
  h.setAfterRender(() => {
    const w = el.clientWidth;
    const hh = el.clientHeight;
    for (const t of tags) {
      const p = t.at.clone().applyMatrix4(root.matrixWorld).project(h.camera);
      t.el.style.transform = `translate(${((p.x + 1) / 2) * w}px, ${((1 - p.y) / 2) * hh}px) translate(-50%, -50%)`;
      t.el.style.visibility = p.z < 1 ? 'visible' : 'hidden';
    }
  });
  // Always two decimals, as on a drawing (30,00 mm).
  const mm = (x: number) => `${x.toLocaleString(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })} mm`;
  // A flat face's triangles on the surface (all three corners on it, facing the same way).
  const faceTris = (axis: number, at: number, sign: number, tol: number) => {
    const out: number[] = [];
    for (const c of h.parts()) {
      const P = c.geometry.getAttribute('position').array as Float32Array;
      for (let i = 0; i < P.length; i += 9) {
        if (Math.abs(P[i + axis] - at) > tol || Math.abs(P[i + 3 + axis] - at) > tol || Math.abs(P[i + 6 + axis] - at) > tol) continue;
        const e1 = [P[i + 3] - P[i], P[i + 4] - P[i + 1], P[i + 5] - P[i + 2]];
        const e2 = [P[i + 6] - P[i], P[i + 7] - P[i + 1], P[i + 8] - P[i + 2]];
        const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const l = Math.hypot(n[0], n[1], n[2]);
        if (l > 0 && (sign * n[axis]) / l > 0.97) for (let k = 0; k < 9; k++) out.push(P[i + k]);
      }
    }
    return out;
  };
  const mark = (f: Feature) => {
    if (f.kind === 'point') {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(Math.max(0.3, extent().size * 0.005), 16, 12), fresh(new THREE.MeshBasicMaterial({ color: ACCENT, depthTest: false }), 1));
      dot.position.set(...f.p);
      marked.add(dot);
      return;
    }
    if (f.kind === 'hole') {
      const { u } = holeAxis(f.hole);
      const mat = fresh(new THREE.LineBasicMaterial({ color: ACCENT, depthTest: false }), 1);
      marked.add(ring(f.hole.top, u, f.hole.r, mat), ring(f.hole.bottom, u, f.hole.r, mat));
      return;
    }
    const tris = faceTris(f.axis, f.at, f.sign, 0.03);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(tris, 3));
    const mat = fresh(new THREE.MeshBasicMaterial({ color: ACCENT, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }), 0.55);
    const face = new THREE.Mesh(geo, mat);
    // Over any other overlay on the same face (a setup's top in CAM AI's view).
    face.renderOrder = 5;
    marked.add(face);
  };
  // The dimension: extension lines from the features out to a line parallel to what is measured.
  const dimension = (m: { from: Vec; to: Vec; dir: Vec }, text: string, ext: ReturnType<typeof extent>, leader = false) => {
    const d = placeDimension(m.from, m.to, m.dir, ext, ext.size * 0.1);
    const mat = fresh(new THREE.LineBasicMaterial({ color: ACCENT, depthTest: false }), 1);
    dims.add(line(leader ? [m.from, d.a] : [m.from, d.a, m.to, d.b, d.a, d.b], mat));
    tag(text, d.label);
  };
  const feats: Feature[] = [];
  // What a click picks in this mode: a point as it is, a hole, or a flat face.
  const pick = (p: Vec, n: Vec, hit: THREE.Intersection): Feature | null => {
    if (h.mode() === 'points') return { kind: 'point', p };
    if (h.mode() !== 'faces') {
      const hole = h.holeAt(p, hit);
      return hole ? { kind: 'hole', hole } : null;
    }
    const axis = [0, 1, 2].reduce((b, k) => (Math.abs(n[k]) > Math.abs(n[b]) ? k : b), 0) as 0 | 1 | 2;
    if (Math.abs(n[axis]) < 0.97) return null;
    const sign = n[axis] > 0 ? 1 : -1;
    // The face's exact height: the surface's triangles there, not the clicked point.
    const near = faceTris(axis, p[axis], sign, 0.15);
    let at = p[axis];
    if (near.length) {
      let sum = 0;
      for (let i = axis; i < near.length; i += 3) sum += near[i];
      at = sum / (near.length / 3);
    }
    return { kind: 'face', axis, at, sign, p };
  };

  const raycaster = new THREE.Raycaster();
  let down: { x: number; y: number; t: number } | null = null;
  const onDown = (e: PointerEvent) => (down = { x: e.clientX, y: e.clientY, t: performance.now() });
  const reset = () => {
    feats.length = 0;
    clear(marked);
    clear(dims);
    clearTags();
  };
  const onUp = (e: PointerEvent) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 || performance.now() - down.t > 600) return;
    const r = el.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), h.camera);
    root.updateMatrixWorld(true);
    const parts = h.parts();
    const hit = raycaster.intersectObjects([...parts, ...(h.blockers?.() ?? [])], false)[0];
    if (!hit?.face) return;
    if (!parts.includes(hit.object as THREE.Mesh) && h.mode() !== 'points') return h.onMeasure({ kind: 'none' });
    const q = root.worldToLocal(hit.point.clone());
    // The face's normal in the part's frame (the parts hang from root, unturned).
    const nrm = hit.face.normal.clone();
    const f = pick([q.x, q.y, q.z], [nrm.x, nrm.y, nrm.z], hit);
    if (!f) return h.onMeasure({ kind: 'none' });
    const ext = extent();
    if (f.kind === 'hole' && h.mode() === 'diameter') {
      // Each hole by itself: its Ø on a leader from the rim, out past the part.
      reset();
      mark(f);
      const { u, depth } = holeAxis(f.hole);
      const out = placeDimension(f.hole.top, f.hole.top, u, ext, 0).a;
      const side = new THREE.Vector3().subVectors(v(out), v(f.hole.top));
      const rim: Vec = side.lengthSq() > 1e-9 ? (v(f.hole.top).addScaledVector(side.normalize(), f.hole.r).toArray() as Vec) : f.hole.top;
      dimension({ from: rim, to: rim, dir: u }, `Ø ${mm(f.hole.r * 2)}`, ext, true);
      h.onMeasure({ kind: 'hole', mm: f.hole.r * 2, depth, tool: h.toolName?.(f.hole.tool) ?? '' });
      return;
    }
    // Two picks measure: the first is marked, the second gives the distance; a third starts again.
    if (feats.length !== 1) {
      reset();
      feats.push(f);
      mark(f);
      return h.onMeasure({ kind: 'picked' });
    }
    const m = between(feats[0], f);
    if (!m) return h.onMeasure({ kind: 'notParallel' });
    feats.push(f);
    mark(f);
    dimension(m, mm(m.mm), ext);
    // Points and axes: also how far apart along X, Y and Z of the part.
    const d: Vec = [m.to[0] - m.from[0], m.to[1] - m.from[1], m.to[2] - m.from[2]];
    h.onMeasure({ kind: 'distance', mm: m.mm, d: f.kind === 'face' ? undefined : d });
  };
  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointerup', onUp);
  el.style.cursor = 'crosshair';
  return {
    reset: () => {
      reset();
      h.onMeasure(null);
      h.invalidate();
    },
    stop: () => {
      alive = false;
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointerup', onUp);
      el.style.cursor = '';
      clearTags();
      h.setAfterRender(null);
      disposeTree(marks);
      root.remove(marks);
      h.invalidate();
    },
  };
}
