import { useEffect, useState } from 'react';
import { movePath } from './playback';
import { analyseProgram, readJawHeight, type Collision } from './setups';
import { buildInput, type HolderHit } from './stockSim';
import { parseToolpath, speedsFor } from './toolpath';

/** Coarse enough to take about a second, fine enough to see a holder go a few tenths into the part. */
const CHECK_VOXELS = 1_000_000;

/**
 * Every collision of a program: tools and holders into the vise jaws (at once) and holders into the
 * part (in a worker). `code` empty: nothing to check. `again` changes to check once more (the jaw
 * height may have changed in the viewer).
 */
export function useCollisionCheck(code: string, brand: string | undefined, again: number): { checking: boolean; hits: Collision[] } {
  const [done, setDone] = useState<{ key: string; hits: Collision[] } | null>(null);
  const key = `${again}|${brand}|${code}`;
  useEffect(() => {
    if (!code) return;
    const tp = parseToolpath(code, speedsFor(brand));
    const an = analyseProgram(tp, { jawHeight: readJawHeight() });
    const jaws = an.setups.flatMap((s) => s.collisions);
    const input = buildInput(tp, an);
    if (!input) {
      setDone({ key, hits: jaws });
      return;
    }
    const worker = new Worker(new URL('./holderCheck.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ hits: HolderHit[] }>) => {
      const part: Collision[] = e.data.hits.map((h) => ({ move: h.move, line: tp.moves[h.move].line, tool: h.tool, point: h.point, depth: h.depth, what: 'holderPart' }));
      setDone({ key, hits: [...jaws, ...part] });
      worker.terminate();
    };
    worker.postMessage({ input: { ...input, maxVoxels: CHECK_VOXELS, surfaceMoves: false }, paths: tp.moves.map(movePath), reach: tp.moves.map((m) => m.reach), dia: tp.moves.map((m) => m.dia) });
    return () => worker.terminate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!code) return { checking: false, hits: [] };
  return done?.key === key ? { checking: false, hits: done.hits } : { checking: true, hits: [] };
}
