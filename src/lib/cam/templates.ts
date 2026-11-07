/*
 * The shop's NX operation templates ("Program Order" HTML export): one row per operation with its
 * tool code (SF_08.00_044_000_KS: type, Ø, length, angle or radius, material suffix), depth of
 * cut, step-over, feed and rpm. Stock and floor stock are not kept: CAM AI cuts to the model.
 */

export type Family = 'ALU' | 'POM' | 'FH';

/** What an operation does, from its template name. */
export type TemplateKind =
  | 'face'
  | 'contour'
  | 'pocket'
  | 'finish'
  | 'drill'
  | 'centre'
  | 'spot'
  | 'ream'
  | 'counterbore'
  | 'chamfer'
  | 'deburr'
  | 'engrave'
  | 'countersink'
  | 'radius'
  | 'tslot'
  | 'ball';

export interface TemplateOp {
  kind: TemplateKind;
  /** The template's name, as in the shop's programs (KONTUR_8MM, BOHREN_2.96MM…). */
  name: string;
  /** Depth per pass (mm); null: the whole depth (drills) or not given. */
  ap: number | null;
  /** Step-over as a share of the Ø (0.5) or in mm; null: not given ("Multiple"). */
  ae: { share: number } | { mm: number } | null;
  /** Cutting feed (mm/min) and spindle speed (rpm). */
  feed: number;
  rpm: number;
}

export interface TemplateTool {
  /** As written in the programs' tool comments: SF_08.00_044_000_KS. */
  code: string;
  /** SF, SFH, SB, ZB, AB, ST, MK, KS, UDM, TF, KF, RA. */
  type: string;
  d: number;
  /** Length out of the holder (mm). */
  length: number;
  /** The third field: 000, a point angle (G45 = 45° per side) or a radius (R03). */
  shape: string;
  /** The shop's tool number (T and H in the programs). */
  number: number;
  ops: TemplateOp[];
}

const KINDS: [RegExp, TemplateKind][] = [
  [/^(PLAN|VORPLAN|MESSERKOPF)/, 'face'],
  [/^(ZENTRIER|ZENTR)/, 'centre'],
  [/^NC-ANBOHR/, 'spot'],
  [/^REIBEN/, 'ream'],
  [/^ABSENKUNG/, 'counterbore'],
  [/^(SENK|FASE_SENKER)/, 'countersink'],
  [/^BOHREN/, 'drill'],
  [/^(SCHLICHT|SCHL-)/, 'finish'],
  [/^(TASCHE|TASCH_|POCKETING|CAVITY_SCHRUPP)/, 'pocket'],
  [/^(KONTUR|PROFIL|EINFACH_KONTUR|ZYLINDER)/, 'contour'],
  [/^ENTGRATEN/, 'deburr'],
  [/^FASE/, 'chamfer'],
  [/^GRAVUR/, 'engrave'],
  [/^T-NUT/, 'tslot'],
  [/^KUGEL/, 'ball'],
];

/** The kind of a template, or null for what CAM AI does not use (taps, machine control). */
export function templateKind(name: string, type: string): TemplateKind | null {
  if (type === 'GB') return null; // taps: not used (shop decision)
  if (type === 'UDM') return 'radius';
  if (type === 'KF') return 'ball';
  if (type === 'KS') return 'countersink';
  return KINDS.find(([re]) => re.test(name))?.[1] ?? null;
}

const num = (s: string) => {
  const m = s.replace(',', '.').match(/-?\d*\.?\d+/);
  return m ? Number(m[0]) : null;
};

function stepover(s: string): TemplateOp['ae'] {
  const share = s.match(/([\d.]+)\s*%/);
  if (share) return { share: Number(share[1]) / 100 };
  const mm = s.match(/([\d.]*\.?\d+)\s*mm/);
  return mm ? { mm: Number(mm[1]) } : null;
}

/** Rows of an HTML table as cell texts. */
function rows(html: string): string[][] {
  const out: string[][] = [];
  for (const tr of html.split(/<tr[\s>]/i).slice(1)) {
    const cells = [...tr.split(/<\/tr>/i)[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) =>
      m[1]
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim(),
    );
    if (cells.length) out.push(cells);
  }
  return out;
}

/** Columns: Title, Tool, Description, Tool Number, Stock, Floor Stock, Depth of Cut, Stepover, Shortest Tool Length, Feed, Speed, Surface Speed. */
export function parseTemplates(html: string): TemplateTool[] {
  const tools = new Map<string, TemplateTool>();
  for (const c of rows(html)) {
    const [title, toolCode, , number, , , doc, step, , feed, speed] = c;
    const m = toolCode?.match(/^([A-Z]{2,3})_(\d+\.\d+)_(\d{3})_([A-Z0-9.]+)_/);
    if (!m) continue; // header, groups, machine control, operations without a tool
    const [, type, d, length, shape] = m;
    const kind = templateKind(title, type);
    const f = num(feed ?? '');
    const s = num(speed ?? '');
    if (!kind || !f || !s) continue;
    // Same tool under a numbered copy (SF_08.00_065_000_KS_1): the same tool.
    const code = toolCode.replace(/^(.*_[A-Z]+)_\d+$/, '$1');
    const tool =
      tools.get(code) ??
      tools
        .set(code, { code, type, d: Number(d), length: Number(length), shape, number: Number(number) || 0, ops: [] })
        .get(code)!;
    const ap = /model/i.test(doc ?? '') ? null : num(doc ?? '');
    tool.ops.push({ kind, name: title, ap: ap && ap > 0 ? ap : null, ae: stepover(step ?? ''), feed: f, rpm: s });
  }
  return [...tools.values()].sort((a, b) => a.type.localeCompare(b.type) || a.d - b.d || a.length - b.length);
}
