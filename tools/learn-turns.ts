/**
 * Learns how parts really turn from folders of programs with their 3D models (for example what the
 * order collector downloads: one folder per order, the NC program and the part's 3D PDF).
 *
 * For each program, every way its setups can turn is simulated against the model (the same search
 * as the toolpath viewer); when one matches, the turn each setup needed is recorded with its notes.
 * Writes learned-turns.json, to import in Admin → Data → "Import learned turns" (shared by every
 * country), and prints how often the notes alone were read right.
 *
 *   npm run learn-turns -- <folder> [...]
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseToolpath, speedsFor } from '../src/lib/toolpath';
import { DEFAULT_JAW_HEIGHT, relTurn, turnKey } from '../src/lib/setups';
import { searchTurns, TARGET } from '../src/lib/fixTurns';
import { readModel } from '../src/lib/model';

const opts = { jawHeight: DEFAULT_JAW_HEIGHT };
/** A G-code program: numbered lines and an end, not a PDF, a picture or the collector's notes. */
const isProgram = (name: string, text: string) => !/\.(pdf|stl|json|csv|txt|png|jpe?g|html?)$/i.test(name) && /^N\d+\s/m.test(text) && /M0*(30|2)\b/.test(text);
/** A part model: an STL, or a PDF that holds a 3D (PRC) stream. */
const isModel = (name: string, bytes: Buffer) => /\.stl$/i.test(name) || (/\.pdf$/i.test(name) && bytes.includes('/PRC'));

const folders: string[] = [];
const walk = (p: string) => {
  if (!statSync(p).isDirectory()) return;
  const entries = readdirSync(p);
  if (entries.some((n) => statSync(join(p, n)).isFile())) folders.push(p);
  for (const n of entries) if (statSync(join(p, n)).isDirectory()) walk(join(p, n));
};
for (const a of process.argv.slice(2)) walk(a);

const counts = new Map<string, number>();
let checked = 0;
let readRight = 0;
let matched = 0;
let noMatch = 0;
for (const dir of folders) {
  const files = readdirSync(dir).filter((n) => statSync(join(dir, n)).isFile());
  const model = files.find((n) => isModel(n, readFileSync(join(dir, n))));
  const programs = files.filter((n) => isProgram(n, readFileSync(join(dir, n), 'latin1')));
  if (!model || !programs.length) continue;
  let tris: Float32Array;
  try {
    tris = await readModel(new Uint8Array(readFileSync(join(dir, model))));
  } catch (e) {
    console.log(`${dir}: model not readable (${e instanceof Error ? e.message : e})`);
    continue;
  }
  for (const name of programs) {
    const tp = parseToolpath(readFileSync(join(dir, name), 'latin1'), speedsFor('HAAS'));
    if (tp.setups.length < 2) continue;
    checked++;
    const t0 = Date.now();
    const r = searchTurns(tris, tp, opts);
    const took = ((Date.now() - t0) / 1000).toFixed(0);
    if (!r || r.match < TARGET) {
      noMatch++;
      console.log(`${dir}/${name}: no turns match the model (${r ? (r.match * 100).toFixed(1) : '?'} %, ${took} s)`);
      continue;
    }
    matched++;
    if (r.same) readRight++;
    console.log(`${dir}/${name}: ${r.same ? 'read right from its notes' : `notes read wrong, corrected (${(r.start * 100).toFixed(1)} -> ${(r.match * 100).toFixed(1)} %)`} (${took} s)`);
    r.orients.slice(1).forEach((m, i) => {
      const key = turnKey(tp.setups[i + 1].notes.map((n) => n.text));
      if (!key) return;
      const id = `${key}\u0000${relTurn(m, r.orients[i]).join()}`;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    });
  }
}

const entries = [...counts].map(([id, n]) => {
  const [key, rel] = id.split('\u0000');
  return { key, rel, n };
});
writeFileSync('learned-turns.json', JSON.stringify({ format: 'cnc-learned-turns-v1', entries }, null, 1));
console.log(`\n${checked} programs with a model; ${matched} matched (${readRight} read right from their notes alone, ${matched - readRight} corrected), ${noMatch} did not match.`);
console.log(`learned-turns.json: ${entries.length} learned turns. Import it in Admin → Data → "Import learned turns".`);
