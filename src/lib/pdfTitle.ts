import { inflate } from './prc';

/*
 * The title block of a 3D PDF (what a reader shows before the 3D view is switched on): its form
 * fields "title" (Top plate 100201637205), "erp_number" (SAP material), "zeichner" (drafter).
 * The fields can sit in compressed object streams (PDF 1.5), which are unpacked first.
 */

export interface PdfInfo {
  title: string | null;
  sap: string | null;
  author: string | null;
}

/** Every object's dictionary text, packed ones included. */
async function dictionaries(pdf: Uint8Array): Promise<string[]> {
  const text = new TextDecoder('latin1').decode(pdf);
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|[\s>])\d+\s+\d+\s+obj\b/g)) {
    const s = m.index! + m[0].length;
    const e = text.indexOf('endobj', s);
    const body = text.slice(s, e < 0 ? undefined : e);
    const st = /stream\r?\n/.exec(body);
    if (!st || !/\/Type\s*\/ObjStm/.test(body.slice(0, st.index))) {
      out.push(st ? body.slice(0, st.index) : body);
      continue;
    }
    const dict = body.slice(0, st.index);
    const length = Number(/\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict)?.[1] ?? NaN);
    const start = s + st.index + st[0].length;
    const raw = pdf.subarray(start, Number.isFinite(length) ? start + length : text.indexOf('endstream', start));
    const data = await (/\/FlateDecode/.test(dict) ? inflate(raw) : Promise.resolve(raw)).catch(() => null);
    if (data) out.push(new TextDecoder('latin1').decode(data));
  }
  return out;
}

/** A PDF string's text: literal "(…)" with escapes or hex "<…>", UTF-16 when it starts with the BOM. */
function pdfString(raw: string, hex: boolean): string {
  const bytes = hex
    ? (raw.replace(/\s+/g, '').match(/../g) ?? []).map((h) => String.fromCharCode(parseInt(h, 16))).join('')
    : raw.replace(/\\([nrtbf()\\]|[0-7]{1,3}|\r?\n)/g, (_, e: string) =>
        /^[0-7]/.test(e) ? String.fromCharCode(parseInt(e, 8)) : /\n/.test(e) ? '' : ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' } as Record<string, string>)[e] ?? e,
      );
  if (bytes.startsWith('\xfe\xff')) {
    let s = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1));
    return s;
  }
  return bytes;
}

/** The form fields (name -> value) of the PDF. */
export async function pdfFields(pdf: Uint8Array): Promise<Map<string, string>> {
  const fields = new Map<string, string>();
  const str = String.raw`\(((?:\\.|[^\\)])*)\)|<([0-9a-fA-F\s]*)>`;
  for (const d of await dictionaries(pdf))
    for (const w of d.matchAll(/<<((?:(?!<<)[\s\S])*?\/Subtype\s*\/Widget[\s\S]*?)>>/g)) {
      const t = new RegExp(`/T\\s*(?:${str})`).exec(w[1]);
      const v = new RegExp(`/V\\s*(?:${str})`).exec(w[1]);
      if (t && v) fields.set(pdfString(t[1] ?? t[2], t[1] === undefined).trim().toLowerCase(), pdfString(v[1] ?? v[2], v[1] === undefined).trim());
    }
  return fields;
}

export async function pdfInfo(pdf: Uint8Array): Promise<PdfInfo> {
  const f = await pdfFields(pdf).catch(() => new Map<string, string>());
  return { title: f.get('title') || null, sap: f.get('erp_number') || null, author: f.get('zeichner') || null };
}
