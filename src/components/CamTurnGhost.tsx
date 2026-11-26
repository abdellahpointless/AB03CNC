import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { Mat3 } from '../lib/orient';

// Machine frame (X right, Y away, Z up) to the view's (Y up): x, z, -y.
const VIEW = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1);

/** The model (centred) laid by R (model -> clamping) and stood on the bed (its lowest point at 0), in the view's frame. */
function laid(R: Mat3, half: THREE.Vector3): THREE.Matrix4 {
  const m = new THREE.Matrix4().set(R[0], R[1], R[2], 0, R[3], R[4], R[5], 0, R[6], R[7], R[8], 0, 0, 0, 0, 1);
  // The lowest corner of the turned box: |R| times the half sizes, along Z.
  const lift = Math.abs(R[6]) * half.x + Math.abs(R[7]) * half.y + Math.abs(R[8]) * half.z;
  return new THREE.Matrix4().makeTranslation(0, lift, 0).multiply(VIEW).multiply(m);
}

/** A letter that always faces the camera. */
function letter(text: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#e5e7eb';
  g.font = '600 40px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 32, 34);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true }));
  s.renderOrder = 10;
  return s;
}

/**
 * The uploaded model as the operator turned it (you: a green see-through figure of the model, not the simulated part),
 * over grey lines of how it lies as made, on the vise bed, with the machine's X, Y and Z.
 */
export default function CamTurnGhost({ tris, made, turned, label }: { tris: Float32Array; made: Mat3; turned: Mat3; label: string }) {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<{ render: () => void; ghost: THREE.Object3D; was: THREE.Object3D; half: THREE.Vector3 } | null>(null);

  // The scene, once per model.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    el.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';
    const s = new THREE.Scene();
    s.add(new THREE.HemisphereLight(0xffffff, 0x334155, 1.2));
    const sun = new THREE.DirectionalLight(0xffffff, 0.9);
    sun.position.set(1, 2, 1.4);
    s.add(sun);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(tris, 3));
    geo.computeBoundingBox();
    const box = geo.boundingBox!;
    const centre = box.getCenter(new THREE.Vector3());
    geo.translate(-centre.x, -centre.y, -centre.z);
    geo.computeVertexNormals();
    const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    const edges = new THREE.EdgesGeometry(geo, 25);
    const ghost = new THREE.Group();
    ghost.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x22c55e, transparent: true, opacity: 0.42, depthWrite: false, side: THREE.DoubleSide, roughness: 0.7 })));
    ghost.add(new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x4ade80, transparent: true, opacity: 0.9 })));
    const was = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x94a3b8, transparent: true, opacity: 0.45 }));
    for (const o of [ghost, was]) o.matrixAutoUpdate = false;
    s.add(was, ghost);
    // The bed, and the machine's axes from a corner of it.
    const r = half.length();
    const bed = new THREE.GridHelper(r * 2.6, 8, 0x475569, 0x334155);
    s.add(bed);
    const corner = new THREE.Vector3(-r * 1.25, 0.01, r * 1.25);
    const axes: [THREE.Vector3, string][] = [[new THREE.Vector3(1, 0, 0), 'X'], [new THREE.Vector3(0, 0, -1), 'Y'], [new THREE.Vector3(0, 1, 0), 'Z']];
    for (const [d, n] of axes) {
      s.add(new THREE.ArrowHelper(d, corner, r * 0.55, 0xcbd5e1, r * 0.12, r * 0.07));
      const l = letter(n);
      l.position.copy(corner).addScaledVector(d, r * 0.72);
      l.scale.setScalar(r * 0.22);
      s.add(l);
    }
    const camera = new THREE.PerspectiveCamera(32, 1, r / 20, r * 40);
    camera.position.set(r * 2.4, r * 2.1, r * 3.1);
    camera.lookAt(0, half.length() * 0.45, 0);
    const render = () => {
      const w = el.clientWidth || 240;
      const h = el.clientHeight || 170;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.render(s, camera);
    };
    scene.current = { render, ghost, was, half };
    const ro = new ResizeObserver(render);
    ro.observe(el);
    return () => {
      ro.disconnect();
      scene.current = null;
      s.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        for (const x of Array.isArray(mat) ? mat : mat ? [mat] : []) {
          (x as THREE.SpriteMaterial).map?.dispose();
          x.dispose();
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [tris]);

  // Turned: only the two placements move.
  useEffect(() => {
    const v = scene.current;
    if (!v) return;
    v.ghost.matrix.copy(laid(turned, v.half));
    v.was.matrix.copy(laid(made, v.half));
    v.render();
  }, [tris, made, turned]);

  return <div ref={host} role="img" aria-label={label} className="w-full h-[170px] rounded-[8px] overflow-hidden border border-[var(--border-subtle)] bg-[#0B1222]" />;
}
