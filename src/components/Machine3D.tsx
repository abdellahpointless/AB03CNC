import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

/*
 * Procedural 3D models of the shop's machines (no model files to download).
 * Sizes are in metres and roughly follow the real machines; details are simplified.
 */

export type Machine3DKind = 'haas-vf3' | 'haas-vf2' | 'fanuc-robodrill' | 'dmg-cmx600v';
export type Machine3DState = 'ok' | 'due' | 'problem';

const C = {
  white: 0xeceef1,
  offWhite: 0xd9dce1,
  grey: 0xa9adb3,
  dark: 0x3a3e45,
  anthracite: 0x26292e,
  black: 0x141518,
  haasRed: 0xc8102e,
  fanucYellow: 0xf2c200,
  steel: 0x9aa1a8,
};

type Mats = ReturnType<typeof makeMaterials>;

function makeMaterials() {
  const std = (color: number, roughness = 0.5, metalness = 0.05) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
  return {
    white: std(C.white, 0.42),
    offWhite: std(C.offWhite, 0.5),
    grey: std(C.grey, 0.45, 0.2),
    dark: std(C.dark, 0.6, 0.15),
    anthracite: std(C.anthracite, 0.5, 0.25),
    black: std(C.black, 0.7),
    red: std(C.haasRed, 0.4),
    yellow: std(C.fanucYellow, 0.4),
    steel: std(C.steel, 0.3, 0.85),
    interior: std(0x0b0c0e, 0.9),
    glass: new THREE.MeshPhysicalMaterial({ color: 0xaecbe0, roughness: 0.05, metalness: 0, transparent: true, opacity: 0.22, clearcoat: 1 }),
    screenBlue: new THREE.MeshStandardMaterial({ color: 0x0d2140, emissive: 0x2f6fd6, emissiveIntensity: 0.55, roughness: 0.2 }),
    screenLight: new THREE.MeshStandardMaterial({ color: 0xcfe0f2, emissive: 0x9cc3ee, emissiveIntensity: 0.35, roughness: 0.25 }),
    keypad: std(0xc7cacf, 0.6),
  };
}

function box(parent: THREE.Object3D, w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, r = 0.02) {
  const geo = r > 0 ? new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2.2, h / 2.2, d / 2.2)) : new THREE.BoxGeometry(w, h, d);
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

function cyl(parent: THREE.Object3D, rTop: number, rBot: number, h: number, mat: THREE.Material, x: number, y: number, z: number, seg = 20) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, seg), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  parent.add(m);
  return m;
}

/** Status lamp (signal tower) on top of every machine. Returns the lamp so it can blink. */
function beacon(parent: THREE.Object3D, x: number, y: number, z: number, m: Mats) {
  cyl(parent, 0.025, 0.025, 0.18, m.dark, x, y + 0.09, z, 12);
  const lampMat = new THREE.MeshStandardMaterial({ color: 0x22c55e, emissive: 0x22c55e, emissiveIntensity: 1.2, roughness: 0.3, transparent: true, opacity: 0.95 });
  const lamp = cyl(parent, 0.055, 0.055, 0.14, lampMat, x, y + 0.25, z, 20);
  cyl(parent, 0.06, 0.06, 0.03, m.black, x, y + 0.335, z, 20);
  return lamp;
}

function doorWithGlass(g: THREE.Object3D, m: Mats, x: number, y: number, z: number, w: number, h: number) {
  const f = 0.045;
  box(g, w, f, 0.04, m.dark, x, y + h / 2 - f / 2, z, 0.01);
  box(g, w, f, 0.04, m.dark, x, y - h / 2 + f / 2, z, 0.01);
  box(g, f, h, 0.04, m.dark, x - w / 2 + f / 2, y, z, 0.01);
  box(g, f, h, 0.04, m.dark, x + w / 2 - f / 2, y, z, 0.01);
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(w - f * 2, h - f * 2), m.glass);
  glass.position.set(x, y, z);
  g.add(glass);
}

function buildHaas(m: Mats, W: number) {
  const g = new THREE.Group();
  const D = 1.9;
  const front = D / 2;
  // Base and plinth
  box(g, W, 0.42, D + 0.1, m.dark, 0, 0.21, 0, 0.03);
  box(g, W * 0.94, 0.5, D, m.offWhite, 0, 0.67, 0, 0.03);
  // Enclosure around a front opening
  const encL = -W * 0.46, encR = W * 0.46;
  const opL = -W * 0.3, opR = W * 0.2;
  const y0 = 0.92, y1 = 2.2, oy0 = 1.02, oy1 = 2.06;
  box(g, opL - encL, y1 - y0, D, m.white, (encL + opL) / 2, (y0 + y1) / 2, 0, 0.03);
  box(g, encR - opR, y1 - y0, D, m.white, (opR + encR) / 2, (y0 + y1) / 2, 0, 0.03);
  box(g, opR - opL, y1 - oy1, D, m.white, (opL + opR) / 2, (oy1 + y1) / 2, 0, 0.02);
  box(g, opR - opL, oy0 - y0, D, m.offWhite, (opL + opR) / 2, (y0 + oy0) / 2, 0, 0.02);
  // Inside the work area
  box(g, opR - opL, oy1 - oy0, D * 0.8, m.interior, (opL + opR) / 2, (oy0 + oy1) / 2, -0.12, 0);
  box(g, (opR - opL) * 0.8, 0.1, 0.55, m.dark, (opL + opR) / 2, oy0 + 0.12, 0.25, 0.01);
  box(g, 0.32, 0.42, 0.34, m.grey, (opL + opR) / 2, oy1 - 0.3, 0.15, 0.03);
  cyl(g, 0.07, 0.05, 0.22, m.steel, (opL + opR) / 2, oy1 - 0.6, 0.15);
  // Sliding doors
  const dw = (opR - opL) / 2 + 0.02;
  doorWithGlass(g, m, opL + dw / 2, (oy0 + oy1) / 2, front + 0.03, dw, oy1 - oy0);
  doorWithGlass(g, m, opR - dw / 2, (oy0 + oy1) / 2, front + 0.07, dw, oy1 - oy0);
  cyl(g, 0.018, 0.018, 0.45, m.steel, opL + dw - 0.08, (oy0 + oy1) / 2, front + 0.11);
  cyl(g, 0.018, 0.018, 0.45, m.steel, opR - dw + 0.08, (oy0 + oy1) / 2, front + 0.15);
  // "VF" badge and side vents
  box(g, 0.24, 0.17, 0.02, m.red, encL + 0.2, 1.95, front + 0.01, 0.01);
  for (let i = 0; i < 4; i++) box(g, 0.02, 0.5, 0.36, m.offWhite, encR + 0.005, 1.5, -0.4 + i * 0.12, 0);
  // Column / spindle head housing on top, with the red logo
  box(g, 0.8, 0.85, 0.8, m.dark, -0.15, y1 + 0.42, -0.25, 0.04);
  box(g, 0.48, 0.2, 0.02, m.red, -0.15, y1 + 0.62, 0.16, 0.01);
  box(g, 0.5, 0.35, 0.6, m.grey, -0.15, y1 + 0.17, 0.3, 0.04);
  // Cable chain
  const chain = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.055, 8, 28, Math.PI), m.black);
  chain.position.set(0.55, y1 + 0.35, -0.55);
  chain.rotation.y = Math.PI / 2;
  chain.castShadow = true;
  g.add(chain);
  // Control pendant (screen, keypad, emergency stop)
  const pend = new THREE.Group();
  box(pend, 0.58, 0.82, 0.14, m.offWhite, 0, 0, 0, 0.04);
  box(pend, 0.42, 0.28, 0.01, m.screenBlue, 0, 0.18, 0.075, 0);
  box(pend, 0.42, 0.24, 0.01, m.keypad, 0, -0.14, 0.075, 0);
  cyl(pend, 0.045, 0.045, 0.04, m.red, 0.2, -0.32, 0.09).rotation.x = Math.PI / 2;
  pend.position.set(encR - 0.3, 1.62, front + 0.18);
  pend.rotation.y = -0.35;
  g.add(pend);
  // Tool tray and chip chute on the left
  box(g, 0.5, 0.05, 0.4, m.grey, encL - 0.05, 1.0, front + 0.05, 0.01);
  const chute = box(g, 0.28, 0.12, 1.1, m.dark, encL - 0.35, 0.55, front - 0.1, 0.03);
  chute.rotation.x = -0.35;
  chute.rotation.y = 0.25;
  const lamp = beacon(g, encR - 0.15, y1, -0.6, m);
  return { group: g, lamp };
}

function buildFanuc(m: Mats) {
  const g = new THREE.Group();
  const W = 1.3, D = 1.55, front = D / 2;
  // Black stand with feet
  box(g, W - 0.15, 0.36, D - 0.2, m.black, 0, 0.2, 0, 0.02);
  for (const [x, z] of [[-0.5, -0.6], [0.5, -0.6], [-0.5, 0.6], [0.5, 0.6]]) cyl(g, 0.06, 0.07, 0.04, m.steel, x, 0.02, z);
  // Body and hood
  box(g, W, 1.45, D, m.white, 0, 0.38 + 0.725, 0, 0.04);
  box(g, W + 0.08, 0.5, D + 0.06, m.white, 0, 1.83 + 0.25, 0, 0.05);
  box(g, 0.3, 0.07, 0.02, m.yellow, -0.42, 1.92, front + 0.04, 0.01);
  // Yellow door with window
  box(g, 0.72, 1.25, 0.05, m.yellow, -0.24, 1.13, front + 0.02, 0.03);
  box(g, 0.44, 0.7, 0.02, m.interior, -0.24, 1.22, front + 0.04, 0);
  const win = new THREE.Mesh(new THREE.PlaneGeometry(0.44, 0.7), m.glass);
  win.position.set(-0.24, 1.22, front + 0.06);
  g.add(win);
  box(g, 0.04, 0.3, 0.04, m.dark, 0.06, 1.1, front + 0.07, 0.01);
  // Black control panel
  box(g, 0.44, 1.05, 0.07, m.black, 0.38, 1.2, front + 0.03, 0.02);
  box(g, 0.32, 0.24, 0.01, m.screenBlue, 0.38, 1.55, front + 0.07, 0);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) box(g, 0.05, 0.04, 0.01, m.keypad, 0.3 + c * 0.055, 1.33 - r * 0.06, front + 0.07, 0);
  cyl(g, 0.04, 0.04, 0.04, m.red, 0.48, 0.9, front + 0.08).rotation.x = Math.PI / 2;
  // Side door outline
  box(g, 0.01, 1.1, 1.0, m.offWhite, W / 2 + 0.005, 1.1, 0, 0);
  const lamp = beacon(g, 0.45, 2.33, -0.5, m);
  return { group: g, lamp };
}

function buildDmg(m: Mats) {
  const g = new THREE.Group();
  const W = 2.0, D = 1.85, front = D / 2;
  box(g, W + 0.1, 0.3, D + 0.05, m.grey, 0, 0.15, 0, 0.03);
  box(g, W, 1.95, D, m.white, 0, 0.3 + 0.975, 0, 0.05);
  box(g, W - 0.1, 0.2, D - 0.1, m.offWhite, 0, 2.35, 0, 0.05);
  // Anthracite main door with tall window and the "CMX" band
  box(g, 0.78, 1.7, 0.06, m.anthracite, 0.05, 1.27, front + 0.03, 0.03);
  box(g, 0.3, 1.15, 0.02, m.interior, 0.05, 1.25, front + 0.06, 0);
  const win = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 1.15), m.glass);
  win.position.set(0.05, 1.25, front + 0.075);
  g.add(win);
  box(g, 0.5, 0.09, 0.01, m.white, 0.05, 2.0, front + 0.065, 0);
  box(g, 0.04, 0.5, 0.04, m.steel, 0.32, 1.3, front + 0.09, 0.01);
  // Left tool-magazine door
  box(g, 0.5, 1.3, 0.04, m.offWhite, -0.65, 1.25, front + 0.02, 0.02);
  box(g, 0.18, 0.3, 0.01, m.interior, -0.65, 1.55, front + 0.045, 0);
  // CELOS panel on a swing arm
  cyl(g, 0.035, 0.035, 0.55, m.grey, W / 2 + 0.05, 1.45, front - 0.1).rotation.z = Math.PI / 2;
  const panel = new THREE.Group();
  box(panel, 0.56, 0.82, 0.08, m.black, 0, 0, 0, 0.03);
  box(panel, 0.46, 0.56, 0.01, m.screenLight, 0, 0.08, 0.045, 0);
  box(panel, 0.4, 0.1, 0.01, m.keypad, 0, -0.3, 0.045, 0);
  panel.position.set(W / 2 + 0.35, 1.45, front + 0.05);
  panel.rotation.y = -0.45;
  g.add(panel);
  // Coolant hose
  const hose = new THREE.Mesh(new THREE.TorusGeometry(0.35, 0.035, 8, 24, Math.PI * 0.8), m.grey);
  hose.position.set(W / 2 + 0.3, 0.75, front - 0.1);
  hose.rotation.set(0, Math.PI / 2, Math.PI * 1.2);
  g.add(hose);
  const lamp = beacon(g, -0.75, 2.45, -0.6, m);
  return { group: g, lamp };
}

const LAMP: Record<Machine3DState, number> = { ok: 0x22c55e, due: 0xf59e0b, problem: 0xff3b4e };

export default function Machine3D({
  kind,
  state,
  className,
  onFail,
}: {
  kind: Machine3DKind;
  state: Machine3DState;
  className?: string;
  onFail?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
    } catch {
      onFail?.(); // no WebGL on this PC: show the photo instead
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(renderer.domElement);
    renderer.domElement.style.cursor = 'grab';

    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTex;

    const mats = makeMaterials();
    const built =
      kind === 'fanuc-robodrill' ? buildFanuc(mats) : kind === 'dmg-cmx600v' ? buildDmg(mats) : buildHaas(mats, kind === 'haas-vf2' ? 2.5 : 3.0);
    const model = built.group;
    const bounds = new THREE.Box3().setFromObject(model);
    const size = bounds.getSize(new THREE.Vector3());
    const sphere = bounds.getBoundingSphere(new THREE.Sphere());
    scene.add(model);

    // Turntable floor: soft contact shadow + faint disc
    const radius = Math.max(size.x, size.z) * 0.85;
    const floor = new THREE.Mesh(new THREE.CircleGeometry(radius, 64), new THREE.ShadowMaterial({ opacity: 0.32 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    const discCanvas = document.createElement('canvas');
    discCanvas.width = discCanvas.height = 256;
    const ctx = discCanvas.getContext('2d')!;
    const grad = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    grad.addColorStop(0, 'rgba(140,160,190,0.22)');
    grad.addColorStop(0.7, 'rgba(140,160,190,0.08)');
    grad.addColorStop(1, 'rgba(140,160,190,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 256, 256);
    const discTex = new THREE.CanvasTexture(discCanvas);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(radius * 1.15, 64), new THREE.MeshBasicMaterial({ map: discTex, transparent: true, depthWrite: false }));
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.002;
    scene.add(disc);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x445066, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(3.5, 6, 4.5);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    const s = Math.max(size.x, size.z);
    Object.assign(key.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 0.5, far: 20 });
    key.shadow.bias = -0.0005;
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x9fb6ff, 0.6);
    rim.position.set(-4, 3, -3);
    scene.add(rim);
    const alarm = new THREE.PointLight(0xff3b4e, 0, 4, 2);
    alarm.position.copy(built.lamp.position).add(new THREE.Vector3(0, 0.1, 0));
    model.add(alarm);

    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, sphere.center.y * 0.92, 0);
    // Front three-quarter view, slightly from above, like a showroom photo.
    camera.position.copy(controls.target).add(new THREE.Vector3(0.62, 0.36, 0.78).normalize().multiplyScalar(10));
    /** Distance at which the whole machine fits the panel, whatever its shape. */
    const fitDistance = () => {
      const vFov = THREE.MathUtils.degToRad(camera.fov);
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
      return (sphere.radius / Math.sin(Math.min(vFov, hFov) / 2)) * 1.02;
    };
    const dist = fitDistance();
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = false;
    controls.minDistance = dist * 0.55;
    controls.maxDistance = dist * 1.4;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.autoRotate = !reduce;
    controls.autoRotateSpeed = 1.1;
    let resumeTimer = 0;
    const onStart = () => {
      controls.autoRotate = false;
      renderer.domElement.style.cursor = 'grabbing';
      window.clearTimeout(resumeTimer);
    };
    const onEnd = () => {
      renderer.domElement.style.cursor = 'grab';
      if (!reduce) resumeTimer = window.setTimeout(() => (controls.autoRotate = true), 4000);
    };
    controls.addEventListener('start', onStart);
    controls.addEventListener('end', onEnd);

    const resize = () => {
      const w = el.clientWidth || 1, h = el.clientHeight || 1;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      const fit = fitDistance();
      const offset = camera.position.clone().sub(controls.target).setLength(fit);
      camera.position.copy(controls.target).add(offset);
      controls.minDistance = fit * 0.6;
      controls.maxDistance = fit * 1.5;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    // Gentle entrance: the model rises onto the turntable
    model.position.y = -0.25;
    model.scale.setScalar(0.94);
    const t0 = performance.now();
    let raf = 0;
    const lampMat = built.lamp.material as THREE.MeshStandardMaterial;
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / 700);
      const e = 1 - Math.pow(1 - k, 3);
      model.position.y = -0.25 * (1 - e);
      model.scale.setScalar(0.94 + 0.06 * e);
      const st = stateRef.current;
      const col = LAMP[st];
      lampMat.color.setHex(col);
      lampMat.emissive.setHex(col);
      const blink = st === 'problem' && !reduce ? 0.5 + 0.5 * Math.sin(t / 180) : 1;
      lampMat.emissiveIntensity = 0.4 + 1.4 * blink;
      alarm.intensity = st === 'problem' ? 2.2 * blink : 0;
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(resumeTimer);
      ro.disconnect();
      controls.dispose();
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        mesh.geometry?.dispose();
      });
      Object.values(mats).forEach((mm) => mm.dispose());
      discTex.dispose();
      envTex.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [kind]);

  return <div ref={host} className={className} aria-label="3D model, drag to turn" role="img" />;
}
