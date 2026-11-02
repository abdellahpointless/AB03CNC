import { carve, holderHits, type SimInput } from './stockSim';
import type { Vec } from './toolpath';

/*
 * The holders against the part, away from the page (it takes about a second on big parts):
 *   { input, paths, reach, dia } -> { hits }  (see holderHits)
 */
self.onmessage = (e: MessageEvent<{ input: SimInput; paths: Vec[][]; reach: (number | null | undefined)[]; dia: (number | null | undefined)[] }>) => {
  const { input, paths, reach, dia } = e.data;
  self.postMessage({ hits: holderHits(input, carve(input), paths, reach, dia) });
};
