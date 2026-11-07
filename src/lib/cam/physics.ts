/*
 * CAM AI's engineering checks (hand formulas with safety factors, not finite elements): what the
 * cutting does to the tool, and what the vise does to the part.
 *   - Cutting force: power over cutting speed, F = kc·ap·ae·vf / (π·D·n), twice that at its peak.
 *   - Tool bending: a cantilever of the typed length, its fluted core 0.8 Ø (low-grade carbide);
 *     a drill buckling under its thrust (HSS, web 0.6 Ø).
 *   - The vise: the part must not slip or tip under the cut (friction and the grip's lever), must
 *     not be crushed under the jaws, squeezed out of size, or bowed; where it sticks out past the
 *     parallels or spans between them it must not bend under the tool.
 *   - 3-2-1: it lies on both parallels, against the fixed jaw over a length, and against the stop.
 * When the vise cannot hold the part for the cut, the cut is slowed (force follows the feed); when
 * even a third of the feed is too much, the setup fails.
 */

/** E (modulus), strength (yield / flexural), compressive (at 1 % strain for plastics), MPa; density g/cm³; kc N/mm². */
export interface MaterialData {
  E: number;
  strength: number;
  compressive: number;
  density: number;
  kc: number;
  /** Friction against the steel jaws (dry, the low end of published values). */
  mu: number;
  /** Where the values come from. */
  source: string;
}

export const MATERIAL_DATA: Record<string, MaterialData> = {
  ALU: { E: 71_000, strength: 125, compressive: 125, density: 2.66, kc: 700, mu: 0.3, source: 'EN AW-5083 O/H111 (EN 485-2 minimum Rp0.2); kc: wrought Al group' },
  MS: { E: 96_000, strength: 220, compressive: 220, density: 8.47, kc: 700, mu: 0.3, source: 'MS58 CuZn39Pb3 R430; kc: brass group' },
  PCGF: { E: 4_400, strength: 85, compressive: 44, density: 1.43, kc: 300, mu: 0.25, source: 'PC GF30 (Ensinger TECANAT GF30); compressive and kc estimated' },
  POM: { E: 2_800, strength: 67, compressive: 20, density: 1.41, kc: 200, mu: 0.2, source: 'TECAFORM AH datasheet (compression at 1 %); kc estimated' },
  EPO: { E: 2_800, strength: 67, compressive: 20, density: 1.41, kc: 200, mu: 0.2, source: 'as POM (TECAFORM AH), as the shop asked' },
  PEEK: { E: 4_200, strength: 116, compressive: 23, density: 1.31, kc: 300, mu: 0.25, source: 'TECAPEEK natural datasheet (compression at 1 %); kc estimated' },
  FH: { E: 15_000, strength: 150, compressive: 120, density: 1.3, kc: 200, mu: 0.3, source: 'DIN 7707 laminated compressed beech, grade B: conservative estimates' },
  RESOPAL: { E: 9_000, strength: 80, compressive: 80, density: 1.35, kc: 300, mu: 0.25, source: 'RESOPAL Compact datasheet (flexural); compressive and kc estimated' },
};

/** Low-grade carbide (mills, gravers) and HSS (drills), MPa. */
export const E_CARBIDE = 550_000;
export const E_HSS = 210_000;
/** Peak over mean cutting force (2-3 flute end mills, entering a corner). */
export const PEAK = 1.5;
/** Most a 150 mm vise clamps (N). */
export const VISE_MAX_FORCE = 30_000;
/** How far a tool or the part may bend: roughing, finishing (mm). */
export const DEFLECTION = { rough: 0.05, finish: 0.01 };
/** How much the jaws may squeeze the part across while it is cut (mm): precise parts, the others (shop rule). */
export const SQUEEZE = { precise: 0.02, normal: 0.05 };
/** Margins the shop's daily practice bears out ("not that strong" cuts): holding, crushing, a drill buckling. */
export const SAFETY = { hold: 1.5, crush: 1.2, buckle: 3 };
/** The parallels: 125 mm long, from the stop (one set in each vise). */
export const PARALLEL_LENGTH = 125;
/** Slowest a cut may be made to fit the vise (share of its feed). */
export const MIN_FEED = 0.3;

export const materialData = (m: string) => MATERIAL_DATA[m] ?? MATERIAL_DATA.POM;

/** Mean tangential force of a milling cut (N): kc·ap·ae·vf / (π·D·n). */
export const millForce = (kc: number, ap: number, ae: number, feed: number, rpm: number, d: number) => (kc * ap * ae * feed) / (Math.PI * d * Math.max(rpm, 1));

/** Thrust of a drill (N): half of kc over its Ø times the feed per turn. */
export const drillThrust = (kc: number, d: number, feed: number, rpm: number) => 0.5 * kc * d * (feed / Math.max(rpm, 1));

/** Bending of a tool's tip under a side force (mm): cantilever of length L, core 0.8 Ø. */
export const toolDeflection = (F: number, L: number, d: number, E = E_CARBIDE) => (F * L ** 3) / ((3 * E * Math.PI * (0.8 * d) ** 4) / 64);

/** The thrust a drill buckles under (N): held in the chuck, guided by the hole (0.7 L), web 0.6 Ø. */
export const drillBuckling = (L: number, d: number, E = E_HSS) => (Math.PI ** 2 * E * ((Math.PI * (0.6 * d) ** 4) / 64)) / (0.7 * L) ** 2;

/** A wall (height h, thickness t) bent at its top by a side force over width b (mm): cantilever plate. */
export const wallDeflection = (F: number, h: number, t: number, b: number, E: number) => (4 * F * h ** 3) / (E * b * t ** 3);

/** A beam's end bent by force F at distance a from where it is held (mm); section width b, height h. */
export const cantilever = (F: number, a: number, b: number, h: number, E: number) => (F * a ** 3) / (3 * E * ((b * h ** 3) / 12));

/** A beam on two supports `span` apart bent by force F in the middle (mm); section width b, height h. */
export const midSpan = (F: number, span: number, b: number, h: number, E: number) => (F * span ** 3) / (48 * E * ((b * h ** 3) / 12));

/** What one operation pushes with: across (N), down (N), and how far from the stop it works (mm). */
export interface OpLoad {
  side: number;
  down: number;
  /** Farthest X from the part's left face (the stop) the operation cuts at. */
  reach: number;
}

export interface SetupLoad {
  material: string;
  /** Held part: length along the jaws (X), width between them (Y), height (Z), mm. */
  length: number;
  width: number;
  height: number;
  /** How deep the jaws grip (mm). */
  grip: number;
  /** Thinnest the part gets over the parallels (mm). */
  thin: number;
  /** Most the jaws may squeeze it across (SQUEEZE.precise on top plates, contour inserts, seal cages). */
  squeeze?: number;
  /** Where the jaws, the parallels and the stop really touch it (see contactOf in program.ts). */
  contact: Contact;
  loads: OpLoad[];
}

export interface Contact {
  /** Length along X both jaws touch the part (mm). */
  jaws: number;
  /** Length along X it sits on each parallel (front, back), mm. */
  rest: [number, number];
  /** It touches the stop. */
  stop: boolean;
}

export type PhysicsIssue =
  | { key: 'slowed'; share: number }
  | { key: 'cannotHold'; need: number; most: number }
  | { key: 'overhang'; mm: number }
  | { key: 'span'; mm: number }
  | { key: 'jawContact'; mm: number }
  | { key: 'restContact' }
  | { key: 'stopContact' };

export interface SetupCheck {
  /** Clamping force: least that holds, most the part takes, and the one to use (N). */
  clamp: { min: number; max: number; use: number };
  /** Jaw pressure at that force (MPa) and its share of what the material takes (0..1+). */
  pressure: number;
  pressureShare: number;
  /** How much the jaws squeeze the part across (mm). */
  squeeze: number;
  /** The hardest push of an operation: across, down (N). */
  force: { side: number; down: number };
  /** Feed share the vise allows (1: as planned), and each operation's share with its own bending (overhang, span) on top. */
  feed: number;
  opFeed: number[];
  issues: PhysicsIssue[];
  /** Safe: held, not crushed, nothing bends past its limit (slowed cuts included). */
  ok: boolean;
}

/** The checks of one setup. */
export function checkSetup(l: SetupLoad): SetupCheck {
  const m = materialData(l.material);
  const issues: PhysicsIssue[] = [];
  const side = Math.max(0, ...l.loads.map((o) => o.side));
  const g = Math.max(0.5, l.grip);
  // Least force that holds: no slip (friction on two jaw faces), no tipping under the cut at the
  // part's top. Across the jaws it bears on their edges over the grip and rubs on both faces
  // (grip/2 + μ·width per newton of clamp); along them only the friction on the contact holds it
  // (μ·length/2). The weaker way counts.
  const slip = (SAFETY.hold * side) / (2 * m.mu);
  const arm = Math.max(0.5, Math.min(g / 2 + m.mu * l.width, (m.mu * l.contact.jaws) / 2));
  const tip = (SAFETY.hold * side * l.height) / arm;
  const min = Math.max(slip, tip);
  // Most it takes: crushing under the jaws, squeezing it out of size (the force spreads at 45°
  // up from the grip), bowing up (Euler, both ends held), the vise itself.
  const jaws = Math.max(1, l.contact.jaws);
  const area = jaws * g;
  const crush = (m.compressive * area) / SAFETY.crush;
  const section = jaws * Math.min(l.height, g + l.width / 2);
  const squeeze = ((l.squeeze ?? SQUEEZE.normal) * m.E * section) / Math.max(1, l.width);
  const buckle = (Math.PI ** 2 * m.E * ((jaws * l.height ** 3) / 12)) / (0.5 * Math.max(1, l.width)) ** 2 / SAFETY.buckle;
  const max = Math.min(crush, squeeze, buckle, VISE_MAX_FORCE);
  let feed = 1;
  if (min > max) {
    feed = max / min;
    if (feed >= MIN_FEED) issues.push({ key: 'slowed', share: Math.round(feed * 100) / 100 });
    else issues.push({ key: 'cannotHold', need: Math.round(min), most: Math.round(max) });
  }
  // A third over the least, never over the most.
  const use = Math.min(max, Math.max(min * feed * 1.3, 500));
  // Bending where nothing holds it from below: past the parallels' end, and between them.
  const opFeed = l.loads.map((o) => {
    let k = 1;
    const past = o.reach - PARALLEL_LENGTH;
    if (past > 0 && o.down > 0) {
      const d = cantilever(o.down * feed, past, l.width, l.thin, m.E);
      if (d > DEFLECTION.finish) {
        k = Math.min(k, DEFLECTION.finish / d);
        if (k * feed < MIN_FEED) issues.push({ key: 'overhang', mm: Math.round(past) });
      }
    }
    const span = l.width - 2 * Math.min(6, l.width / 6);
    if (o.down > 0 && span > 0) {
      // A force on a plate spreads over about the span along X, at most the length it rests on.
      const d = midSpan(o.down * feed, span, Math.max(1, Math.min(span, Math.min(...l.contact.rest) || l.length)), l.thin, m.E);
      if (d > DEFLECTION.finish) {
        if ((DEFLECTION.finish / d) * feed < MIN_FEED) issues.push({ key: 'span', mm: Math.round(span) });
        k = Math.min(k, DEFLECTION.finish / d);
      }
    }
    return Math.max(MIN_FEED, Math.min(1, feed) * k);
  });
  // 3-2-1: on both parallels, against the fixed jaw over a length, against the stop.
  const along = Math.min(l.length, 142);
  if (l.contact.jaws < Math.min(20, along * 0.3)) issues.push({ key: 'jawContact', mm: Math.round(l.contact.jaws) });
  if (Math.min(...l.contact.rest) < Math.min(10, along * 0.3)) issues.push({ key: 'restContact' });
  if (!l.contact.stop) issues.push({ key: 'stopContact' });
  const pressure = use / area;
  return {
    clamp: { min: Math.round(min), max: Math.round(max), use: Math.round(use) },
    pressure: Math.round(pressure * 10) / 10,
    pressureShare: Math.round((pressure / m.compressive) * 100) / 100,
    squeeze: Math.round(((use * l.width) / (m.E * section)) * 10000) / 10000,
    force: { side: Math.round(side), down: Math.round(Math.max(0, ...l.loads.map((o) => o.down))) },
    feed: Math.round(Math.max(MIN_FEED, feed) * 100) / 100,
    opFeed: opFeed.map((k) => Math.round(k * 100) / 100),
    issues,
    ok: !issues.some((i) => i.key !== 'slowed'),
  };
}
