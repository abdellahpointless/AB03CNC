import { PRC_DOUBLE_CODES } from './prcDoubleTable';

/*
 * The 3D model inside a 3D PDF: the PRC stream's tessellation (the triangles the PDF viewer shows),
 * read into one flat list of triangles (9 numbers each, the PRC's own units, usually mm).
 * Format: ISO 14739-1 (PRC); field layout as in prc-rs (https://github.com/ralovich/prc-rs, MIT).
 * shortcut: plain tessellation (PRC_TYPE_TESS_3D) only, not the compressed kind (173) and not exact
 * surfaces (B-rep); placements from the model tree are not applied. Upgrade when a PDF needs them.
 */

const TESS_3D = 172;
const TESS_3D_COMPRESSED = 173;
const TESS_FACE = 174;
const TESS_3D_WIRE = 175;
const FILE_STRUCTURE_TESSELLATION = 305;
const MODEL_FILE = 301;

export class PrcError extends Error {}

/** Code (bit count, bits) -> row of the frequent-double table. */
const CODES = (() => {
  const m = new Map<number, number>();
  for (let r = 0; r < PRC_DOUBLE_CODES.length / 5; r++) {
    const key = PRC_DOUBLE_CODES[r * 5 + 1] * 0x800000 + PRC_DOUBLE_CODES[r * 5 + 2];
    if (!m.has(key)) m.set(key, r);
  }
  return m;
})();

/** PRC's bit stream: most significant bit first. */
class Bits {
  p = 0;
  constructor(private b: Uint8Array) {}
  bit(): number {
    if (this.p >= this.b.length * 8) throw new PrcError('PRC: unexpected end of data');
    const v = (this.b[this.p >> 3] >> (7 - (this.p & 7))) & 1;
    this.p++;
    return v;
  }
  bits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.bit();
    return v >>> 0;
  }
  bool(): boolean {
    return this.bit() === 1;
  }
  /** Unsigned integer: up to 4 bytes, least significant first, each after a 1 bit; a 0 bit ends it. */
  ui(): number {
    let v = 0;
    for (let i = 0; i < 4 && this.bit(); i++) v += this.bits(8) * 2 ** (8 * i);
    return v;
  }
  int(): number {
    let v = 0;
    let j = 0;
    for (; j < 4 && this.bit(); j++) v |= this.bits(8) << (8 * j);
    return j ? (v << ((4 - j) * 8)) >> ((4 - j) * 8) : 0;
  }
  str(): string {
    if (!this.bool()) return '';
    const n = this.ui();
    if (n > 1 << 20) throw new PrcError('PRC: string too long');
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.bits(8));
    return s;
  }
  /** PRC's packed double: a code from the table, a sign, then the mantissa bytes that differ. */
  double(): number {
    let code = 0;
    let row = -1;
    for (let i = 1; i <= 22; i++) {
      code = (code << 1) | this.bit();
      const r = CODES.get(i * 0x800000 + code);
      if (r !== undefined) {
        row = r;
        break;
      }
    }
    if (row < 0) throw new PrcError('PRC: unknown number code');
    const kind = PRC_DOUBLE_CODES[row * 5];
    const bytes = new Uint8Array(8);
    const view = new DataView(bytes.buffer);
    view.setUint32(4, PRC_DOUBLE_CODES[row * 5 + 3], true);
    view.setUint32(0, PRC_DOUBLE_CODES[row * 5 + 4], true);
    if (PRC_DOUBLE_CODES[row * 5 + 1] === 2 && PRC_DOUBLE_CODES[row * 5 + 2] === 1 && kind === 0) return view.getFloat64(0, true);
    if (this.bit()) bytes[7] |= 0x80;
    if (kind === 0 || !this.bool()) return view.getFloat64(0, true);
    bytes[6] |= this.bits(4) & 0x0f;
    let last = 0;
    let cur = 5;
    while (cur >= last) {
      if (this.bool()) bytes[cur] = this.bits(8);
      else {
        const offset = this.bits(3);
        if (offset === 0) {
          const b = bytes[cur + 1];
          while (cur >= last) bytes[cur--] = b;
          break;
        }
        if (offset === 6) {
          const b = bytes[cur + 1];
          last++;
          while (cur >= last) bytes[cur--] = b;
          bytes[cur] = this.bits(8);
          break;
        }
        if (cur + offset >= 8) throw new PrcError('PRC: bad number');
        bytes[cur] = bytes[cur + offset];
      }
      cur--;
    }
    return view.getFloat64(0, true);
  }
}

function skipAttributes(r: Bits) {
  const entry = () => (r.bool() ? r.ui() : r.str());
  for (let n = r.ui(); n > 0; n--) {
    r.ui(); // PRC_TYPE_MISC_Attribute
    entry();
    for (let k = r.ui(); k > 0; k--) {
      entry();
      const type = r.ui();
      if (type === 1 || type === 3) r.int();
      else if (type === 2) r.double();
      else if (type === 4) r.str();
      else if (type === 5) (r.int(), r.ui());
    }
  }
}

function skipBase(r: Bits) {
  skipAttributes(r);
  if (!r.bool()) r.str(); // name
}

/** One PRC_TYPE_TESS_3D (its id already read): its triangles, added to `out`. */
function readTess3D(r: Bits, authoring: number, out: number[]) {
  r.bool(); // is_calculated
  const coords = Array.from({ length: r.ui() }, () => r.double());
  r.bool(); // has_faces
  if (authoring >= 7039) r.bool(); // has_loops
  if (authoring >= 7047 && r.bool()) {
    r.bits(8);
    r.double();
  }
  for (let n = r.ui(); n > 0; n--) r.double(); // normals
  for (let n = r.ui(); n > 0; n--) r.ui(); // wire indices
  const index = Array.from({ length: r.ui() }, () => r.ui());
  const faces = r.ui();
  for (let f = 0; f < faces; f++) {
    if (r.ui() !== TESS_FACE) throw new PrcError('PRC: face expected');
    const lineAttributes = r.ui();
    for (let n = lineAttributes; n > 0; n--) r.ui();
    r.ui(); // start of wire data
    for (let n = r.ui(); n > 0; n--) r.ui();
    const flags = r.ui();
    let at = r.ui();
    const counts = Array.from({ length: r.ui() }, () => r.ui());
    r.ui(); // texture index count
    if (r.bool()) throw new PrcError('PRC: vertex colours are not supported');
    if (lineAttributes > 0) r.ui();

    const vertex = () => {
      const i = index[at++];
      out.push(coords[i], coords[i + 1], coords[i + 2]);
    };
    let c = 0;
    // Each kind of triangle data, in flag order: plain (normal per vertex) or one normal; textured adds an index per vertex.
    for (const bit of [0x2, 0x4, 0x8, 0x20, 0x40, 0x80, 0x200, 0x400, 0x800, 0x2000, 0x4000, 0x8000]) {
      if (!(flags & bit)) continue;
      const kind = bit & 0xff ? bit : bit >> 8;
      const tex = bit > 0xff ? 1 : 0;
      const oneNormal = kind >= 0x20;
      const shape = oneNormal ? kind >> 4 : kind; // 2 triangle, 4 fan, 8 strip
      // One vertex: its normal (unless one normal for all), its texture index, its point.
      const pts = (n: number, single: boolean): number[][] => {
        if (single) at++;
        const list: number[][] = [];
        for (let k = 0; k < n; k++) {
          if (!single) at++;
          at += tex;
          const s = out.length;
          vertex();
          list.push(out.splice(s, 3));
        }
        return list;
      };
      if (shape === 2) {
        const n = counts[c++];
        for (let t = 0; t < n; t++) for (const p of pts(3, oneNormal)) out.push(...p);
      } else {
        const groups = counts[c++];
        for (let g = 0; g < groups; g++) {
          const raw = counts[c++];
          const list = pts(raw & 0x3fffffff, oneNormal || (raw & 0x40000000) !== 0);
          for (let k = 2; k < list.length; k++) {
            const tri = shape === 4 ? [list[0], list[k - 1], list[k]] : k % 2 ? [list[k - 1], list[k - 2], list[k]] : [list[k - 2], list[k - 1], list[k]];
            for (const p of tri) out.push(...p);
          }
        }
      }
    }
  }
  for (let n = r.ui(); n > 0; n--) r.double(); // texture coordinates
}

/** Inflate a zlib stream (the PDF's and PRC's compression). */
async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate'));
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      size += value.length;
    }
  } catch {
    // A section is followed by the next one: what was inflated before the error is the section.
    if (!size) throw new PrcError('PRC: a section does not unpack');
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
}

/** Triangles of a PRC file's plain tessellation, in mm. */
export async function readPrc(prc: Uint8Array): Promise<Float32Array> {
  const dv = new DataView(prc.buffer, prc.byteOffset, prc.byteLength);
  if (String.fromCharCode(prc[0], prc[1], prc[2]) !== 'PRC') throw new PrcError('PRC: not a PRC stream');
  const authoring = dv.getUint32(7, true);
  let o = 3 + 8 + 32;
  const structures = dv.getUint32(o, true);
  o += 4;
  const out: number[] = [];
  let compressed = false;
  const tables: number[][] = [];
  for (let s = 0; s < structures; s++) {
    const sections = dv.getUint32(o + 20, true);
    tables.push(Array.from({ length: sections }, (_, k) => dv.getUint32(o + 24 + 4 * k, true)));
    o += 24 + 4 * sections;
  }
  // Each section is unpacked alone, up to where the next one starts: Chrome drops the end of a
  // section when other data follows it.
  const starts = [...tables.flat(), dv.getUint32(o, true), dv.getUint32(o + 4, true)].filter((v) => v > 0 && v <= prc.length).sort((a, b) => a - b);
  const section = (at: number) => prc.subarray(at, starts.find((v) => v > at) ?? prc.length);
  for (const offsets of tables) {
    const tess = await inflate(section(offsets[3]));
    const r = new Bits(tess);
    if (r.ui() !== FILE_STRUCTURE_TESSELLATION) throw new PrcError('PRC: tessellation section expected');
    skipBase(r);
    const count = r.ui();
    for (let t = 0; t < count; t++) {
      const id = r.ui();
      if (id === TESS_3D) readTess3D(r, authoring, out);
      else if (id === TESS_3D_COMPRESSED) {
        compressed = true;
        break;
      } else if (id === TESS_3D_WIRE) break; // edges only: nothing more to draw after them here
      else break;
    }
  }
  if (!out.length) throw new PrcError(compressed ? 'PRC: compressed tessellation is not supported yet' : 'PRC: no triangles in the model');
  // The model file says how many mm one unit is (CAD exports often write metres).
  // The model file section starts with its schema (none in the exports seen), then the model file.
  const mf = new Bits(await inflate(section(dv.getUint32(o, true))));
  let mm = NaN;
  if (mf.ui() === 0 && mf.ui() === MODEL_FILE) {
    skipBase(mf);
    mf.bool();
    mm = mf.double();
  }
  let scale = Number.isFinite(mm) && mm > 0 ? mm : 1;
  // shortcut: some exports say mm in the model file but place the part in metres through the model
  // tree (not read here); a part under 1 mm on every side is such a one. Read the tree's
  // placements if an export ever uses another scale.
  let extent = 0;
  for (let i = 0; i < out.length; i += 3) extent = Math.max(extent, Math.abs(out[i] - out[0]), Math.abs(out[i + 1] - out[1]), Math.abs(out[i + 2] - out[2]));
  if (extent * scale < 1) scale *= 1000;
  return Float32Array.from(out, (v) => v * scale);
}

/** The PRC stream of a 3D PDF (its /Subtype /PRC stream, inflated when the PDF compresses it). */
export async function prcFromPdf(pdf: Uint8Array): Promise<Uint8Array> {
  const text = new TextDecoder('latin1').decode(pdf);
  const head = /<<((?:(?!>>\s*stream)[\s\S])*?\/Subtype\s*\/PRC[\s\S]*?)>>\s*stream\r?\n/.exec(text);
  if (!head) throw new PrcError('PDF: no 3D model in this PDF');
  const dict = head[1];
  const start = head.index + head[0].length;
  let length = Number(/\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict)?.[1] ?? NaN);
  if (!Number.isFinite(length)) {
    const ref = /\/Length\s+(\d+)\s+(\d+)\s+R/.exec(dict);
    const obj = ref && new RegExp(`(?:^|\\s)${ref[1]}\\s+${ref[2]}\\s+obj\\s*(\\d+)`).exec(text);
    length = obj ? Number(obj[1]) : text.indexOf('endstream', start) - start;
  }
  const raw = pdf.subarray(start, start + length);
  return /\/FlateDecode/.test(dict) ? inflate(raw) : raw;
}

/** The model of a 3D PDF as triangles. */
export async function readPdfModel(pdf: Uint8Array): Promise<Float32Array> {
  return readPrc(await prcFromPdf(pdf));
}
