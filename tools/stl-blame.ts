/**
 * Which setup of a program turned or placed the part wrong, found against the real finished part (STL).
 *
 * A tool never cuts into the finished part, and every bit of raw block that is not in it is cut by
 * some setup. So each setup is judged alone: for every way the part can lie in it (24 quarter
 * turns), its tools' cuts are laid onto the STL; the finished material they would cut (wrong) and the
 * waste they cut (right) are counted. The right way cuts no finished material and as much waste as
 * any way can. The setup the app turned wrong is the one whose chosen way does worse than another,
 * however many setups there are.
 *
 *   npm run stl-blame -- <program> <part.stl or 3D part.pdf> [...]
 */
import { readFileSync } from 'node:fs';
import { parseToolpath, speedsFor, type Vec } from '../src/lib/toolpath';
import { analyseProgram, DEFAULT_JAW_HEIGHT } from '../src/lib/setups';
import { buildInput } from '../src/lib/stockSim';
import { ALL, mul, transpose } from '../src/lib/orient';
import { layModel, NOISE, score, worse } from '../src/lib/modelCompare';
import { readModel } from '../src/lib/model';

async function blame(programPath: string, stlPath: string) {
  const text = readFileSync(programPath, 'utf8');
  const lines = text.split('\n');
  const tp = parseToolpath(text, speedsFor('HAAS'));
  const an = analyseProgram(tp, { jawHeight: DEFAULT_JAW_HEIGHT });
  const full = buildInput(tp, an);
  if (!full) return console.log(`${programPath}: no part size in the header, nothing to compare`);
  const tris = await readModel(new Uint8Array(readFileSync(stlPath)));
  const laid = layModel(tris, full, an.setups);
  if ('mismatch' in laid) return console.log(`${programPath}: the STL (${laid.mismatch.model.map((v) => v.toFixed(1)).join(' × ')}) is not the simulated part (${laid.mismatch.part.map((v) => v.toFixed(1)).join(' × ')})`);
  const size = laid.size;
  const setups = an.setups.filter((s) => s.stock && s.moves);
  const rows = setups.map((s) => {
    const ways = ALL.map((O) => ({ O, ...laid.cutInto(s, O) })).sort((p, q) => score(q) - score(p));
    return { s, app: ways.find((w) => w.O.join() === s.orient.join())!, ways };
  });
  const best = { rows };

  console.log(`\n${programPath}  vs  ${stlPath}`);
  console.log(`finished part ${size.map((v) => v.toFixed(1)).join(' × ')} mm; simulated part and STL overlap ${(laid.overlap * 100).toFixed(1)}%`);
  // Each setup's turn is written from the setup before: a wrong turn early makes every later one
  // wrong too. The first wrong one is the cause; a later one whose own turn is right only follows it.
  let first: number | null = null;
  best.rows.forEach(({ s, app, ways }, n) => {
    const said = (w: { mm3: number; waste: number }) => `cuts ${w.mm3.toFixed(0)} mm³ of the finished part and ${w.waste.toFixed(0)} mm³ of waste`;
    // The program's own instructions (M0 stops), not the tool comments around them.
    const note = tp.setups[s.index].notes.filter((x) => /(?<![A-Z\d])M0?0(?!\d)/i.test(lines[x.line] ?? '')).map((x) => x.text).join(' / ').slice(0, 80) || '(no instructions)';
    const right = ways[0];
    const ties = ways.filter((w) => !worse(w, right)).length;
    let verdict: string;
    if (right.mm3 > 4 * NOISE && right.mm3 > right.waste * 0.25) {
      // No way of lying avoids the finished part: the STL is not what this program makes, or the part sits elsewhere.
      // Every setup after it starts from there, so it counts as the first problem.
      if (first === null) first = s.index;
      verdict = `NO WAY FITS: the app's way ${said(app)}; even the best way ${said(right)}. The STL and the program may not belong together (another revision?), or the part is placed more than 2 mm off: fix nothing from this one alone.`;
    } else if (!worse(app, right)) verdict = `OK: ${said(app)}${ties > 1 ? ` (${ties} ways do as well: the STL cannot tell them apart)` : ''}`;
    else {
      const prev = n > 0 ? best.rows[n - 1] : null;
      const relApp = prev ? mul(s.orient, transpose(prev.s.orient)) : null;
      // Any way the setup before could rightly lie (ties included), turned as the app turns it here, is a right way here.
      const good = (r: (typeof best.rows)[number]) => r.ways.filter((w) => !worse(w, r.ways[0])).map((w) => w.O.join());
      const follows = first !== null && prev && relApp && prev.ways.filter((w) => !worse(w, prev.ways[0])).some((w) => good(best.rows[n]).includes(mul(relApp, w.O).join()));
      if (follows) verdict = `follows setup ${first! + 1}: its own turn is right, it starts from setup ${first! + 1}'s wrong position`;
      else {
        if (first === null) first = s.index;
        // Turned right but placed wrong? Slide the app's way along each machine axis.
        let shift = '';
        for (const k of [0, 1, 2])
          for (const d of [-2, -1, -0.5, 0.5, 1, 2]) {
            const dd: Vec = [0, 0, 0];
            dd[k] = d;
            const m = laid.cutInto(s, s.orient, dd);
            if (!shift && worse(app, m) && !worse(m, right)) shift = ` Or the app's turn, moved ${d > 0 ? '+' : ''}${d} mm in ${'XYZ'[k]}: ${said(m)}.`;
          }
          // Strong: the app's way cuts a real chunk of the part and the other way almost none. Small
        // setups (a chamfer) give small numbers a slightly misplaced part can explain.
        const strong = app.mm3 >= 200 && right.mm3 <= app.mm3 * 0.2;
        verdict = `WRONG (${strong ? 'strong' : 'weak: check by hand'}): ${said(app)}. Turned ${right.O.join(',')} it ${said(right)}.${shift}`;
      }
    }
    console.log(`  setup ${s.index + 1}  [${note}]  (program line ${s.line + 1})`);
    console.log(`    app ${s.orient.join(',')} -> ${verdict}`);
    if (verdict.startsWith('WRONG') || verdict.startsWith('NO WAY')) console.log(`    best ways: ${ways.slice(0, 4).map((w) => `${w.O.join(',')} (${w.mm3.toFixed(0)} / ${w.waste.toFixed(0)})`).join('  ')}`);
  });
  console.log(first === null ? '  => no setup is wrong' : `  => cause: setup ${first + 1}`);
}

const args = process.argv.slice(2);
if (args.length < 2 || args.length % 2) {
  console.log('usage: npm run stl-blame -- <program> <part.stl> [<program> <part.stl> ...]');
  process.exit(1);
}
for (let i = 0; i < args.length; i += 2) await blame(args[i], args[i + 1]);
