import { describe, expect, it } from 'vitest';
import { parseToolpath, speedsFor } from '../src/lib/toolpath';
import { analyseProgram, viseSpans } from '../src/lib/setups';

// Every part is drawn in its clamp, whatever its size and whatever the program writes about it:
// a part longer than one vise (plus what may stick out) goes in two.

const prog = (header: string, notes: string, x: number, y: number, z: number) =>
  `%\nO1\n${header}\nG40 G17 G53 G49 G80 G90\nT2 M6\n(SF_10.00_050_000_ALHS)\n(DIAMETER 10.00 MM / LENGTH 50.00 MM)\n${notes}G54\nG00 G43 H2 Z50.\nS6000 M03\nG00 X${-x / 2}. Y${-y / 2 - 6}.\nG00 Z2.\nG01 Z-${z / 2}. F500.\nG01 X${x / 2}.\nG01 Y${y / 2 + 6}.\nG01 X${-x / 2}.\nG01 Y${-y / 2 - 6}.\nG00 Z50.\nM30\n%`;

const writing = {
  'header and notes': (x: number, y: number, z: number) => prog(`(PART ALU / ${x}X${y}X${z} / ZUSCHNITT:${x + 4}X${y + 4}X${z + 10})`, `M0 (${y + 4} IN Y)\nG52 X-50. Y50. Z0.\n`, x, y, z),
  'header only': (x: number, y: number, z: number) => prog(`(PART ALU / ${x}X${y}X${z} / ZUSCHNITT:${x + 4}X${y + 4}X${z + 10})`, '', x, y, z),
  'notes without sizes': (x: number, y: number, z: number) => prog('(PART ALU)', 'M0 (TEIL EINSPANNEN)\n', x, y, z),
  'nothing written': (x: number, y: number, z: number) => prog('(PART)', '', x, y, z),
};

describe('clamps for every part', () => {
  // One vise up to its 125 mm jaws plus the shop's 50 mm overhang (175 mm); longer: two.
  for (const [x, y, z, vises] of [[4, 4, 4, 1], [100, 60, 30, 1], [170, 80, 30, 1], [180, 80, 30, 2], [260, 100, 40, 2], [420, 120, 40, 2]] as const) {
    for (const [how, make] of Object.entries(writing)) {
      it(`${x}x${y}x${z}, ${how}: held in ${vises} vise(s)`, () => {
        const { setups } = analyseProgram(parseToolpath(make(x, y, z), speedsFor('HAAS')), { jawHeight: 45 });
        expect(setups.length).toBeGreaterThan(0);
        for (const s of setups) {
          expect(s.stock, 'the part is placed').not.toBeNull();
          expect(s.jawTopZ, 'a vise holds it').not.toBeNull();
          expect(viseSpans(s)).toHaveLength(vises);
        }
      });
    }
  }
});
