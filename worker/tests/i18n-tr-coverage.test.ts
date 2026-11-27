import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import '../i18n-tr';
import { translateMessage } from '../i18n';

// Every fixed message and field name a Turkish country user can get from the server has its Turkish.
// The master hub's own routes (master.ts, alerts.ts) are left out: they answer the master dashboard.
const ROOT = join(__dirname, '..');
const SKIP = /(^|\/)(tests|routes\/master\.ts|routes\/alerts\.ts|i18n(-tr)?\.ts)/;
const files: string[] = [];
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const rel = p.slice(ROOT.length + 1);
    if (SKIP.test(rel)) continue;
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith('.ts')) files.push(p);
  }
};
walk(ROOT);
const source = files.map((f) => readFileSync(f, 'utf8')).join('\n');
const all = (re: RegExp) => [...new Set([...source.matchAll(re)].map((m) => m[1]))];

const messages = [...all(/new HttpError\(\d+,\s*'([^'\\]+)'/g), ...all(/consumeQuota\([^;]*?'([^'\\]+)'\);/g)];
const fields = [...all(/\b(?:str|num|optStr|optNum)\([^,()]+,\s*'([^']+)'/g), ...all(/\bintParam\([^,]+,\s*'([^']+)'/g)];
// Names that are the same word in Turkish.
const SAME = new Set(['Model', 'Program']);
const tr = (msg: string) => translateMessage(msg, 'tr');

describe('Turkish server dictionary covers the country messages', () => {
  it('finds the messages to check', () => {
    expect(messages.length).toBeGreaterThan(80);
    expect(fields.length).toBeGreaterThan(30);
  });

  it('translates every fixed message', () => {
    expect(messages.filter((m) => tr(m) === m)).toEqual([]);
  });

  it('translates every field name', () => {
    expect(fields.filter((f) => !SAME.has(f) && tr(`${f} is required`) === `${f} zorunludur.`)).toEqual([]);
  });
});
