import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { box, buildParallels, buildVise, JAW_TOPS, JAW_TRAVEL, PLANE_EPS, steel, STEEL, STEEL_DARK, v3, VISE_DEPTH } from '../lib/vise3d';
import { PARALLEL_LENGTH } from '../lib/cam/physics';
import { Orbit } from '../lib/orbit';
import type { Toolpath, Vec } from '../lib/toolpath';
import { CALE_MS, caleSlide, calesKey, nestBlock, parallelWidth, spacerAt, turnMs, viseSpans, type Face, type ProgramSetups, type SetupInfo } from '../lib/setups';
import { buildInput, cornerRadius, cornerTip, DROP_TOP, dropRadius, FLIP_MS, holderOf, instant, isBall, SUB, tipSlope, type ChunkMesh, type Hole } from '../lib/stockSim';
import { holeAt, holeAxis, holeOfMesh, type MeasureMode } from '../lib/measure';
import { attachMeasure, disposeTree, ring, type Measurement } from '../lib/measure3d';
import { movePath, runShares, toolAlong } from '../lib/playback';
import { addLights } from '../lib/lights';
import type { PartLook } from '../lib/partLook';
import type { Piece } from '../lib/modelCompare';
import type { ModelError } from '../lib/modelLimits';
import { fmtNumber } from '../i18n/format';

/*
 * 3D view of one setup: the vise (or modular fixture), the parallels, the part as a solid that
 * the tools cut away, the toolpath of that setup and the tool. Machine X/Y/Z map to three.js
 * X/Z/-Y (Y up), so the operator side of the machine (Y-) faces the camera.
 *
 * The cutting runs in a web worker; only the parts of the surface that change are sent back.
 */

const FACE_DIR: Record<Face, Vec> = { 'X+': [1, 0, 0], 'X-': [-1, 0, 0], 'Y+': [0, 1, 0], 'Y-': [0, -1, 0], 'Z+': [0, 0, 1], 'Z-': [0, 0, -1] };

/** Weak-spot colours by wall thickness (mm): blue at 0.2 and less, red at 0.5 (0.2 to 0.5: check these), orange, yellow at 1, plain above. */
export const WEAK_MM = [0.2, 0.5, 0.75, 1] as const;
export const WEAK_COLORS = ['#2f6bff', '#ff3b3b', '#ff9a2e', '#f5d547'] as const;
const HEAT = WEAK_COLORS.map((c) => new THREE.Color(c));
const heatColor = (mm: number, plain: THREE.Color, out: THREE.Color) => {
  if (!(mm < WEAK_MM[3])) return out.copy(plain);
  if (mm <= WEAK_MM[0]) return out.copy(HEAT[0]);
  const k = mm <= WEAK_MM[1] ? 1 : mm <= WEAK_MM[2] ? 2 : 3;
  return out.copy(HEAT[k - 1]).lerp(HEAT[k], (mm - WEAK_MM[k - 1]) / (WEAK_MM[k] - WEAK_MM[k - 1]));
};
/** Machine coordinates -> three.js coordinates. */
const MACHINE = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1);

/** Where the part frame sits in the scene for a setup. */
function poseOf(s: SetupInfo): THREE.Matrix4 {
  const R = s.orient;
  const t = s.offset;
  const m = new THREE.Matrix4().set(R[0], R[1], R[2], t[0], R[3], R[4], R[5], t[1], R[6], R[7], R[8], t[2], 0, 0, 0, 1);
  return MACHINE.clone().multiply(m);
}

/**
 * carving: cutting (share done); meshing: building the surfaces; measuring: weak spots; analysing:
 * finding faces and holes to measure; jumping: cutting up to where the slider jumped; ready: shown.
 */
export type SolidState = { state: 'off' | 'carving' | 'meshing' | 'measuring' | 'analysing' | 'jumping' | 'ready'; share: number };

/** A jump the part is hidden for: to the end (the finished part, no turn) or to a setup change (then the turn plays). */
export type Jump = { kind: 'end' | 'flip'; from: SetupInfo | null; key: number };

interface Props {
  path: Toolpath;
  program: ProgramSetups;
  setup: SetupInfo | null;
  /** First and last move index shown. */
  range: [number, number];
  /**
   * The instant shown: moves done + the share of the current move's time done. Read on every
   * frame, so playing moves the tool smoothly without re-rendering React.
   */
  clock: { current: number };
  colorOf: (tool: number | null) => string;
  /** Change it to fit the camera again. */
  fitKey: number;
  onSolid?: (s: SolidState) => void;
  /** Show only the part (no vise, supports, toolpath or tool). */
  isolate?: boolean;
  /** Colour the part by wall thickness: thin, weak spots stand out (see WEAK_MM). */
  heat?: boolean;
  /** Playing: setup changes are animated (turn, cales). Otherwise (scrubbing) the part jumps there. */
  playing?: boolean;
  /** Measuring: the part is analysed, then clicks pick its faces, holes or points (see mode). */
  measure?: boolean;
  /** What a click picks: two faces, two points, one hole's Ø, or two holes' axes. */
  mode?: MeasureMode;
  onMeasure?: (result: Measurement) => void;
  jump?: Jump | null;
  /** The part's material (see partLook). */
  look?: PartLook;
  /** Outlines on everything drawn (the part, the vise, the tool). */
  outline?: boolean;
  /**
   * A section: the part cut open across a machine axis, `at` the share cut away from the side facing the camera (0..1).
   * follow (the x-ray, you: Beta 2): the plane goes through the tool, and what the tool at work still takes is tinted.
   */
  section?: { axis: 0 | 1 | 2; at: number; follow?: boolean } | null;
  /** A view to fly the camera to (a new key flies again). */
  view?: { kind: 'top' | 'front' | 'iso'; key: number } | null;
  /** A point (machine coordinates) to fly the camera to: where a collision is. */
  focus?: { point: Vec; key: number } | null;
  /** The vise, clamp and cales drawn see-through (the part shows through them). */
  seeThrough?: boolean;
  /** Details mode: a finer part (more samples), drawn as it is cut. */
  details?: boolean;
  /** Set while the part shown is behind the instant asked for (details mode lets playback wait for it). */
  behind?: React.MutableRefObject<boolean>;
  /** The real part (3D PDF or STL), laid on the simulated finished part and turned with it. */
  model?: { name: string; bytes: Uint8Array } | null;
  /** What is drawn: the simulated part, the model, or both (the model see-through). */
  modelView?: ModelView;
  /** The differences from the model drawn in every view, not only with the model shown; in these colours if given. */
  diffs?: boolean;
  diffColors?: { left: string; cut: string };
  /** The differences to draw, already known (the planner's own check, in the part frame): drawn even where the model cannot be laid by its size. */
  diffPieces?: { kind: 'left' | 'cut'; min: number[]; max: number[] }[];
  onModel?: (s: ModelState) => void;
  /** The NX view (you, Beta 2): every path of the setup over the finished part; nothing is cut away as the tool goes. */
  pathsOnly?: boolean;
  /** No tool picked: every path of the setup drawn faintly while paused, to pick one from. */
  showAll?: boolean;
  /** The part's outer walls only (holes, pockets, tunnels closed), as it is at the instant shown (item 2). */
  hull?: boolean;
  /** A tool's path hovered (lit in its colour) and clicked: that tool. */
  onPickTool?: (tool: number) => void;
  /** Every change of setup turns the part (playing or not, forward or back), not only playing on into the next one. */
  turnAlways?: boolean;
  /** The camera's light off the view axis (lights.ts): no white glare on the faces seen square from the top or the front. */
  offAxisLight?: boolean;
}

export type ModelView = 'part' | 'model' | 'both';
/** The model being read and laid, laid (match: how alike the simulation and the model are, pieces: where they differ), or why not. */
export type ModelState = { state: 'reading' } | { state: 'ready'; overlap: number; match: number; pieces: Piece[] } | { state: 'error'; error: ModelError };

/** Colours of the differences: material left on, material cut too much. */
export const PIECE_COLORS = { left: '#ffb020', cut: '#ff4d6d' } as const;

/** Draw the simulated part, the model, or both (the model see-through over the part); diffs: the differences in every view. */
function showModel(a: Api, view: ModelView, diffs = false) {
  // The simulation's hole rims (measuring) go with the simulated part.
  a.solid.traverse((o) => {
    if (o.userData.simRims) o.visible = view !== 'model';
  });
  for (const c of a.solid.children) {
    if (c.userData.chunk) c.visible = view !== 'model';
    if (!c.userData.model) continue;
    c.visible = view !== 'part' || (diffs && c.userData.model === 'piece');
    if (c.userData.model !== 'mesh') continue;
    const m = c as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
    m.castShadow = m.receiveShadow = view === 'model';
    m.material.transparent = view === 'both';
    m.material.opacity = view === 'both' ? 0.6 : 1;
    m.material.depthWrite = view !== 'both';
    m.material.needsUpdate = true;
  }
  a.invalidate();
}

export type { Measurement } from '../lib/measure3d';

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

/** Draws what holds the part see-through (or as it was): every material keeps its own look to go back to. */
function showThrough(group: THREE.Object3D, on: boolean) {
  group.traverse((o) => {
    const mat = (o as THREE.Mesh | THREE.LineSegments).material;
    if (!mat) return;
    for (const m of Array.isArray(mat) ? mat : [mat]) {
      const was = (m.userData.solid ??= { transparent: m.transparent, opacity: m.opacity, depthWrite: m.depthWrite });
      m.transparent = on || was.transparent;
      m.opacity = on ? was.opacity * 0.2 : was.opacity;
      m.depthWrite = on ? false : was.depthWrite;
      m.needsUpdate = true;
    }
  });
}

/** How a setup holds the part: the vise (its moving jaw apart, to open) with the jaw-top line, or a fixture block with its stop. */
function buildClamp(setup: SetupInfo, s: { min: Vec; max: Vec }, floorZ: number) {
  const group = new THREE.Group();
  if (setup.jawTopZ !== null) {
    const cb = setup.clampBox ?? { min: [s.min[0], s.min[1]], max: [s.max[0], s.max[1]] };
    const spans = viseSpans(setup);
    // A POM nest: the block itself, the part in its pocket, the block on the parallels (not its walls as spacer plates).
    const nest = nestBlock(setup);
    const vise = buildVise(cb, floorZ, setup.jawTopZ, spans, setup.grip, setup.spacers, !nest);
    group.add(vise.group);
    if (nest) {
      const [lo, hi, p] = [nest.min, nest.max, nest.pocket];
      const pom = (a: Vec, b: Vec) => group.add(box(a, b, 0xf3efe2, 0.45, 0x8a8577));
      pom(lo, [hi[0], hi[1], p.min[2]]);
      pom([lo[0], lo[1], p.min[2]], [p.min[0], hi[1], hi[2]]);
      pom([p.max[0], lo[1], p.min[2]], [hi[0], hi[1], hi[2]]);
      pom([p.min[0], lo[1], p.min[2]], [p.max[0], p.min[1], hi[2]]);
      pom([p.min[0], p.max[1], p.min[2]], [p.max[0], hi[1], hi[2]]);
    }
    // The top of the jaws as a thin red line, for the jaw check.
    for (const [x0, x1] of spans) {
      const line = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(x1 - x0, 0.01, cb.max[1] - cb.min[1] + 60)),
        new THREE.LineBasicMaterial({ color: 0xf26d6d, transparent: true, opacity: 0.5 }),
      );
      line.position.copy(v3([(x0 + x1) / 2, (cb.min[1] + cb.max[1]) / 2, setup.jawTopZ]));
      group.add(line);
    }
    return { group, moving: vise.moving as THREE.Object3D | null, jawMats: vise.jawMats, spacerEdges: vise.spacerEdges, ready: vise.ready };
  }
  // A fixture: a steel block under the part, with the stop on the left.
  group.add(steel([s.min[0] - 8, s.min[1] - 8, floorZ - 30], [s.max[0] + 8, s.max[1] + 8, floorZ], STEEL));
  group.add(steel([s.min[0] - 18, s.min[1] - 8, floorZ - 30], [s.min[0] - 8, s.max[1] + 8, floorZ + Math.min(20, (setup.restZ ?? s.min[2]) - floorZ + 12)], STEEL_DARK));
  return { group, moving: null, jawMats: [] as THREE.MeshStandardMaterial[], spacerEdges: null as { lines: THREE.LineBasicMaterial[]; face: THREE.MeshStandardMaterial[] } | null, ready: Promise.resolve() };
}

/**
 * The two cales (parallels) of a setup, along X under the held part near its Y faces, each up to
 * the part's real underside above it, with their height engraved ("40 MM").
 */
function buildCales(setup: SetupInfo | null): THREE.Group | null {
  const s = setup?.stock;
  if (!setup || !s || setup.floorZ === null || !setup.cales?.length) return null;
  const floorZ = setup.floorZ;
  const restZ = setup.restZ ?? s.min[2];
  if (restZ - floorZ < 0.5) return null;
  const cb = setup.clampBox ?? { min: [s.min[0], s.min[1]], max: [s.max[0], s.max[1]] };
  const w = parallelWidth(cb.max[1] - cb.min[1]);
  const cales = setup.cales;
  // The shop's parallels: always PARALLEL_LENGTH long, one pair per vise, from the stop (or the
  // vise's left end); on a fixture, from just left of the part.
  const runs: number[] = setup.jawTopZ !== null ? viseSpans(setup).map(([x0]) => x0) : [cb.min[0] - 2];
  const length = PARALLEL_LENGTH;
  const end = runs[runs.length - 1] + length;
  const text = `${fmtNumber(setup.support ?? restZ - floorZ, 1)} MM`;
  const g = buildParallels(runs, length, cales, floorZ, text);
  // Their height as a tag over the right end, shown while they are changed.
  const tag = label(`▭ ${text}`, '#FFD27A');
  const h = Math.min(Math.max(length * 0.13, 8), 18);
  tag.scale.set(h * tag.userData.aspect, h, 1);
  const top = Math.max(...cales.map((c) => c.top));
  tag.position.copy(v3([end, (cales[0].y[0] + cales[cales.length - 1].y[1]) / 2, top + h * 0.9]));
  tag.visible = false;
  g.add(tag);
  g.userData.tag = tag;
  return g;
}

/** The measure's vise planes: hit by a click from either side, never drawn. */
const PLANE = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, visible: false });

/** A curved arrow around a turning axis (three.js frame) showing which way the part turns. */
function turnArrow(axis: THREE.Vector3, angle: number, radius: number, text: string): THREE.Group {
  const g = new THREE.Group();
  const arc = Math.min(Math.abs(angle), Math.PI * 1.7);
  const mat = new THREE.MeshBasicMaterial({ color: 0x5b8cf5, transparent: true, opacity: 0.95, depthTest: false });
  const tube = new THREE.Mesh(new THREE.TorusGeometry(radius, Math.max(0.8, radius * 0.035), 10, 64, arc), mat);
  tube.renderOrder = 11;
  g.add(tube);
  const head = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.12, radius * 0.28, 20), mat);
  head.renderOrder = 11;
  head.position.set(radius * Math.cos(arc), radius * Math.sin(arc), 0);
  head.rotation.z = arc; // cone points along +Y; turned to the arc's direction of travel
  g.add(head);
  const tag = label(text, '#9DB8FF');
  const h = Math.max(6, radius * 0.34);
  tag.scale.set(h * tag.userData.aspect, h, 1);
  tag.position.set(radius * Math.cos(arc / 2) * 1.25, radius * Math.sin(arc / 2) * 1.25, 0);
  g.add(tag);
  // The torus lies in its XY plane, turning around +Z: point +Z along the axis (negative angles
  // turn the other way).
  const dir = axis.clone().normalize().multiplyScalar(angle < 0 ? -1 : 1);
  g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
  return g;
}


/** How each material looks: the raw block and its cut faces, the finish, a rim light on dark parts, the outline colour (sRGB). */
const LOOKS: Record<PartLook, { raw: number; cut: number; metalness: number; roughness: number; env: number; rim: number; edge: [number, number, number] }> = {
  plain: { raw: 0x7d8aa3, cut: 0xd5deea, metalness: 0.3, roughness: 0.55, env: 0, rim: 0, edge: [0.05, 0.07, 0.11] },
  alu: { raw: 0x9aa3ae, cut: 0xdde3ea, metalness: 0.75, roughness: 0.32, env: 1.1, rim: 0, edge: [0.05, 0.07, 0.11] },
  steel: { raw: 0x6c747f, cut: 0xb1b9c3, metalness: 0.8, roughness: 0.38, env: 1, rim: 0, edge: [0.05, 0.07, 0.11] },
  brass: { raw: 0x86672a, cut: 0xcfa548, metalness: 0.85, roughness: 0.36, env: 0.9, rim: 0, edge: [0.12, 0.08, 0.02] },
  // Black plastic: a light rim and light outlines keep it apart from the dark background.
  pom: { raw: 0x2b2e34, cut: 0x3b3f46, metalness: 0, roughness: 0.35, env: 0, rim: 0.2, edge: [0.78, 0.84, 0.93] },
  // Layered wood (the shader adds the layers and the white top plate); cut floors show light wood.
  fh: { raw: 0x4a2f22, cut: 0xb98e6a, metalness: 0, roughness: 0.8, env: 0, rim: 0, edge: [0.1, 0.06, 0.03] },
  // FH under 10 mm: pressed wood all through, no white top.
  fhThin: { raw: 0x4a2f22, cut: 0xb98e6a, metalness: 0, roughness: 0.8, env: 0, rim: 0, edge: [0.1, 0.06, 0.03] },
  // PC GF: greenish white, matt, a fifth see-through (cloudy, not clear).
  pcgf: { raw: 0xd3dfcb, cut: 0xe6eedf, metalness: 0, roughness: 0.9, env: 0, rim: 0.08, edge: [0.1, 0.14, 0.1] },
};
/** The cut face of a section: hatched, in one colour for every material. */
const SECTION = new THREE.Color(0xe07a5f);
/** The x-ray's tint: material the tool at work still takes. */
const SOON = new THREE.Color(0xff9a2e);

/**
 * The part's material: its look, FH's wood layers under a 0.8 mm white plate on the raw top, a
 * rim light, and with a section the faces seen from inside (where it is cut open) hatched. The
 * uniforms are in `userData.u`.
 */
function partMaterial(look: PartLook, part: { min: Vec; max: Vec }, white: Vec | null | undefined, env: THREE.Texture | null) {
  // The white plate on the face the program calls the front (where the RAFI is), the layers under it.
  const dir: Vec = white ?? [0, 0, 1];
  const top = [0, 1, 2].reduce((t, k) => t + Math.max(dir[k] * part.min[k], dir[k] * part.max[k]), 0);
  const L = LOOKS[look];
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: L.metalness, roughness: L.roughness, side: THREE.DoubleSide });
  // Metals reflect the studio round them fully (the scene's own reflections are kept faint).
  if (L.env && env) {
    m.envMap = env;
    m.envMapIntensity = L.env;
  }
  const u = {
    uFH: { value: look === 'fh' || look === 'fhThin' ? 1 : 0 },
    uPlateOn: { value: look === 'fh' ? 1 : 0 },
    uTopZ: { value: top },
    uDir: { value: new THREE.Vector3(...dir) },
    uRim: { value: L.rim },
    uCut: { value: 0 },
    uCap: { value: SECTION },
    uWood: { value: new THREE.Color(0x35211a) },
    uWood2: { value: new THREE.Color(0x67442f) },
    uPlate: { value: new THREE.Color(0xe8e5de) },
  };
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPart;\nvarying vec3 vPartN;\nvarying vec3 vViewN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPart = position;\nvPartN = normal;\nvViewN = normalMatrix * normal;');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vPart;\nvarying vec3 vPartN;\nvarying vec3 vViewN;\nuniform float uFH;\nuniform float uPlateOn;\nuniform float uTopZ;\nuniform vec3 uDir;\nuniform float uRim;\nuniform float uCut;\nuniform vec3 uCap;\nuniform vec3 uWood;\nuniform vec3 uWood2;\nuniform vec3 uPlate;',
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
if (uCut > 0.5 && dot(normalize(vViewN), normalize(vViewPosition)) < -0.02) {
  float h = step(mod(gl_FragCoord.x + gl_FragCoord.y, 10.0), 2.5);
  gl_FragColor = linearToOutputTexel(vec4(mix(uCap, uCap * 0.45, h), 1.0));
  return;
}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
if (uFH > 0.5) {
  float along = dot(vPart, uDir);
  float facing = dot(vPartN, uDir);
  if (uPlateOn > 0.5 && along > uTopZ - 0.8 && facing > -0.5) diffuseColor.rgb = uPlate;
  else if (facing < 0.7) {
    // Pressed layers about 1 mm thick (drawn a little coarser than real so they show), fading to their mean when too fine to draw.
    float k = along / 1.1;
    float s = smoothstep(0.15, 0.85, 0.5 + 0.5 * sin(k * 6.2832));
    s = mix(s, 0.5, clamp(fwidth(k) * 1.2, 0.0, 1.0));
    float slow = 0.8 + 0.2 * sin(along * 0.37 + vPart.x * 0.05);
    diffuseColor.rgb = mix(uWood, uWood2, (0.15 + 0.75 * s) * slow);
  }
}`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\ntotalEmissiveRadiance += uRim * pow(1.0 - abs(dot(normalize(vViewN), normalize(vViewPosition))), 3.0);',
      );
  };
  if (look === 'pcgf') {
    m.transparent = true;
    m.opacity = 0.8;
  }
  m.userData.u = u;
  return m;
}

type ToolShape = 'flat' | 'ball' | 'point' | 'face' | 'corner';
const P2 = (x: number, y: number) => new THREE.Vector2(x, y);
/** The cutter's outline from the tip up, as (radius, height) pairs, turned round its axis. */
function cutterProfile(shape: ToolShape, r: number, len: number, tipH: number, corner = 0): THREE.Vector2[] {
  if (shape === 'point') return [P2(0, 0), P2(r, tipH), P2(r, len), P2(0, len)];
  if (shape === 'corner') {
    // The flat bottom, its edge rounded by the corner radius (as the simulation cuts with it), then the side.
    const c = Math.min(corner, r, len);
    return [P2(0, 0), ...Array.from({ length: 13 }, (_, i) => {
      const h = c * (1 - Math.cos((Math.PI / 2) * (i / 12)));
      return P2(cornerRadius(h, r, c), h);
    }), P2(r, len), P2(0, len)];
  }
  if (shape === 'ball') {
    // The eyedrop, exactly as the simulation cuts with it (denser near the tip, where the ball turns fastest).
    const top = Math.min(len, r * DROP_TOP);
    return [...Array.from({ length: 33 }, (_, i) => {
      const h = top * (i / 32) ** 1.6;
      return P2(dropRadius(h, r), h);
    }), P2(dropRadius(len, r), len), P2(0, len)];
  }
  if (shape === 'face') {
    // The cutter disk, its shoulder, then the arbor up to the holder.
    const h = Math.min(12, len * 0.35);
    const arbor = Math.min(r, Math.max(r * 0.42, 6));
    return [P2(0, 0), P2(r, 0), P2(r, h), P2(arbor, h + (r - arbor) * 0.35), P2(arbor, len), P2(0, len)];
  }
  return [P2(0, 0), P2(r, 0), P2(r, len), P2(0, len)];
}
/** The holder as the collision check has it (radius hr, hh high, from where the tool sticks out): a collet nut with its chamfer and grip groove. */
function holderProfile(hr: number, hh: number, len: number): THREE.Vector2[] {
  return [P2(0, len), P2(hr * 0.78, len), P2(hr, len + hr * 0.2), P2(hr, len + hh * 0.42), P2(hr * 0.9, len + hh * 0.46), P2(hr * 0.9, len + hh * 0.56), P2(hr, len + hh * 0.6), P2(hr, len + hh), P2(0, len + hh)];
}
/** The kind of cutter, from its name: pointed (drills, chamfers, spot drills), ball nose, face mill or flat end mill. */
function shapeOf(label: string, r: number): ToolShape {
  if (tipSlope(label)) return 'point';
  if (isBall(label)) return 'ball';
  if (cornerTip(label)) return 'corner';
  if (r >= 12 || /MESSERKOPF|PLANFR/i.test(label)) return 'face';
  return 'flat';
}

/**
 * Outlines: the meshes' normals and depth are drawn to a target, then every pixel where the depth
 * jumps or the surface turns sharply is drawn as a line over the picture (whatever the mesh).
 */
function makeOutline(renderer: THREE.WebGLRenderer) {
  const rt = new THREE.WebGLRenderTarget(1, 1, { depthTexture: new THREE.DepthTexture(1, 1) });
  const flat = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });
  const cut = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });
  const mat = new THREE.ShaderMaterial({
    uniforms: { tN: { value: rt.texture }, tD: { value: rt.depthTexture }, texel: { value: new THREE.Vector2(1, 1) }, color: { value: new THREE.Vector3() }, near: { value: 1 }, far: { value: 100 } },
    vertexShader: 'varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `#include <packing>
uniform sampler2D tN; uniform sampler2D tD; uniform vec2 texel; uniform vec3 color; uniform float near; uniform float far;
varying vec2 vUv;
float zAt(vec2 p) { float d = texture2D(tD, p).x; return d >= 1.0 ? 1e6 : -perspectiveDepthToViewZ(d, near, far); }
vec3 nAt(vec2 p) { return texture2D(tN, p).xyz * 2.0 - 1.0; }
void main() {
  float zc = zAt(vUv);
  vec3 nc = nAt(vUv);
  float e = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 o = i == 0 ? vec2(texel.x, 0.0) : i == 1 ? vec2(-texel.x, 0.0) : i == 2 ? vec2(0.0, texel.y) : vec2(0.0, -texel.y);
    float zo = zAt(vUv + o);
    if (abs(zo - zc) > 0.012 * min(zc, zo) + 0.05) e = 1.0;
    if (zc < 1e5 && zo < 1e5 && dot(nc, nAt(vUv + o)) < 0.8) e = 1.0;
  }
  if (e < 0.5) discard;
  gl_FragColor = vec4(color, 0.9);
}`,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const size = new THREE.Vector2();
  return {
    render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, color: [number, number, number], clip: THREE.Plane[]) {
      renderer.getDrawingBufferSize(size);
      if (rt.width !== size.x || rt.height !== size.y) rt.setSize(size.x, size.y);
      mat.uniforms.texel.value.set(1 / size.x, 1 / size.y);
      mat.uniforms.color.value.set(...color);
      mat.uniforms.near.value = camera.near;
      mat.uniforms.far.value = camera.far;
      cut.clippingPlanes = clip;
      // Meshes draw their normals (cut ones as cut); lines, labels and points stay out.
      const swapped: [THREE.Mesh, THREE.Material | THREE.Material[]][] = [];
      const hidden: THREE.Object3D[] = [];
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          const own = Array.isArray(m.material) ? m.material[0] : m.material;
          swapped.push([m, m.material]);
          m.material = own?.clippingPlanes?.length ? cut : flat;
        } else if (((o as THREE.Line).isLine || (o as THREE.Sprite).isSprite || (o as THREE.Points).isPoints) && o.visible) {
          hidden.push(o);
          o.visible = false;
        }
      });
      renderer.setRenderTarget(rt);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      for (const [m, own] of swapped) m.material = own;
      for (const o of hidden) o.visible = true;
      renderer.render(scene, camera);
      renderer.autoClear = false;
      renderer.render(quad, ortho);
      renderer.autoClear = true;
    },
    dispose() {
      rt.dispose();
      rt.depthTexture?.dispose();
      flat.dispose();
      cut.dispose();
      mat.dispose();
      quad.geometry.dispose();
    },
  };
}

interface Api {
  invalidate: () => void;
  camera: THREE.PerspectiveCamera;
  controls: Orbit;
  scene: THREE.Scene;
  world: THREE.Group;
  solid: THREE.Group;
  solidReady: boolean;
  /** Ask the worker for the part at an instant; force: again even if shown (e.g. weak spots measured). */
  requestMesh: (step: number, force?: boolean) => void;
  /** Colour the part again (weak spots on or off). */
  repaint: () => void;
  fit: () => void;
  progress: (step: number) => void;
  /** Objects hidden while the part turns. */
  setupObjects: THREE.Object3D[];
  /** The tool whose path the ray passes nearest (within `near` mm), lit; null: none (and the light off). */
  pickPath: ((ray: THREE.Raycaster | null, near: number) => number | null) | null;
  stockFill: THREE.Object3D | null;
  anim: ((now: number) => boolean) | null;
  /** The vise's moving jaw: open = 0 (closed) .. 1 (open). */
  jaw: { obj: THREE.Object3D; travel: number } | null;
  /** Overlay objects (turn arrow) kept outside the world group. */
  overlay: THREE.Group;
  /** The cales (parallels) of the setup shown. */
  cales: THREE.Group | null;
  /** The spacer plate's edges (green once a tool cut into it). */
  spacerEdges: { lines: THREE.LineBasicMaterial[]; face: THREE.MeshStandardMaterial[] } | null;
  /** Instant last drawn (see clock). */
  shownPos: number;
  /** Instant of the program the solid should show (see stockSim SUB). */
  meshAt: number;
  /** The setup's clamping (vise or fixture), hidden while the part turns out of the old one. */
  clamp: THREE.Object3D | null;
  /** Everything that holds the part (vise or fixture, cales), for drawing it see-through. */
  fixture: THREE.Group | null;
  seeThrough: boolean;
  /** Called once, when the part shown is the part at meshAt (after a jump). */
  settle: (() => void) | null;
  /** The round holes plunged before a move (the worker finds them on the cut part). */
  holesBefore: (move: number) => Promise<Hole[]>;
  /** Called after each drawn frame (labels that follow the part on screen). */
  afterRender: (() => void) | null;
  /** The light that casts the shadows, placed round what is framed on every fit. */
  key: THREE.DirectionalLight;
  /** Outlines on (their colour) or off. */
  outline: [number, number, number] | null;
  section: Props['section'];
  /** The section's plane, scene coordinates. */
  clip: THREE.Plane;
  /** Cuts the part open (or closes it) as `section` says. */
  applySection: () => void;
  /** The x-ray: the instant the tool at work is done (its run of moves), its cuts to come tinted; null: off. */
  until: number | null;
  /** The middle and the size of what the camera frames. */
  frame: () => { c: THREE.Vector3; size: number };
}

/** Most pixels one frame draws: what the earlier, smaller window drew on a 1080p screen (about 980 x 800 at 1.5x). */
const MAX_PIXELS = 1_800_000;

export default function Toolpath3D({ path, program, setup, range, clock, colorOf, fitKey, onSolid, isolate = false, heat = false, playing = false, measure = false, mode = 'faces', onMeasure, jump = null, look = 'plain', outline = false, section = null, view = null, focus = null, seeThrough = false, details = false, behind, model = null, modelView = 'part', diffs = false, diffColors, diffPieces, onModel, pathsOnly = false, showAll = false, onPickTool, hull = false, turnAlways = false, offAxisLight = false }: Props) {
  const modelViewRef = useRef(modelView);
  modelViewRef.current = modelView;
  const diffsRef = useRef(diffs);
  diffsRef.current = diffs;
  const diffColorsRef = useRef(diffColors);
  diffColorsRef.current = diffColors;
  const diffPiecesRef = useRef(diffPieces);
  diffPiecesRef.current = diffPieces;
  const onModelRef = useRef(onModel);
  onModelRef.current = onModel;
  const behindRef = useRef(behind);
  behindRef.current = behind;
  const modeRef = useRef(mode);
  const setupNow = useRef(setup);
  setupNow.current = setup;
  modeRef.current = mode;
  const resetMeasure = useRef<(() => void) | null>(null);
  const jumpRef = useRef(jump);
  jumpRef.current = jump;
  const onMeasureRef = useRef(onMeasure);
  onMeasureRef.current = onMeasure;
  const heatRef = useRef(heat);
  const pathsOnlyRef = useRef(pathsOnly);
  pathsOnlyRef.current = pathsOnly;
  heatRef.current = heat;
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const showAllRef = useRef(showAll);
  showAllRef.current = showAll;
  const turnAlwaysRef = useRef(turnAlways);
  turnAlwaysRef.current = turnAlways;
  const hullRef = useRef(hull);
  hullRef.current = hull;
  const onPickToolRef = useRef(onPickTool);
  onPickToolRef.current = onPickTool;
  const fitFor = useRef<{ path: unknown; at: string }>({ path: null, at: '' });
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<Api | null>(null);
  const clockRef = useRef(clock);
  clockRef.current = clock;
  const setupRef = useRef(setup);
  setupRef.current = setup;
  const onSolidRef = useRef(onSolid);
  onSolidRef.current = onSolid;

  // Renderer, camera and controls live as long as the view. It only draws when something changed.
  useEffect(() => {
    const el = host.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setClearColor(0x0a0f19);
    renderer.localClippingEnabled = true;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    el.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 5000);
    // Lit from every side and from the viewer: no face turns black, whichever way it is turned.
    const lights = addLights(scene, renderer, camera, offAxisLight);
    const edges = makeOutline(renderer);
    let dirty = true;
    const invalidate = () => {
      dirty = true;
    };
    // Turning like CAD software: around the point grabbed, over the top and underneath, no roll.
    const controls = new Orbit(camera, renderer.domElement, invalidate);
    controls.pickables = () => [api.current?.solid ?? null, api.current?.clamp ?? null, api.current?.cales ?? null];
    // Turn round the middle of the part (its real shape once built, else what is framed).
    controls.center = () => {
      const a = api.current;
      if (!a) return null;
      const bb = a.solidReady ? new THREE.Box3().setFromObject(a.solid) : null;
      return bb && !bb.isEmpty() ? bb.getCenter(new THREE.Vector3()) : a.frame().c;
    };
    const world = new THREE.Group();
    scene.add(world);
    const solid = new THREE.Group();
    solid.matrixAutoUpdate = false;
    scene.add(solid);
    const overlay = new THREE.Group();
    scene.add(overlay);

    const resize = () => {
      const w = el.clientWidth || 1;
      const h = el.clientHeight || 1;
      // The window is nearly the whole screen: a frame costs what its pixels cost, so the drawing
      // is capped at the pixel budget of the earlier, smaller window (sharper only where it is cheap).
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5, Math.sqrt(MAX_PIXELS / (w * h))));
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      dirty = true;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    let raf = 0;
    const loop = (now: number) => {
      controls.tick(now);
      const a = api.current;
      // Follow the clock: the tool moves on every frame while playing.
      const pos = clockRef.current.current;
      if (a && pos !== a.shownPos) {
        a.shownPos = pos;
        a.progress(pos);
      }
      if (a?.anim) {
        if (!a.anim(now)) a.anim = null;
        dirty = true;
      }
      if (dirty) {
        if (a?.outline) edges.render(scene, camera, a.outline, a.section ? [a.clip] : []);
        else renderer.render(scene, camera);
        a?.afterRender?.();
        dirty = false;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    api.current = {
      invalidate,
      camera,
      controls,
      scene,
      world,
      solid,
      solidReady: false,
      requestMesh: () => undefined,
      repaint: () => undefined,
      fit: () => undefined,
      progress: () => undefined,
      setupObjects: [],
      pickPath: null,
      stockFill: null,
      anim: null,
      jaw: null,
      overlay,
      cales: null,
      spacerEdges: null,
      shownPos: NaN,
      meshAt: 0,
      clamp: null,
      fixture: null,
      seeThrough: false,
      settle: null,
      holesBefore: () => Promise.resolve([]),
      afterRender: null,
      key: lights.key,
      outline: null,
      section: null,
      clip: new THREE.Plane(),
      applySection: () => undefined,
      until: null,
      frame: () => ({ c: new THREE.Vector3(), size: 100 }),
    };
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      disposeTree(world);
      disposeTree(solid);
      lights.dispose();
      edges.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      api.current = null;
    };
  }, []);

  // A path under the pointer lights up in its tool's colour; a click (not a drag) picks that tool.
  const measureOn = useRef(measure);
  measureOn.current = measure;
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let down: [number, number] | null = null;
    let over = false;
    const at = (e: PointerEvent) => {
      const a = api.current;
      if (!a?.pickPath || !onPickToolRef.current || measureOn.current) return null;
      const box = el.getBoundingClientRect();
      ndc.set(((e.clientX - box.left) / box.width) * 2 - 1, -((e.clientY - box.top) / box.height) * 2 + 1);
      ray.setFromCamera(ndc, a.camera);
      // About 8 px on screen, whatever the zoom.
      return a.pickPath(ray, (a.camera.position.distanceTo(a.controls.target) * 8) / Math.max(1, box.height));
    };
    const off = () => {
      if (over) api.current?.pickPath?.(null, 0);
      over = false;
      el.style.cursor = '';
    };
    const move = (e: PointerEvent) => {
      if (e.buttons) return;
      const t = at(e);
      over = t !== null;
      el.style.cursor = over ? 'pointer' : '';
    };
    const press = (e: PointerEvent) => {
      down = [e.clientX, e.clientY];
    };
    const release = (e: PointerEvent) => {
      const click = down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 4;
      down = null;
      if (!click) return;
      const t = at(e);
      if (t !== null) onPickToolRef.current?.(t);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerdown', press);
    el.addEventListener('pointerup', release);
    el.addEventListener('pointerleave', off);
    return () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerdown', press);
      el.removeEventListener('pointerup', release);
      el.removeEventListener('pointerleave', off);
    };
  }, []);

  // The solid part: cut in a worker, its surface updated chunk by chunk.
  useEffect(() => {
    const a = api.current;
    if (!a) return;
    const plain = buildInput(path, program);
    if (!plain) {
      onSolidRef.current?.({ state: 'off', share: 0 });
      return;
    }
    // Details: twice the samples (finer walls, holes and chamfers), more memory and time to cut.
    const input = details ? { ...plain, maxVoxels: 10_000_000 } : plain;
    const worker = new Worker(new URL('../lib/stockSim.worker.ts', import.meta.url), { type: 'module' });
    const L = LOOKS[look];
    const material = partMaterial(look, input.part, program.white, a.scene.environment);
    material.envMapRotation.copy(a.scene.environmentRotation);
    const RAWC = new THREE.Color(L.raw);
    const CUTC = new THREE.Color(L.cut);
    const chunks = new Map<number, THREE.Mesh>();
    let busy = false;
    let wanted = -1;
    let shown = -1;
    onSolidRef.current?.({ state: 'carving', share: 0 });

    // After a jump: once the part shown is the part asked for.
    const settled = () => {
      if (!a.settle || busy || shown !== a.meshAt) return;
      const f = a.settle;
      a.settle = null;
      f();
    };
    const lag = () => {
      if (behindRef.current) behindRef.current.current = a.solidReady && (busy || wanted !== shown);
    };
    const ask = (s: number, force = false) => {
      wanted = s;
      if (force) shown = -1;
      if (s === shown) settled();
      if (!busy && a.solidReady && s !== shown) {
        busy = true;
        worker.postMessage({ type: 'mesh', step: s, heat: heatRef.current, until: a.until, hull: hullRef.current });
      }
      lag();
    };
    a.requestMesh = ask;
    // Raw or cut colour, or the weak-spot colour of each point's wall thickness.
    const paint = (geo: THREE.BufferGeometry) => {
      // The weak-spot colours replace the wood layers.
      material.userData.u.uFH.value = (look === 'fh' || look === 'fhThin') && !heatRef.current ? 1 : 0;
      const { cut, thick, soon } = geo.userData as { cut: Uint8Array; thick?: Float32Array; soon?: Uint8Array };
      const col = new Float32Array(cut.length * 3);
      const c = new THREE.Color();
      for (let i = 0; i < cut.length; i++) {
        const plain = cut[i] ? CUTC : RAWC;
        if (heatRef.current && thick) heatColor(thick[i], plain, c);
        else if (soon?.[i] && a.until !== null) c.copy(plain).lerp(SOON, 0.55);
        else c.copy(plain);
        col[i * 3] = c.r;
        col[i * 3 + 1] = c.g;
        col[i * 3 + 2] = c.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    };
    const holeAsks = new Map<number, ((h: Hole[]) => void)[]>();
    a.holesBefore = (move) =>
      new Promise((done) => {
        const l = holeAsks.get(move);
        if (l) return l.push(done);
        holeAsks.set(move, [done]);
        worker.postMessage({ type: 'holes', before: move });
      });
    a.repaint = () => {
      for (const mesh of chunks.values()) paint(mesh.geometry);
      a.invalidate();
    };
    // A section: a plane across the part, square to a machine axis, the side facing the camera
    // (right, front, top) cut away; what is seen from inside is the cut face (hatched).
    const clipped = [material];
    a.applySection = () => {
      const sec = a.section;
      if (sec) {
        const bb = new THREE.Box3();
        for (const m of chunks.values()) {
          if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
          bb.union(m.geometry.boundingBox!);
        }
        if (!bb.isEmpty()) {
          bb.applyMatrix4(a.solid.matrix);
          // Machine X, Y, Z are scene x, -z, y.
          const k = (['x', 'z', 'y'] as const)[sec.axis];
          a.clip.set(new THREE.Vector3(k === 'x' ? -1 : 0, k === 'y' ? -1 : 0, k === 'z' ? -1 : 0), sec.follow ? a.clip.constant : bb.max[k] - sec.at * (bb.max[k] - bb.min[k]));
        }
      }
      const planes = sec ? [a.clip] : [];
      for (const m of clipped)
        if ((m.clippingPlanes?.length ?? 0) !== planes.length) {
          m.clippingPlanes = planes;
          m.needsUpdate = true;
        }
      material.userData.u.uCut.value = sec ? 1 : 0;
      a.invalidate();
    };
    a.applySection();

    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === 'progress') onSolidRef.current?.({ state: 'carving', share: msg.share });
      if (msg.type === 'ready') {
        a.solidReady = true;
        if (setupRef.current) a.solid.matrix.copy(poseOf(setupRef.current));
        a.solid.matrixWorldNeedsUpdate = true;
        if (a.stockFill) a.stockFill.visible = false;
        onSolidRef.current?.({ state: 'meshing', share: 1 });
        ask(a.meshAt);
        // Built ahead, in the background: the part where a click on a clamping or an operation goes (each tool run's
        // first move done) and at the end, so those open at once (the owner).
        const moves = path.moves;
        const starts = moves.flatMap((mv, i) => (i === 0 || mv.setup !== moves[i - 1].setup || mv.tool !== moves[i - 1].tool ? [instant(i + 1)] : []));
        worker.postMessage({ type: 'prebuild', steps: [...starts, instant(moves.length)] });
      }
      if (msg.type === 'holes') {
        holeAsks.get(msg.before)?.forEach((f) => f(msg.holes));
        holeAsks.delete(msg.before);
      }
      if (msg.type === 'measuring') onSolidRef.current?.({ state: 'measuring', share: 1 });
      if (msg.type === 'mesh') {
        if (msg.full) onSolidRef.current?.({ state: 'ready', share: 1 });
        for (const c of msg.chunks as ChunkMesh[]) {
          let mesh = chunks.get(c.id);
          if (!c.positions.length) {
            if (mesh) {
              a.solid.remove(mesh);
              mesh.geometry.dispose();
              chunks.delete(c.id);
            }
            continue;
          }
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.BufferAttribute(c.positions, 3));
          geo.setAttribute('normal', new THREE.BufferAttribute(c.normals, 3));
          geo.userData = { cut: c.cut, thick: c.thick, soon: c.soon };
          paint(geo);
          if (mesh) {
            mesh.geometry.dispose();
            mesh.geometry = geo;
          } else {
            mesh = new THREE.Mesh(geo, material);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            mesh.matrixAutoUpdate = false;
            mesh.userData.chunk = true;
            mesh.visible = modelViewRef.current !== 'model';
            chunks.set(c.id, mesh);
            a.solid.add(mesh);
          }
        }
        shown = msg.step;
        busy = false;
        if (a.section) a.applySection();
        a.solid.matrixWorldNeedsUpdate = true;
        a.invalidate();
        if (wanted !== shown) ask(wanted);
        settled();
        lag();
      }
    };
    worker.postMessage({ type: 'init', input });

    return () => {
      worker.terminate();
      a.solidReady = false;
      if (behindRef.current) behindRef.current.current = false;
      a.requestMesh = () => undefined;
      a.repaint = () => undefined;
      a.applySection = () => undefined;
      for (const m of chunks.values()) {
        a.solid.remove(m);
        m.geometry.dispose();
      }
      material.dispose();
      a.holesBefore = () => Promise.resolve([]);
      a.settle = null;
      onSolidRef.current?.({ state: 'off', share: 0 });
    };
  }, [path, program, look, details]);

  // The real part: read and laid in its own worker, drawn in the part frame so it turns with the part.
  useEffect(() => {
    const a = api.current;
    const input = model && buildInput(path, program);
    if (!a || !model || !input) return;
    const worker = new Worker(new URL('../lib/stockSim.worker.ts', import.meta.url), { type: 'module' });
    let mesh: THREE.Mesh | null = null;
    const pieces: (THREE.LineSegments | THREE.Mesh)[] = [];
    onModelRef.current?.({ state: 'reading' });
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as { tris?: Float32Array; overlap?: number; match?: number; pieces?: Piece[]; error?: ModelError };
      worker.terminate();
      if (!msg.tris) return onModelRef.current?.({ state: 'error', error: msg.error ?? 'unreadable' });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(msg.tris, 3));
      geo.computeVertexNormals();
      mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
          color: 0x8fb3e0,
          metalness: 0.1,
          roughness: 0.6,
          side: THREE.DoubleSide,
          // Drawn over the simulated part where their faces coincide: blue where they agree, grey where the part has more.
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -4,
        }));
      mesh.matrixAutoUpdate = false;
      mesh.userData.model = 'mesh';
      a.solid.add(mesh);
      // Each difference outlined in its colour, seen through the part.
      for (const pc of diffPiecesRef.current ? [] : msg.pieces!) {
        const size = pc.max.map((v, k) => Math.max(v - pc.min[k], 0.2));
        const shape = new THREE.BoxGeometry(size[0], size[1], size[2]);
        const color = (diffColorsRef.current ?? PIECE_COLORS)[pc.kind];
        const box = new THREE.LineSegments(new THREE.EdgesGeometry(shape), new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true }));
        // Filled too where they are shown in every view (diffs); the viewer keeps its outlines only.
        const fill = diffsRef.current ? new THREE.Mesh(shape, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, depthTest: false, depthWrite: false })) : null;
        if (!fill) shape.dispose();
        for (const m of fill ? [box, fill] : [box]) {
          m.position.set((pc.min[0] + pc.max[0]) / 2, (pc.min[1] + pc.max[1]) / 2, (pc.min[2] + pc.max[2]) / 2);
          m.renderOrder = 9;
          m.userData.model = 'piece';
          pieces.push(m);
          a.solid.add(m);
        }
      }
      showModel(a, modelViewRef.current, diffsRef.current);
      onModelRef.current?.({ state: 'ready', overlap: msg.overlap!, match: msg.match!, pieces: msg.pieces! });
    };
    const setups = program.setups.map(({ index, orient, offset, stock }) => ({ index, orient, offset, stock }));
    worker.postMessage({ type: 'model', bytes: model.bytes, input, setups });
    return () => {
      worker.terminate();
      for (const m of [...(mesh ? [mesh] : []), ...pieces]) {
        a.solid.remove(m);
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
      a.invalidate();
    };
  }, [model, path, program]);

  useEffect(() => {
    if (api.current) showModel(api.current, modelView, diffs);
  }, [modelView, diffs]);

  // The differences given (diffPieces): outlined and lightly filled in their colours, seen through the part.
  useEffect(() => {
    const a = api.current;
    if (!a || !diffPieces?.length) return;
    const made: (THREE.LineSegments | THREE.Mesh)[] = [];
    for (const pc of diffPieces) {
      const size = pc.max.map((v, k) => Math.max(v - pc.min[k], 0.2));
      const shape = new THREE.BoxGeometry(size[0], size[1], size[2]);
      const color = (diffColorsRef.current ?? PIECE_COLORS)[pc.kind];
      const box = new THREE.LineSegments(new THREE.EdgesGeometry(shape), new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true }));
      const fill = new THREE.Mesh(shape, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, depthTest: false, depthWrite: false }));
      for (const m of [box, fill]) {
        m.position.set((pc.min[0] + pc.max[0]) / 2, (pc.min[1] + pc.max[1]) / 2, (pc.min[2] + pc.max[2]) / 2);
        m.renderOrder = 9;
        m.userData.model = 'piece';
        made.push(m);
        a.solid.add(m);
      }
    }
    showModel(a, modelViewRef.current, diffsRef.current);
    return () => {
      for (const m of made) {
        a.solid.remove(m);
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
      a.invalidate();
    };
  }, [diffPieces]);

  // The setup's scene: fixture, toolpath, tool, markers.
  useEffect(() => {
    const a = api.current;
    if (!a) return;
    const { world, camera, controls } = a;
    disposeTree(world);
    world.clear();
    // A turn cut short leaves nothing behind (its old vise and cales live in the overlay).
    disposeTree(a.overlay);
    a.overlay.clear();
    a.anim = null;
    a.setupObjects = [];

    const [first, last] = range;
    const moves = path.moves.slice(first, last + 1);

    // Toolpath: feeds in the tool's colour, rapids dashed grey, ghost of the whole setup.
    const feedPos: number[] = [];
    const feedCol: number[] = [];
    const rapidPos: number[] = [];
    const feedStart: number[] = [];
    const rapidStart: number[] = [];
    const col = new THREE.Color();
    const push = (arr: number[], p: Vec) => arr.push(p[0], p[2], -p[1]);
    // Each move's path and running length, to place the tool anywhere along it.
    const paths = moves.map(movePath);
    const runs = paths.map(runShares);
    for (const [n, m] of moves.entries()) {
      const pts = paths[n];
      feedStart.push(feedPos.length / 3);
      rapidStart.push(rapidPos.length / 3);
      const target = m.kind === 'rapid' ? rapidPos : feedPos;
      if (m.kind !== 'rapid') col.set(colorOf(m.tool));
      for (let i = 1; i < pts.length; i++) {
        push(target, pts[i - 1]);
        push(target, pts[i]);
        if (m.kind !== 'rapid') feedCol.push(col.r, col.g, col.b, col.r, col.g, col.b);
      }
    }
    const feedAttr = new THREE.Float32BufferAttribute(feedPos, 3);
    // Each move's run of one tool (tool change to tool change): only the tool at work shows its path.
    const runFrom = moves.map((m, n) => (n > 0 && moves[n - 1].tool === m.tool ? -1 : n));
    for (let n = 1; n < moves.length; n++) if (runFrom[n] < 0) runFrom[n] = runFrom[n - 1];
    const runTo = moves.map((m, n) => (n < moves.length - 1 && moves[n + 1].tool === m.tool ? -1 : n));
    for (let n = moves.length - 2; n >= 0; n--) if (runTo[n] < 0) runTo[n] = runTo[n + 1];
    const feedEnd = (n: number) => (n + 1 < moves.length ? feedStart[n + 1] : feedPos.length / 3);
    const ghostGeo = new THREE.BufferGeometry();
    ghostGeo.setAttribute('position', feedAttr);
    const ghost = new THREE.LineSegments(ghostGeo, new THREE.LineBasicMaterial({ color: 0x33415e, transparent: true, opacity: 0.55 }));
    world.add(ghost);
    const feedGeo = new THREE.BufferGeometry();
    feedGeo.setAttribute('position', feedAttr);
    feedGeo.setAttribute('color', new THREE.Float32BufferAttribute(feedCol, 3));
    const feeds = new THREE.LineSegments(feedGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 }));
    world.add(feeds);
    // The run of the tool under the pointer, in its colour over everything else.
    const litGeo = new THREE.BufferGeometry();
    litGeo.setAttribute('position', feedAttr);
    const litMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, depthTest: false });
    const lit = new THREE.LineSegments(litGeo, litMat);
    lit.renderOrder = 8;
    lit.visible = false;
    world.add(lit);
    a.pickPath = (ray, near) => {
      if (ray) ray.params.Line = { threshold: near };
      const hit = ray && moves.length && ghost.visible ? ray.intersectObject(ghost, false)[0] : undefined;
      let k = -1;
      if (hit?.index !== undefined) for (let n = 0; n < moves.length; n++) if (moves[n].kind !== 'rapid' && feedStart[n] <= hit.index) k = n;
      const tool = k >= 0 ? moves[k].tool : null;
      lit.visible = tool !== null;
      if (tool !== null) {
        litGeo.setDrawRange(feedStart[runFrom[k]], feedEnd(runTo[k]) - feedStart[runFrom[k]]);
        litMat.color.set(colorOf(tool));
      }
      a.invalidate();
      return tool;
    };
    const rapidGeo = new THREE.BufferGeometry();
    rapidGeo.setAttribute('position', new THREE.Float32BufferAttribute(rapidPos, 3));
    const rapids = new THREE.LineSegments(rapidGeo, new THREE.LineDashedMaterial({ color: 0x7f8ba0, dashSize: 2, gapSize: 2, transparent: true, opacity: 0.5 }));
    rapids.computeLineDistances();
    world.add(rapids);
    // The piece of the current move between its last corner and the tool.
    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3));
    const trailMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 });
    const trail = new THREE.LineSegments(trailGeo, trailMat);
    trail.frustumCulled = false;
    trail.visible = false;
    world.add(trail);
    a.setupObjects.push(ghost, feeds, rapids, trail);

    // Fixture and the outline of the part.
    const stockGroup = new THREE.Group();
    const fixture = new THREE.Group();
    world.add(fixture);
    const jaws: THREE.MeshStandardMaterial[] = [];
    const s = setup?.stock;
    let floorZ = Math.min(path.min[2], 0) - 10;
    a.stockFill = null;
    if (setup && s) {
      floorZ = setup.floorZ ?? s.min[2];
      stockGroup.position.copy(v3([(s.min[0] + s.max[0]) / 2, (s.min[1] + s.max[1]) / 2, (s.min[2] + s.max[2]) / 2]));
      const outline = box(s.min, s.max, 0xb9c6da, 0.3, 0xdfe8f5);
      outline.position.sub(stockGroup.position);
      // The see-through block is shown until the solid part is ready.
      a.stockFill = outline.children[0];
      a.stockFill.visible = !a.solidReady;
      (outline.children[1] as THREE.LineSegments).material = new THREE.LineBasicMaterial({ color: 0xdfe8f5, transparent: true, opacity: 0.18 });
      stockGroup.add(outline);
      world.add(stockGroup);

      a.cales = buildCales(setup);
      if (a.cales) fixture.add(a.cales);
      const clamp = buildClamp(setup, s, floorZ);
      // The vise's model comes in once loaded: drawn again then.
      void clamp.ready.then(() => a.invalidate());
      fixture.add(clamp.group);
      jaws.push(...clamp.jawMats);
      a.spacerEdges = clamp.spacerEdges;
      a.clamp = clamp.group;
      a.fixture = fixture;
      showThrough(fixture, a.seeThrough);
      a.jaw = clamp.moving && { obj: clamp.moving, travel: JAW_TRAVEL };

      // RAFI / TASTER: an arrow from the part toward the faces the program names, and a label.
      if (setup.marker && setup.marker.faces.length) {
        const marker = new THREE.Group();
        const d: Vec = [0, 0, 0];
        for (const f of setup.marker.faces) FACE_DIR[f].forEach((x, i) => (d[i] += x));
        const half: Vec = [(s.max[0] - s.min[0]) / 2, (s.max[1] - s.min[1]) / 2, (s.max[2] - s.min[2]) / 2];
        const edge = new THREE.Vector3(d[0] * half[0], d[2] * half[2], -d[1] * half[1]);
        const dir = new THREE.Vector3(d[0], d[2], -d[1]).normalize();
        const len = Math.max(12, Math.max(...half) * 0.6);
        marker.add(new THREE.ArrowHelper(dir, edge, len, 0xffa94d, len * 0.3, len * 0.18));
        const tag = label(`${setup.marker.name} ${setup.marker.faces.join(' ')}`, '#FFB869');
        const h = Math.max(6, Math.max(...half) * 0.22);
        tag.scale.set(h * tag.userData.aspect, h, 1);
        tag.position.copy(edge.clone().add(dir.clone().multiplyScalar(len + h)));
        marker.add(tag);
        stockGroup.add(marker);
        a.setupObjects.push(marker);
      }
    }

    // Floor grid under the fixture.
    const span = Math.max(path.max[0] - path.min[0], path.max[1] - path.min[1], 60) * 2.2;
    const grid = new THREE.GridHelper(span, 22, 0x2c3953, 0x1a2234);
    const center = s ? [(s.min[0] + s.max[0]) / 2, (s.min[1] + s.max[1]) / 2] : [(path.min[0] + path.max[0]) / 2, (path.min[1] + path.max[1]) / 2];
    grid.position.copy(v3([center[0], center[1], floorZ - (setup?.jawTopZ !== null && s ? VISE_DEPTH : s ? 30 : 0)]));
    world.add(grid);

    // Collisions: a red dot where it happens, seen through everything; for a holder in the part also
    // the slice of the holder that is in the material, in red.
    const hits = new THREE.Group();
    const sizeOf = new Map(path.tools.map((t) => [t.tool, t]));
    const hitR = Math.max(1.8, (s ? Math.max(s.max[0] - s.min[0], s.max[1] - s.min[1]) : 60) * 0.015);
    for (const c of setup?.collisions ?? []) {
      const g = new THREE.Group();
      g.userData.move = c.move;
      g.userData.cale = c.what === 'cale';
      g.userData.spacer = c.what === 'spacer';
      const dot = new THREE.Mesh(new THREE.SphereGeometry(hitR, 20, 14), new THREE.MeshBasicMaterial({ color: g.userData.spacer ? 0x34d399 : g.userData.cale ? 0xf5b942 : 0xff4d4d, transparent: true, depthTest: false }));
      dot.renderOrder = 12;
      dot.position.copy(v3(c.point));
      g.add(dot);
      if (c.what === 'holderPart') {
        const { radius } = holderOf(path.moves[c.move]?.dia ?? sizeOf.get(c.tool ?? -1)?.diameter ?? 6);
        const h = Math.max(c.depth, 0.4);
        const geo = new THREE.CylinderGeometry(radius, radius, h, 48);
        // Seen through the part: it is inside the material.
        const zone = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xff3b3b, transparent: true, opacity: 0.4, depthWrite: false, depthTest: false }));
        zone.renderOrder = 11;
        zone.position.copy(v3([c.point[0], c.point[1], c.point[2] + h / 2]));
        const rim = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0xff8080, depthTest: false }));
        rim.renderOrder = 11;
        zone.add(rim);
        g.add(zone);
      }
      hits.add(g);
    }
    world.add(hits);

    // Tool: cutter plus holder, bottom at the tool tip.
    // The tool turned from its outline (drill tip, ball, face mill...), the holder as checked, both
    // with their edges drawn.
    const tool = new THREE.Group();
    const cutterMat = new THREE.MeshStandardMaterial({ color: 0xe8edf5, metalness: 0.8, roughness: 0.25, transparent: true, opacity: 0.9 });
    const holderMat = new THREE.MeshStandardMaterial({ color: 0x55627a, metalness: 0.6, roughness: 0.4 });
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x0b1018, transparent: true, opacity: 0.6 });
    const cutter = new THREE.Mesh(new THREE.BufferGeometry(), cutterMat);
    const holder = new THREE.Mesh(new THREE.BufferGeometry(), holderMat);
    const cutterEdges = new THREE.LineSegments(new THREE.BufferGeometry(), edgeMat);
    const holderEdges = new THREE.LineSegments(new THREE.BufferGeometry(), edgeMat);
    cutter.castShadow = holder.castShadow = true;
    tool.add(cutter, holder, cutterEdges, holderEdges);
    world.add(tool);
    a.setupObjects.push(tool);
    const turned = (mesh: THREE.Mesh, lines: THREE.LineSegments, outline: THREE.Vector2[]) => {
      mesh.geometry.dispose();
      mesh.geometry = new THREE.LatheGeometry(outline, 48);
      lines.geometry.dispose();
      lines.geometry = new THREE.EdgesGeometry(mesh.geometry, 25);
    };
    const hitList = setup?.collisions ?? [];
    const hitAt = new Map<number, (typeof hitList)[number]>();
    for (const c of hitList) if (!hitAt.has(c.move)) hitAt.set(c.move, c);
    // A tool (or holder) into the jaws turns the jaws red.
    const jawHitMoves = hitList.filter((c) => c.what !== 'holderPart' && c.what !== 'cale' && c.what !== 'spacer').map((c) => c.move);
    // A tool into a cale turns the cales yellow (a warning: move them).
    const caleHitMoves = hitList.filter((c) => c.what === 'cale').map((c) => c.move);
    const spacerHitMoves = hitList.filter((c) => c.what === 'spacer').map((c) => c.move);
    const caleMats = new Set<THREE.MeshStandardMaterial>();
    a.cales?.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if ((o as THREE.Mesh).isMesh) for (const x of Array.isArray(m) ? m : [m]) caleMats.add(x as THREE.MeshStandardMaterial);
    });
    const red = (m: THREE.MeshStandardMaterial, on: boolean, base: number) => {
      m.color.set(on ? 0xff4040 : base);
      m.emissive.set(on ? 0x8a0000 : 0x000000);
    };

    let toolOn: string | undefined;
    a.progress = (pos: number) => {
      // The move in progress (or the last one, once the setup is done) and the share of its time.
      const started = moves.length > 0 && pos > first;
      const k = started ? Math.min(Math.floor(pos), last) - first : -1;
      const cur = k >= 0 ? moves[k] : null;
      tool.userData.has = !!cur;
      tool.visible = !!cur && !a.anim;
      // The ghost: the whole path of the tool at work (the first tool before the setup starts).
      const r = Math.max(0, k);
      if (moves.length) ghostGeo.setDrawRange(feedStart[runFrom[r]], feedEnd(runTo[r]) - feedStart[runFrom[r]]);
      if (showAllRef.current && !playingRef.current) ghostGeo.setDrawRange(0, Infinity);
      if (!cur) {
        feedGeo.setDrawRange(0, 0);
        rapidGeo.setDrawRange(0, 0);
        trail.visible = false;
        a.meshAt = instant(Math.min(pos, first));
      } else {
        const at = toolAlong(cur, paths[k], runs[k], pos - (first + k));
        // Lines: every move before this one, the corners of this one already passed, and the
        // piece from the last corner to the tool.
        const segs = Math.max(0, paths[k].length - 1);
        const done = Math.min(at.done, segs);
        const rapid = cur.kind === 'rapid';
        const r0 = runFrom[k];
        feedGeo.setDrawRange(feedStart[r0], feedStart[k] - feedStart[r0] + (rapid ? 0 : done * 2));
        rapidGeo.setDrawRange(rapidStart[r0], rapidStart[k] - rapidStart[r0] + (rapid ? done * 2 : 0));
        trail.visible = done < segs;
        if (trail.visible) {
          const from = paths[k][done];
          const attr = trailGeo.getAttribute('position') as THREE.BufferAttribute;
          attr.setXYZ(0, from[0], from[2], -from[1]);
          attr.setXYZ(1, at.p[0], at.p[2], -at.p[1]);
          attr.needsUpdate = true;
          trailMat.color.set(rapid ? 0x7f8ba0 : colorOf(cur.tool));
          trailMat.opacity = rapid ? 0.5 : 0.85;
        }
        // The tool's shape only changes with the tool.
        if (toolOn !== `${cur.tool}|${cur.reach}`) {
          toolOn = `${cur.tool}|${cur.reach}`;
          const info = sizeOf.get(cur.tool ?? -1);
          const r = Math.max(0.5, (info?.diameter ?? 6) / 2);
          // The length the program states for this tool change (the holder starts there, as the
          // collision check has it); without one, a likely length. A face mill is a wide flat disk.
          const big = r >= 12;
          const len = cur.reach ?? (big ? Math.min(Math.max(info?.length ?? 30, 12), 40) : Math.min(Math.max(info?.length ?? r * 8, r * 3, 12), 80));
          const slope = tipSlope(info?.label ?? '');
          const tipH = slope ? Math.min(r / slope, len * 0.8) : 0;
          turned(cutter, cutterEdges, cutterProfile(shapeOf(info?.label ?? '', r), r, len, tipH, cornerTip(info?.label ?? '')?.corner));
          const { radius: hr, height: hh } = holderOf(r * 2);
          turned(holder, holderEdges, holderProfile(hr, hh, len));
        }
        tool.position.copy(v3(at.p));
        // At a collision: what hits turns red, the tool into the jaws or its holder.
        const hit = hitAt.get(first + k);
        red(cutterMat, !!hit && !hit.what, 0xe8edf5);
        red(holderMat, !!hit && (hit.what === 'holder' || hit.what === 'holderPart'), 0x55627a);
        if (hit?.what === 'cale') {
          cutterMat.color.set(0xf5b942);
          cutterMat.emissive.set(0x5a3c00);
        }
        // The solid as it is with the tool right here.
        a.meshAt = instant(first + k + at.cut);
        // The x-ray: the section through the tool (machine X, Y, Z are scene x, -z, y).
        if (a.section?.follow) {
          const ax = (['x', 'z', 'y'] as const)[a.section.axis];
          a.clip.constant = tool.position[ax];
        }
      }
      // The x-ray's tint: up to the end of the tool's run (all chunks again when that changes).
      const until = a.section?.follow && cur ? instant(first + runTo[k] + 1) : null;
      const tint = until !== a.until;
      a.until = until;
      const reached = cur ? first + k : first - 1;
      // Bright once the tool got there (dim before), and the jaws red from the first hit into them on.
      hits.children.forEach((h) =>
        h.traverse((o) => {
          const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
          if (m && (o as THREE.Mesh).isMesh) m.color.set(h.userData.spacer ? (h.userData.move <= reached ? 0x34d399 : 0x2f6b55) : h.userData.cale ? (h.userData.move <= reached ? 0xf5b942 : 0x7a6a3a) : h.userData.move <= reached ? 0xff4d4d : 0x7a3a3a);
        }),
      );
      const jawHit = jawHitMoves.some((m) => m <= reached);
      jaws.forEach((j) => red(j, jawHit, j.userData.base ?? STEEL_DARK.color));
      const caleHit = caleHitMoves.some((m) => m <= reached);
      caleMats.forEach((m) => m.emissive.set(caleHit ? 0x6a4a00 : 0x000000));
      const spacerHit = spacerHitMoves.some((m) => m <= reached);
      if (a.spacerEdges) {
        for (const l of a.spacerEdges.lines) {
          l.color.set(spacerHit ? 0x34d399 : 0x2a313d);
          l.opacity = spacerHit ? 1 : 0.35;
        }
        for (const f of a.spacerEdges.face) f.emissive.set(spacerHit ? 0x0e5a3a : 0x000000);
      }
      if (pathsOnlyRef.current) {
        // The NX view: the setup's every path, over the part as it is in the end.
        ghostGeo.setDrawRange(0, Infinity);
        feedGeo.setDrawRange(0, Infinity);
        rapidGeo.setDrawRange(0, Infinity);
        a.meshAt = instant(path.moves.length);
      }
      a.requestMesh(a.meshAt, tint);
      a.invalidate();
    };
    a.shownPos = clockRef.current.current;
    a.progress(a.shownPos);

    a.frame = () => {
      const bb = new THREE.Box3();
      // The part and what is round it (the jaws beside it), not the whole vise: the shop's vise is 438 mm long.
      if (s) {
        bb.expandByObject(stockGroup);
        bb.expandByScalar(Math.max(30, bb.getSize(new THREE.Vector3()).length() * 0.8));
      }
      if (feedPos.length) {
        feedGeo.computeBoundingBox();
        const pb = feedGeo.boundingBox!.clone();
        if (s) pb.intersect(new THREE.Box3().copy(bb).expandByScalar(60));
        bb.union(pb);
      }
      if (bb.isEmpty()) bb.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(50, 50, 50));
      return { c: bb.getCenter(new THREE.Vector3()), size: bb.getSize(new THREE.Vector3()).length() };
    };
    a.fit = () => {
      const { c, size } = a.frame();
      // The shadows: the key light from above-front-right, its shadow box round what is framed.
      a.key.position.copy(c).addScaledVector(new THREE.Vector3(120, 260, 180).normalize(), size * 1.5);
      a.key.target.position.copy(c);
      a.key.target.updateMatrixWorld();
      const sc = a.key.shadow.camera;
      sc.left = sc.bottom = -size * 0.75;
      sc.right = sc.top = size * 0.75;
      sc.near = size * 0.2;
      sc.far = size * 3;
      sc.updateProjectionMatrix();
      controls.resetPivot();
      controls.target.copy(c);
      camera.up.set(0, 1, 0);
      camera.position.copy(c).add(new THREE.Vector3(0.7, 1.05, 1).normalize().multiplyScalar(size * 1.25));
      camera.near = size / 200;
      camera.far = size * 40;
      camera.updateProjectionMatrix();
      controls.update();
      a.invalidate();
    };
    // Framed again for another setup or program, not when only how it is held is redrawn (a preview).
    if (fitFor.current.path !== path || fitFor.current.at !== `${range[0]}:${range[1]}`) {
      fitFor.current = { path, at: `${range[0]}:${range[1]}` };
      a.fit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, setup, range[0], range[1], colorOf]);

  useEffect(() => {
    if (fitKey) api.current?.fit();
  }, [fitKey]);

  // The outer shape on or off: the part asked for again, whole.
  useEffect(() => {
    const a = api.current;
    if (a && a.solidReady) a.requestMesh(a.meshAt, true);
  }, [hull]);

  // Measuring (lib/measure3d.ts). Pressing Measure hides the part while it is analysed: the part shown must be the
  // part at this instant, then its plunged holes are found and their rims drawn; clicks then measure.
  useEffect(() => {
    const a = api.current;
    const el = host.current;
    if (!a || !el || !measure) return;
    let alive = true;
    let session: ReturnType<typeof attachMeasure> | null = null;
    const rims = new THREE.Group();
    rims.userData.simRims = true;
    rims.visible = modelViewRef.current !== 'model';
    a.solid.add(rims);
    const rimMat = new THREE.LineBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.45 });
    let planes: THREE.Mesh[] = [];
    // What is drawn: the simulated part, the model (it is the real part: measuring it is measuring the drawing), or both.
    const chunks = () => a.solid.children.filter((c) => (c.userData.chunk || c.userData.model === 'mesh') && c.visible) as THREE.Mesh[];
    const toolName = (tool: number | null) => {
      const tl = path.tools.find((x) => x.tool === tool);
      return tl ? `T${tl.tool} ${tl.label}`.trim() : '';
    };
    // Analyse: the part at this instant, then its holes; their rims drawn so they can be picked.
    onSolidRef.current?.({ state: 'analysing', share: 1 });
    a.shownPos = clockRef.current.current;
    a.progress(a.shownPos);
    a.settle = () => {
      a.holesBefore(Math.floor(a.meshAt / SUB)).then((found) => {
        if (!alive) return;
        for (const h of found) {
          const { u } = holeAxis(h);
          rims.add(ring([h.top[0] - u[0] * 0.02, h.top[1] - u[1] * 0.02, h.top[2] - u[2] * 0.02], u, h.r, rimMat));
        }
        // The vise's bed between the jaws, its jaw faces and tops and the stop's face, as planes to measure to (item 17):
        // quads in the clamping's frame, brought into the part's (the measure's root), raycast but not drawn.
        const s = setupNow.current;
        if (s && s.floorZ !== null && s.jawTopZ !== null && s.clampBox && a.world.visible) {
          a.world.updateMatrixWorld(true);
          a.solid.updateMatrixWorld(true);
          const spans = viseSpans(s);
          const [xa, xb] = [spans[0][0], spans[spans.length - 1][1]];
          const [f, j] = [s.floorZ, s.jawTopZ];
          // Where the jaws are drawn (buildVise): on the part's real faces, past any spacer.
          const front = (s.grip?.front ?? s.clampBox.min[1]) - spacerAt(s, 'Y-');
          const back = (s.grip?.back ?? s.clampBox.max[1]) + spacerAt(s, 'Y+');
          const quad = (q: [number, number, number][]) => {
            const p = q.map((x) => a.solid.worldToLocal(a.world.localToWorld(v3(x))));
            const m = new THREE.Mesh(new THREE.BufferGeometry().setFromPoints([p[0], p[1], p[2], p[0], p[2], p[3]]), PLANE);
            rims.add(m);
            return m;
          };
          // Just off each face on its open side, so a click on the drawn face finds its plane before the vise.
          const e = PLANE_EPS;
          planes = [
            quad([[xa, front, f + e], [xb, front, f + e], [xb, back, f + e], [xa, back, f + e]]),
            quad([[xa, front + e, f], [xa, front + e, j], [xb, front + e, j], [xb, front + e, f]]),
            quad([[xa, back - e, f], [xb, back - e, f], [xb, back - e, j], [xa, back - e, j]]),
            quad([[xa + e, front, f], [xa + e, back, f], [xa + e, back, j], [xa + e, front, j]]),
            quad([[xa, front - JAW_TOPS.moving, j + e], [xb, front - JAW_TOPS.moving, j + e], [xb, front, j + e], [xa, front, j + e]]),
            quad([[xa, back, j + e], [xb, back, j + e], [xb, back + JAW_TOPS.fixed, j + e], [xa, back + JAW_TOPS.fixed, j + e]]),
          ];
        }
        session = attachMeasure({
          el,
          root: a.solid,
          camera: a.camera,
          invalidate: a.invalidate,
          setAfterRender: (f) => (a.afterRender = f),
          parts: () => [...chunks(), ...planes],
          // In the clamp: the vise and parallels hide what is behind them; on them only a point is measured, or the
          // vise's planes (just in front of its faces).
          blockers: () => {
            const held: THREE.Object3D[] = [];
            if (a.world.visible && !a.seeThrough) a.fixture?.traverse((o) => (o as THREE.Mesh).isMesh && o.visible && held.push(o));
            return held;
          },
          // On the model: the hole is fitted to its facets; on the simulation: the holes the tools plunged.
          holeAt: (p, hit) => (planes.includes(hit.object as THREE.Mesh) ? null : hit.object.userData.model === 'mesh' ? holeOfMesh((hit.object as THREE.Mesh).geometry.getAttribute('position').array as Float32Array, hit.faceIndex ?? 0) : holeAt(found, p)),
          mode: () => modeRef.current,
          onMeasure: (m) => onMeasureRef.current?.(m),
          toolName,
        });
        resetMeasure.current = session.reset;
        onSolidRef.current?.({ state: 'ready', share: 1 });
        onMeasureRef.current?.(null);
        a.invalidate();
      });
    };
    a.requestMesh(a.meshAt);
    return () => {
      alive = false;
      a.settle = null;
      if (!session) onSolidRef.current?.({ state: 'ready', share: 1 });
      session?.stop();
      resetMeasure.current = null;
      disposeTree(rims);
      a.solid.remove(rims);
      a.invalidate();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measure]);
  // Another mode: start again (the part stays analysed).
  useEffect(() => resetMeasure.current?.(), [mode]);

  useEffect(() => {
    const a = api.current;
    if (!a) return;
    a.repaint();
    // The first time: the worker measures the walls and sends the part again with them.
    if (heat) a.requestMesh(a.meshAt, true);
  }, [heat]);

  // Part only: hide the vise, supports, toolpath and tool.
  useEffect(() => {
    const a = api.current;
    if (!a) return;
    a.world.visible = !isolate;
    if (isolate && a.solidReady) {
      // Frame the part alone.
      const bb = new THREE.Box3().setFromObject(a.solid);
      if (!bb.isEmpty()) {
        const c = bb.getCenter(new THREE.Vector3());
        const size = bb.getSize(new THREE.Vector3()).length();
        a.controls.resetPivot();
        a.controls.target.copy(c);
        a.camera.up.set(0, 1, 0);
        a.camera.position.copy(c).add(new THREE.Vector3(0.7, 1.05, 1).normalize().multiplyScalar(size * 1.35));
        a.controls.update();
      }
    } else if (!isolate) a.fit();
    a.invalidate();
  }, [isolate]);

  // Turning the part between setups: the jaw opens, the part lifts, turns (an arrow shows the
  // way) and sets down, then the jaw closes. Opening a setup directly just clamps it.
  // A jump (see Jump) hides the part until the part there is shown; a jump to a setup change then
  // plays the turn from the setup before.
  const lastSetup = useRef<SetupInfo | null>(null);
  const lastJump = useRef<Jump | null>(null);
  const turnLater = useRef(0);
  // A turn that is waiting to start hides the new clamp and toolpaths; if it is called off, this
  // puts everything where the turn would have left it (else the clamp stayed hidden).
  const callOff = useRef<(() => void) | null>(null);
  // A turn under way: cut short by the next change, it is finished at once first (a review: else the paths, markers
  // and new parallels it hides stayed hidden).
  const turnUnderWay = useRef<(() => void) | null>(null);
  useEffect(() => {
    const a = api.current;
    clearTimeout(turnLater.current);
    callOff.current?.();
    callOff.current = null;
    if (turnUnderWay.current) {
      const done = turnUnderWay.current;
      turnUnderWay.current = null;
      if (a) a.anim = null;
      done();
    }
    const fresh = jump && jump !== lastJump.current ? jump : null;
    lastJump.current = jump;
    if (setup === lastSetup.current && !fresh) return;
    let prev = lastSetup.current;
    lastSetup.current = setup;
    if (!a || !setup) return;
    if (fresh?.kind === 'flip') prev = fresh.from;
    // Wait for the part at the new instant (the 3D view follows the clock on the next frame: now).
    const whenShown = (then: () => void) => {
      a.shownPos = clockRef.current.current;
      a.progress(a.shownPos);
      a.settle = then;
      a.requestMesh(a.meshAt);
    };
    if (fresh) onSolidRef.current?.({ state: 'jumping', share: 1 });
    const shown = () => onSolidRef.current?.({ state: 'ready', share: 1 });
    if (a.clamp) a.clamp.visible = true;
    // A change cut off mid-slide leaves no pair outside the vise.
    if (a.cales) a.cales.position.x = 0;
    const end = poseOf(setup);
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    disposeTree(a.overlay);
    a.overlay.clear();
    const jaw = a.jaw;
    const setJaw = (open: number) => {
      if (jaw) jaw.obj.position.set(0, 0, open * jaw.travel); // three Z = machine -Y (towards the front)
    };
    const ease = (x: number) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2);
    // Scrubbing (not playing) and jumping to the end: straight to the new setup, no turn or cale change; unless every
    // change turns (the owner: clicking a clamping or an operation in another one too, and going back).
    const always = turnAlwaysRef.current && !!prev && prev.index !== setup.index && fresh?.kind !== 'end';
    const instant = !playingRef.current && fresh?.kind !== 'flip' && !always;
    if (!prev || (prev.index >= setup.index && !always) || !a.solidReady || reduce || instant) {
      a.solid.matrix.copy(end);
      a.solid.matrixWorldNeedsUpdate = true;
      if (fresh) whenShown(shown);
      if (reduce || !jaw || instant) {
        a.anim = null;
        setJaw(0);
        a.invalidate();
        return;
      }
      // Clamp: the jaw closes on the part.
      const t0 = performance.now();
      setJaw(1);
      a.anim = (now) => {
        const t = Math.min(1, (now - t0) / 450);
        setJaw(1 - ease(t));
        return t < 1;
      };
      a.invalidate();
      return;
    }
    const p0 = new THREE.Vector3();
    const q0 = new THREE.Quaternion();
    const p1 = new THREE.Vector3();
    const q1 = new THREE.Quaternion();
    const sc = new THREE.Vector3();
    poseOf(prev).decompose(p0, q0, sc);
    end.decompose(p1, q1, sc);
    // Each setup has its own Z0, so the table is at another height in each one. During the turn the
    // old vise, cales and part are drawn on the new setup's table (else the old cales stood sunk
    // into the new vise bed).
    const lift0 = v3([0, 0, prev.floorZ !== null && setup.floorZ !== null ? setup.floorZ - prev.floorZ : 0]);
    p0.add(lift0);
    const height = setup.stock ? Math.max(setup.stock.max[2] - setup.stock.min[2], 20) : 30;

    // The poses the part goes through: every written turn alone, in the order written, around the
    // machine's axes (three X/Y/Z = machine X/Z/-Y), when together they give the new pose; else one turn.
    const machineAxis = { X: new THREE.Vector3(1, 0, 0), Y: new THREE.Vector3(0, 0, -1), Z: new THREE.Vector3(0, 1, 0) };
    let poses = [q0.clone()];
    for (const r of setup.turns) poses.push(new THREE.Quaternion().setFromAxisAngle(machineAxis[r.axis], (r.deg * Math.PI) / 180).multiply(poses[poses.length - 1]));
    if (poses.length < 3 || Math.abs(poses[poses.length - 1].dot(q1)) < 0.999) poses = [q0.clone(), q1.clone()];
    else poses[poses.length - 1] = q1.clone();
    const steps = poses.length - 1;

    // The arrows: one per turn, around the part's middle.
    const arrows: (THREE.Group | null)[] = poses.slice(1).map((qb, k) => {
      const turn = qb.clone().multiply(poses[k].clone().invert());
      const angle = 2 * Math.acos(Math.min(1, Math.abs(turn.w))) * (turn.w < 0 ? -1 : 1);
      const axis = new THREE.Vector3(turn.x, turn.y, turn.z);
      if (axis.lengthSq() <= 1e-9 || Math.abs(angle) <= 0.1 || !setup.stock) return null;
      axis.normalize();
      const st = setup.stock;
      const size = Math.max(st.max[0] - st.min[0], st.max[1] - st.min[1], st.max[2] - st.min[2]);
      // Name the machine axis it turns around.
      const m = [axis.x, -axis.z, axis.y];
      const big = m.map(Math.abs).indexOf(Math.max(...m.map(Math.abs)));
      const deg = Math.round(Math.abs((angle * 180) / Math.PI));
      const arrow = turnArrow(axis, angle, size * 0.5, steps > 1 ? `${k + 1}/${steps} · ${deg}° ${'XYZ'[big]}` : `${deg}° ${'XYZ'[big]}`);
      // Around the part's middle, a little above the jaws.
      arrow.position.copy(v3([(st.min[0] + st.max[0]) / 2, (st.min[1] + st.max[1]) / 2, st.max[2] + height * 0.35]));
      arrow.visible = false;
      a.overlay.add(arrow);
      return arrow;
    });

    // Changing cales, slowly enough to see which ones: with the part up, the old pair slides out along
    // the vise and the new pair slides in, its height shown; then the part sets down on them.
    // Both stand on the same table: nothing moves through it.
    const newCales = a.cales;
    const oldCales = buildCales(prev);
    const changing = calesKey(prev) !== calesKey(setup) && (!!newCales || !!oldCales);
    // Out past the vise's right end (the stop is on the left), clear of any vise.
    const spans = setup.jawTopZ !== null ? viseSpans(setup) : null;
    const slide = spans ? spans[spans.length - 1][1] - spans[0][0] + 40 : 200;
    if (oldCales && changing) {
      oldCales.position.copy(lift0);
      a.overlay.add(oldCales);
    } else if (oldCales) disposeTree(oldCales);
    const tagOf = (c: THREE.Group | null) => (c?.userData.tag as THREE.Sprite | undefined) ?? null;
    // Timeline (ms): unclamp, lift and turn, [change the cales], set down, clamp.
    const UNCLAMP = FLIP_MS * 0.15;
    const TURN = FLIP_MS * 0.55;
    const DOWN = FLIP_MS * 0.15;
    const CLAMP = FLIP_MS * 0.15;
    const SWAP = changing ? CALE_MS : 0;
    const tTurn = UNCLAMP;
    // Turning starts once the part is a little up; each written turn gets the same time.
    const tRot = tTurn + TURN * 0.2;
    const STEP = (TURN * steps - TURN * 0.2) / steps;
    const tSwap = tTurn + TURN * steps;
    const tDown = tSwap + SWAP;
    const tClamp = tDown + DOWN;
    const total = tClamp + CLAMP;
    const part = (ms: number, from: number, len: number) => (len > 0 ? Math.min(1, Math.max(0, (ms - from) / len)) : ms >= from ? 1 : 0);
    const placeCales = (ms: number) => {
      if (!changing) return;
      // The old pair slides out with its height shown, then the new pair slides in with its own.
      const { out, inn } = caleSlide(part(ms, tSwap, SWAP));
      if (oldCales) {
        oldCales.position.x = ease(out) * slide;
        oldCales.visible = out < 1;
        tagOf(oldCales)!.visible = ms >= tSwap && out < 1;
      }
      if (newCales) {
        newCales.position.x = (1 - ease(inn)) * slide;
        newCales.visible = inn > 0;
        tagOf(newCales)!.visible = inn > 0 && ms < tClamp;
      }
    };
    placeCales(0);
    // The old clamping holds the part until it is lifted out; then the new one is there, open.
    const s0 = prev.stock;
    const oldClamp = s0 ? buildClamp(prev, s0, prev.floorZ ?? s0.min[2]) : null;
    if (oldClamp) {
      oldClamp.group.position.copy(lift0);
      a.overlay.add(oldClamp.group);
    }
    const swapAt = tTurn + TURN * 0.3;
    const newClamp = a.clamp;
    const hide = a.setupObjects;
    hide.forEach((o) => (o.visible = false));
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    a.solid.matrix.compose(p0, q0, one);
    a.solid.matrixWorldNeedsUpdate = true;
    if (newClamp && oldClamp) newClamp.visible = false;
    setJaw(0);
    let start = 0;
    let target = new THREE.Vector3();
    let off = new THREE.Vector3();
    const run = (now: number) => {
      // The camera steps back while the part turns, so the turn and its arrow are seen whole.
      if (!start) {
        start = now;
        target = a.controls.target.clone();
        off = a.camera.position.clone().sub(target);
      }
      const ms = now - start;
      const open = ms < tTurn ? ease(ms / UNCLAMP) : ms >= tClamp ? 1 - ease(part(ms, tClamp, CLAMP)) : 1;
      setJaw(open);
      oldClamp?.moving?.position.set(0, 0, open * JAW_TRAVEL);
      if (oldClamp) {
        oldClamp.group.visible = ms < swapAt;
        if (newClamp) newClamp.visible = ms >= swapAt;
      }
      const back = ease(Math.min(1, ms / (tTurn + TURN * 0.25))) * (1 - ease(part(ms, tDown, DOWN + CLAMP)));
      a.camera.position.copy(target).addScaledVector(off, 1 + 0.45 * back);
      // Up in the first part of the turn, turning (one written turn after the other), waiting up
      // there while the cales change, down.
      const lift = ease(part(ms, tTurn, TURN * 0.4)) * (1 - ease(part(ms, tDown, DOWN)));
      const k = Math.min(steps - 1, Math.max(0, Math.floor((ms - tRot) / STEP)));
      q.slerpQuaternions(poses[k], poses[k + 1], ease(part(ms, tRot + k * STEP, STEP)));
      p.lerpVectors(p0, p1, ease(part(ms, tRot, STEP * steps)));
      p.y += lift * height * 1.3;
      a.solid.matrix.compose(p, q, one);
      a.solid.matrixWorldNeedsUpdate = true;
      placeCales(ms);
      // Each turn's arrow while it turns (the last one until it sets down when nothing else happens).
      arrows.forEach((ar, i) => {
        if (ar) ar.visible = i === k && (i < steps - 1 || (changing ? ms < tSwap : ms < tClamp));
      });
      if (ms >= total) {
        a.camera.position.copy(target).add(off);
        finish();
        return false;
      }
      return true;
    };
    function finish() {
      turnUnderWay.current = null;
      // The camera back where it was (it steps back while the part turns).
      if (start) a!.camera.position.copy(target).add(off);
      a!.solid.matrix.copy(end);
      a!.solid.matrixWorldNeedsUpdate = true;
      setJaw(0);
      if (newClamp) newClamp.visible = true;
      if (newCales) {
        newCales.position.x = 0;
        newCales.visible = true;
        tagOf(newCales)!.visible = false;
      }
      disposeTree(a!.overlay);
      a!.overlay.clear();
      hide.forEach((o) => (o.visible = o.userData.has !== false));
    }
    // After a jump the part is hidden until it is cut up to here; it turns once the veil is gone.
    if (fresh) {
      callOff.current = () => {
        finish();
        a.invalidate();
      };
      whenShown(() => {
        shown();
        turnLater.current = window.setTimeout(() => {
          callOff.current = null;
          turnUnderWay.current = finish;
          a.anim = run;
          a.invalidate();
        }, 450);
      });
    } else {
      turnUnderWay.current = finish;
      a.anim = run;
    }
    a.invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setup, jump]);

  // The vise, clamp and cales see-through, or solid again.
  useEffect(() => {
    const a = api.current;
    if (!a) return;
    a.seeThrough = seeThrough;
    if (a.fixture) showThrough(a.fixture, seeThrough);
    a.invalidate();
  }, [seeThrough]);

  // Outlines (in a colour that stands out on this material) and the section.
  useEffect(() => {
    const a = api.current;
    if (!a) return;
    a.outline = outline ? LOOKS[look].edge : null;
    a.invalidate();
  }, [outline, look]);
  useEffect(() => {
    const a = api.current;
    if (!a) return;
    a.section = section;
    a.applySection();
    // The x-ray on or off: the plane and the tint follow the tool from the instant shown.
    a.progress(clockRef.current.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section?.axis, section?.at, section?.follow]);
  // The NX view on or off: drawn again at the instant shown.
  useEffect(() => {
    api.current?.progress(clockRef.current.current);
  }, [pathsOnly]);

  // Top, front or the usual 3/4 view, flown to (of the part alone when it is shown alone).
  useEffect(() => {
    const a = api.current;
    if (!a || !view) return;
    const box = !a.world.visible && a.solidReady ? new THREE.Box3().setFromObject(a.solid) : null;
    const { c, size } = box && !box.isEmpty() ? { c: box.getCenter(new THREE.Vector3()), size: box.getSize(new THREE.Vector3()).length() } : a.frame();
    const dir = view.kind === 'top' ? new THREE.Vector3(0, 1, 0) : view.kind === 'front' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0.7, 1.05, 1).normalize();
    // Seen from the top, machine +Y points up the screen.
    const up = view.kind === 'top' ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
    a.controls.resetPivot();
    a.controls.flyTo(c.clone().addScaledVector(dir, size * 1.25), c, up);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.key]);

  // A collision: fly close to where it happens, from the side the camera is on.
  useEffect(() => {
    const a = api.current;
    if (!a || !focus) return;
    const p = v3(focus.point);
    const dir = a.camera.position.clone().sub(a.controls.target).normalize();
    const d = Math.max(a.frame().size * 0.45, 40);
    a.controls.flyTo(p.clone().addScaledVector(dir, d), p, a.camera.up.clone(), 700);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.key]);

  return <div ref={host} className="absolute inset-0 cursor-grab active:cursor-grabbing touch-none" />;
}
