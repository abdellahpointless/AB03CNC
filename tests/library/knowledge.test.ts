/// <reference types="node" />
/*
 * The knowledge base (docs/knowledge, written by `npm run knowledge`) against the reference library:
 * every line it cites is that line of that program, word for word, and it never names an order (the
 * repository is public). The citation check is skipped without CNC_LIBRARY=<folder>.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const LIB = process.env.CNC_LIBRARY;
const kb = JSON.parse(readFileSync('docs/knowledge/knowledge.json', 'utf8'));
type Cite = { file: string; line: number; text: string };

/** Every citation anywhere in the knowledge base. */
function cites(v: unknown, out: Cite[] = []): Cite[] {
  if (Array.isArray(v)) v.forEach((x) => cites(x, out));
  else if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.file === 'string' && typeof o.line === 'number' && typeof o.text === 'string') out.push(o as unknown as Cite);
    else Object.values(o).forEach((x) => cites(x, out));
  }
  return out;
}

describe('the knowledge base', () => {
  it('names no order, only program files', () => {
    for (const f of ['docs/knowledge/knowledge.json', 'docs/knowledge/README.md']) {
      const text = readFileSync(f, 'utf8');
      expect(text).not.toMatch(/\b\d{12}_(?:HAAS|FANUC|MIXED)\b|\b[13]0000\d{7}\b/);
      expect(text).not.toMatch(/BEARBEITER\s*:\s*(?!<name>)\w/);
    }
    // No part name: a cited header line shows only its sizes.
    for (const c of cites(kb).filter((x) => /ZUSCHNITT|\d\s*X\s*\d+(?:[.,]\d+)?\s*X\s*\d/i.test(x.text))) expect(c.text).toMatch(/\(<part>/);
  });

  it.skipIf(!LIB)('cites each line as it is in the library', () => {
    const texts = new Map<string, string[][]>();
    for (const folder of readdirSync(LIB!)) {
      const dir = join(LIB!, folder);
      if (!/^\d+_/.test(folder) || !statSync(dir).isDirectory()) continue;
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (n === 'info.json' || !statSync(p).isFile()) continue;
        texts.set(n, [...(texts.get(n) ?? []), readFileSync(p).toString('latin1').replace(/\r/g, '').split('\n')]);
      }
    }
    const all = cites(kb);
    expect(all.length).toBeGreaterThan(50);
    // Header lines are cited with the part's (and programmer's) name masked, as tools/knowledge.ts does.
    const mask = (t: string) => (/ZUSCHNITT|BEARBEITER|\d\s*X\s*\d+(?:[.,]\d+)?\s*X\s*\d/i.test(t) ? t.replace(/\(([^/)]*)(\/|\))/, (_w, _n: string, end: string) => `(<part>${end === '/' ? ' /' : ')'}`).replace(/BEARBEITER\s*:?[^/)]*/gi, 'BEARBEITER: <name>') : t);
    const wrong = all.filter((c) => !(texts.get(c.file) ?? []).some((lines) => mask(lines[c.line - 1]?.trim().slice(0, 90) ?? '') === c.text));
    expect(wrong).toEqual([]);
  });
});
