import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Toolpath, Vec } from '../lib/toolpath';
import type { Face, SetupInfo } from '../lib/setups';

/*
 * 3D view of one setup: the vise (or modular fixture), the parallels, the part block, the
 * toolpath of that setup and the tool. Machine X/Y/Z map to three.js X/Z/-Y (Y up), so the
 * operator side of the machine (Y-) faces the camera.
 */

const v3 = (p: Vec) => new THREE.Vector3(p[0], p[2], -p[1]);
const FACE_DIR: Record<Face, Vec> = { 'X+': [1, 0, 0], 'X-': [-1, 0, 0], 'Y+': [0, 1, 0], 'Y-': [0, -1, 0], 'Z+': [0, 0, 1], 'Z-': [0, 0, -1] };

interface Props {
  path: Toolpath;
  setup: SetupInfo | null;
  /** First and last move index shown. */
  range: [number, number];
  /** Moves done (index of the current move + 1). */
  step: number;
  colorOf: (tool: number | null) => string;
  /** Change it to fit the camera again. */
  fitKey: number;
}

function label(text: string, color: string): THREE.Sprite {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  ctx.font = 'bold 44px system-ui, sans-serif';
  const w = Math.ceil(ctx.measureText(text).width) + 36;
  c.width = w;
  c.height = 68;
  ctx.font = 'bold 44px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(10,15,25,0.85)';
  ctx.beginPath();
  ctx.roundRect(0, 0, w, 68, 22);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 18, 36);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.renderOrder = 10;
  s.userData.aspect = w / 68;
  return s;
}

function box(min: Vec, max: Vec, color: number, opacity: number, edges = 0x000000): THREE.Group {
  const g = new THREE.Group();
  const size = new THREE.Vector3(max[0] - min[0], max[2] - min[2], max[1] - min[1]);
  const geo = new THREE.BoxGeometry(size.x, size.y, size.z);
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ color, transparent: opacity < 1, opacity, metalness: 0.35, roughness: 0.55, depthWrite: opacity >= 1 }),
  );
  g.add(mesh);
  if (edges) g.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: edges, transparent: true, opacity: 0.7 })));
  g.position.copy(v3([(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]));
  return g;
}

export default function Toolpath3D({ path, setup, range, step, colorOf, fitKey }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<{
    renderer: THREE.WebGLRenderer;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    scene: THREE.Scene;
    world: THREE.Group;
    fit: () => void;
    progress: (step: number) => void;
    flip: (deg: number, axis: 'X' | 'Y' | 'Z') => void;
  } | null>(null);

  // Renderer, camera and controls live as long as the view.
  useEffect(() => {
    const el = host.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x0a0f19);
    el.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x1a2030, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(120, 260, 180);
    scene.add(sun);
    const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 5000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    const world = new THREE.Group();
    scene.add(world);

    const resize = () => {
      const w = el.clientWidth || 1;
      const h = el.clientHeight || 1;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    let raf = 0;
    const loop = () => {
      controls.update();
      world.userData.tick?.(performance.now());
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    api.current = {
      renderer,
      camera,
      controls,
      scene,
      world,
      fit: () => undefined,
      progress: () => undefined,
      flip: () => undefined,
    };
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      world.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach((x) => {
          (x as THREE.SpriteMaterial).map?.dispose();
          x.dispose();
        });
      });
      renderer.dispose();
      renderer.domElement.remove();
      api.current = null;
    };
  }, []);

  // The setup's scene: fixture, part, toolpath, tool.
  useEffect(() => {
    const a = api.current;
    if (!a) return;
    const { world, camera, controls } = a;
    world.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m !== (world as unknown)) m.geometry?.dispose();
    });
    world.clear();
    world.userData.tick = undefined;

    const [first, last] = range;
    const moves = path.moves.slice(first, last + 1);

    // Toolpath: feeds in the tool's colour, rapids dashed grey, ghost of the whole setup.
    const feedPos: number[] = [];
    const feedCol: number[] = [];
    const rapidPos: number[] = [];
    const feedEnd: number[] = [];
    const rapidEnd: number[] = [];
    const col = new THREE.Color();
    const push = (arr: number[], p: Vec) => arr.push(p[0], p[2], -p[1]);
    for (const m of moves) {
      const pts: Vec[] = m.kind === 'drill' ? [m.points[0], [m.points[0][0], m.points[0][1], m.depth ?? m.points[0][2]]] : m.points;
      const target = m.kind === 'rapid' ? rapidPos : feedPos;
      if (m.kind !== 'rapid') col.set(colorOf(m.tool));
      for (let i = 1; i < pts.length; i++) {
        push(target, pts[i - 1]);
        push(target, pts[i]);
        if (m.kind !== 'rapid') feedCol.push(col.r, col.g, col.b, col.r, col.g, col.b);
      }
      feedEnd.push(feedPos.length / 3);
      rapidEnd.push(rapidPos.length / 3);
    }
    const feedAttr = new THREE.Float32BufferAttribute(feedPos, 3);
    const rapidAttr = new THREE.Float32BufferAttribute(rapidPos, 3);
    const ghostGeo = new THREE.BufferGeometry();
    ghostGeo.setAttribute('position', feedAttr);
    world.add(new THREE.LineSegments(ghostGeo, new THREE.LineBasicMaterial({ color: 0x2a3650, transparent: true, opacity: 0.8 })));
    const feedGeo = new THREE.BufferGeometry();
    feedGeo.setAttribute('position', feedAttr);
    feedGeo.setAttribute('color', new THREE.Float32BufferAttribute(feedCol, 3));
    const feeds = new THREE.LineSegments(feedGeo, new THREE.LineBasicMaterial({ vertexColors: true }));
    world.add(feeds);
    const rapidGeo = new THREE.BufferGeometry();
    rapidGeo.setAttribute('position', rapidAttr);
    const rapids = new THREE.LineSegments(rapidGeo, new THREE.LineDashedMaterial({ color: 0x7f8ba0, dashSize: 2, gapSize: 2, transparent: true, opacity: 0.6 }));
    rapids.computeLineDistances();
    world.add(rapids);

    // Fixture and part.
    const stockGroup = new THREE.Group();
    const fixture = new THREE.Group();
    world.add(fixture);
    const jaws: THREE.MeshStandardMaterial[] = [];
    const s = setup?.stock;
    let floorZ = Math.min(path.min[2], 0) - 10;
    if (setup && s) {
      floorZ = setup.floorZ ?? s.min[2];
      const pivot = v3([(s.min[0] + s.max[0]) / 2, (s.min[1] + s.max[1]) / 2, (s.min[2] + s.max[2]) / 2]);
      stockGroup.position.copy(pivot);
      const part = box(s.min, s.max, 0xb9c6da, 0.32, 0xdfe8f5);
      part.position.sub(pivot);
      stockGroup.add(part);
      world.add(stockGroup);

      const sup = s.min[2] - floorZ;
      if (sup > 0.5) {
        // Two parallels along X under the part, near the Y faces.
        const w = Math.min(8, (s.max[1] - s.min[1]) / 4);
        for (const y0 of [s.min[1] + 0.5, s.max[1] - 0.5 - w]) {
          fixture.add(box([s.min[0] - 8, y0, floorZ], [s.max[0] + 8, y0 + w, s.min[2]], 0x8b95a7, 1, 0x30384a));
        }
      }
      if (setup.jawTopZ !== null) {
        const cx = (s.min[0] + s.max[0]) / 2;
        const hw = setup.jawHalfWidth;
        const base = floorZ - 28;
        for (const [y0, y1] of [[s.max[1], s.max[1] + 24], [s.min[1] - 24, s.min[1]]] as [number, number][]) {
          const jaw = box([cx - hw, y0, base], [cx + hw, y1, setup.jawTopZ], 0x5a6a82, 0.45, 0x9fb0c8);
          jaws.push((jaw.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial);
          fixture.add(jaw);
        }
        fixture.add(box([cx - hw, s.min[1] - 24, base - 14], [cx + hw, s.max[1] + 24, floorZ], 0x3b4659, 0.75, 0x55627a));
        // The top of the jaws as a thin red line all around.
        const line = new THREE.LineSegments(
          new THREE.EdgesGeometry(new THREE.BoxGeometry(hw * 2, 0.01, s.max[1] - s.min[1] + 48)),
          new THREE.LineBasicMaterial({ color: 0xf26d6d, transparent: true, opacity: 0.55 }),
        );
        line.position.copy(v3([cx, (s.min[1] + s.max[1]) / 2, setup.jawTopZ]));
        fixture.add(line);
      } else {
        // Modular fixture: a block under the part.
        fixture.add(box([s.min[0] - 6, s.min[1] - 6, floorZ - 30], [s.max[0] + 6, s.max[1] + 6, floorZ], 0x3b4659, 1, 0x1c2433));
      }

      // RAFI / TASTER: an arrow from the part toward the faces the program names, and a label.
      if (setup.marker && setup.marker.faces.length) {
        const d: Vec = [0, 0, 0];
        for (const f of setup.marker.faces) FACE_DIR[f].forEach((x, i) => (d[i] += x));
        const half: Vec = [(s.max[0] - s.min[0]) / 2, (s.max[1] - s.min[1]) / 2, (s.max[2] - s.min[2]) / 2];
        const edge = new THREE.Vector3(d[0] * half[0], d[2] * half[2], -d[1] * half[1]);
        const dir = new THREE.Vector3(d[0], d[2], -d[1]).normalize();
        const len = Math.max(12, Math.max(...half) * 0.6);
        const arrow = new THREE.ArrowHelper(dir, edge, len, 0xffa94d, len * 0.3, len * 0.18);
        stockGroup.add(arrow);
        const tag = label(`${setup.marker.name} ${setup.marker.faces.join(' ')}`, '#FFB869');
        const h = Math.max(6, Math.max(...half) * 0.22);
        tag.scale.set(h * tag.userData.aspect, h, 1);
        tag.position.copy(edge.clone().add(dir.clone().multiplyScalar(len + h)));
        stockGroup.add(tag);
        // Tint the named side faces.
        for (const f of setup.marker.faces) {
          const n = FACE_DIR[f];
          const axis = n.findIndex((x) => x !== 0);
          const sz = [half[0] * 2, half[1] * 2, half[2] * 2];
          const plane = new THREE.Mesh(
            new THREE.PlaneGeometry(axis === 0 ? sz[1] : sz[0], axis === 2 ? sz[1] : sz[2]),
            new THREE.MeshBasicMaterial({ color: 0xffa94d, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }),
          );
          const off = new THREE.Vector3(n[0] * (half[0] + 0.2), n[2] * (half[2] + 0.2), -n[1] * (half[1] + 0.2));
          plane.position.copy(off);
          if (axis === 0) plane.rotation.y = Math.PI / 2;
          if (axis === 2) plane.rotation.x = Math.PI / 2;
          stockGroup.add(plane);
        }
      }
    }

    // Floor grid where the supports stand.
    const span = Math.max(path.max[0] - path.min[0], path.max[1] - path.min[1], 60) * 2.2;
    const grid = new THREE.GridHelper(span, 22, 0x2c3953, 0x1a2234);
    const center = s ? [(s.min[0] + s.max[0]) / 2, (s.min[1] + s.max[1]) / 2] : [(path.min[0] + path.max[0]) / 2, (path.min[1] + path.max[1]) / 2];
    grid.position.copy(v3([center[0], center[1], floorZ - (setup?.jawTopZ !== null && s ? 42 : s ? 30 : 0)]));
    world.add(grid);

    // Jaw hits: red spheres.
    const hits = new THREE.Group();
    for (const c of setup?.collisions ?? []) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(1.8, 16, 12), new THREE.MeshBasicMaterial({ color: 0xff4d4d }));
      m.position.copy(v3(c.point));
      m.userData.move = c.move;
      hits.add(m);
    }
    world.add(hits);

    // Tool: cutter plus holder, bottom at the tool tip.
    const tool = new THREE.Group();
    const cutterMat = new THREE.MeshStandardMaterial({ color: 0xe8edf5, metalness: 0.8, roughness: 0.25, transparent: true, opacity: 0.92 });
    const holderMat = new THREE.MeshStandardMaterial({ color: 0x55627a, metalness: 0.6, roughness: 0.4 });
    const cutter = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 32), cutterMat);
    const holder = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 32), holderMat);
    tool.add(cutter, holder);
    world.add(tool);
    const sizeOf = new Map(path.tools.map((t) => [t.tool, t]));
    const hitMoves = new Set((setup?.collisions ?? []).map((c) => c.move));

    a.progress = (n: number) => {
      const k = Math.min(Math.max(n - 1, first - 1), last) - first; // index in this setup
      feedGeo.setDrawRange(0, k >= 0 ? feedEnd[k] : 0);
      rapidGeo.setDrawRange(0, k >= 0 ? rapidEnd[k] : 0);
      const cur = k >= 0 ? moves[k] : null;
      tool.visible = !!cur;
      if (cur) {
        const p = cur.points[cur.points.length - 1];
        const tip: Vec = cur.kind === 'drill' ? [p[0], p[1], cur.depth ?? p[2]] : p;
        const info = sizeOf.get(cur.tool ?? -1);
        const r = Math.max(0.5, (info?.diameter ?? 6) / 2);
        const len = Math.min(Math.max(info?.length ?? r * 8, r * 3, 12), 80);
        cutter.scale.set(r, len, r);
        cutter.position.set(0, len / 2, 0);
        const hr = Math.max(r * 1.25, 9);
        holder.scale.set(hr, 28, hr);
        holder.position.set(0, len + 14, 0);
        tool.position.copy(v3(tip));
        const hit = hitMoves.has(first + k);
        cutterMat.color.set(hit ? 0xff5c5c : 0xe8edf5);
        jaws.forEach((j) => j.color.set(hit ? 0xa84a4a : 0x5a6a82));
      }
      hits.children.forEach((h) => (((h as THREE.Mesh).material as THREE.MeshBasicMaterial).color.set(h.userData.move <= first + k ? 0xff4d4d : 0x7a3a3a)));
    };
    a.progress(step);

    a.flip = (deg, axis) => {
      if (!s || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
      const start = performance.now();
      const height = s.max[2] - s.min[2];
      const base = stockGroup.position.clone();
      const ax = axis === 'X' ? new THREE.Vector3(1, 0, 0) : axis === 'Y' ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
      const rad = (deg * Math.PI) / 180;
      world.userData.tick = (now: number) => {
        const p = Math.min(1, (now - start) / 1100);
        const e = 1 - Math.pow(1 - p, 3);
        stockGroup.quaternion.setFromAxisAngle(ax, -rad * (1 - e));
        stockGroup.position.copy(base).add(new THREE.Vector3(0, Math.sin(Math.PI * Math.min(1, p * 1.15)) * height * 1.2, 0));
        if (p >= 1) {
          stockGroup.quaternion.identity();
          stockGroup.position.copy(base);
          world.userData.tick = undefined;
        }
      };
    };

    a.fit = () => {
      const bb = new THREE.Box3();
      if (s) bb.expandByObject(stockGroup).expandByObject(fixture);
      if (feedPos.length || rapidPos.length) {
        const pb = new THREE.Box3();
        feedGeo.computeBoundingBox();
        if (feedPos.length) pb.union(feedGeo.boundingBox!);
        if (s) pb.intersect(new THREE.Box3().copy(bb).expandByScalar(60));
        bb.union(pb);
      }
      if (bb.isEmpty()) bb.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(50, 50, 50));
      const c = bb.getCenter(new THREE.Vector3());
      const size = bb.getSize(new THREE.Vector3()).length();
      controls.target.copy(c);
      camera.position.copy(c).add(new THREE.Vector3(0.7, 1.05, 1).normalize().multiplyScalar(size * 1.25));
      camera.near = size / 200;
      camera.far = size * 40;
      camera.updateProjectionMatrix();
      controls.update();
    };
    a.fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, setup, range[0], range[1], colorOf]);

  useEffect(() => api.current?.progress(step), [step]);
  useEffect(() => {
    if (fitKey) api.current?.fit();
  }, [fitKey]);
  // Turning the part: animate it when a setup with a rotation is opened.
  const lastSetup = useRef<number | null>(null);
  useEffect(() => {
    const idx = setup?.index ?? null;
    if (lastSetup.current !== null && idx !== null && idx > lastSetup.current && setup?.rotation) api.current?.flip(setup.rotation.deg, setup.rotation.axis);
    lastSetup.current = idx;
  }, [setup]);

  return <div ref={host} className="absolute inset-0 cursor-grab active:cursor-grabbing touch-none" />;
}
