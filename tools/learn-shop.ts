/**
 * Learns the shop's way of programming from its programs: cutting data per material, tool type and
 * Ø (rpm, feed, plunge feed, depth per pass, step-over, peck), the order of operations, the raw
 * stock allowance and how the clamping is written. Writes src/lib/cam/shopKnowledge.json, which
 * CAM AI uses, and prints a report.
 *
 *   npm run learn-shop -- <folders and files: programs, or exported learning records (.json)>
 *
 * Programs are found by their "(TOOLPATH ...)" comments; the same program twice counts once.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { readProgram, summarise, type Sample } from '../src/lib/cam/learn';

const files: string[] = [];
const walk = (p: string) => {
  const st = lstatSync(p);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    if (!/(^|\/)(node_modules|\.git)$/.test(p)) for (const n of readdirSync(p)) walk(join(p, n));
  } else if (st.size < 20_000_000) files.push(p);
};
for (const a of process.argv.slice(2)) walk(a);

const seen = new Set<string>();
const programs: { name: string; text: string }[] = [];
const add = (name: string, text: string) => {
  // A program: numbered lines with the CAM's operation comments (not code files that quote one).
  if (!/^N\d+ \(TOOLPATH /m.test(text)) return;
  const h = createHash('sha1').update(text.replace(/\s+/g, ' ')).digest('hex');
  if (seen.has(h)) return;
  seen.add(h);
  programs.push({ name, text });
};
for (const f of files) {
  const buf = readFileSync(f);
  if (f.endsWith('.json')) {
    // An export of learning records: the programs kept in the part records.
    try {
      const j = JSON.parse(buf.toString('utf8'));
      for (const l of j.lessons ?? []) if (l.program) add(l.fileName ?? l.id, gunzipSync(Buffer.from(l.program, 'base64')).toString('utf8'));
    } catch {
      /* not an export */
    }
    continue;
  }
  if (buf.includes(0) || /\.(m?js|cjs|tsx?|map|html|css|svg|py|sql|md)$/i.test(f)) continue; // binary or code
  add(f, buf.toString('latin1'));
}

const samples: Sample[] = [];
const parts = programs.map((p) => readProgram(p.text, p.name));
for (const p of parts) samples.push(...p.samples);
const knowledge = summarise(parts);
writeFileSync(join(process.cwd(), 'src/lib/cam/shopKnowledge.json'), JSON.stringify(knowledge, null, 1) + '\n');

// Report.
console.log(`${programs.length} programs, ${samples.length} operations`);
for (const [mat, types] of Object.entries(knowledge.cut))
  for (const [type, rows] of Object.entries(types))
    for (const r of rows)
      console.log(
        `${mat.padEnd(5)} ${type.padEnd(4)} Ø${String(r.d).padEnd(6)} ${r.kind.padEnd(8)} n=${String(r.n).padEnd(4)} S ${r.s ?? '-'}  F ${r.f ?? '-'}  Fz ${r.fz ?? '-'}  ap ${r.ap ?? '-'}  ae ${r.ae ?? '-'}  Q ${r.q ?? '-'}`,
      );
console.log('order:', knowledge.order.join(' → '));
console.log('allowance (raw - finished, mm):', knowledge.allowance);
console.log('setups per part:', knowledge.setups);
