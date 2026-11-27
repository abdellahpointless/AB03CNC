import { describe, expect, it } from 'vitest';
import { writtenTurns } from '../src/components/CamAiResult';
import { turnPhrase } from '../src/lib/fixTurns';
import { ALL, IDENTITY, mul, rotation as turn } from '../src/lib/orient';

// A clamping's chip and timeline tick name its turns from the clamping before as the note writes them: every one,
// in the note's order (they do not commute). A quarter turn for a step comes after the flip (finding H2-2).
describe('the turns a note writes, as the labels say them', () => {
  it('names both turns of a flip and a quarter turn, in order', () => {
    expect(writtenTurns(`${turnPhrase(mul(turn('Z', 90), turn('X', 180)))}/28 IN X UND 36 IN Y/Z+ IN 5MM`)).toEqual(['180° X', '90° Z']);
    expect(writtenTurns('TEIL 180 GRAD UM X DREHEN / TEIL 90 GRAD UM Z DREHEN / X+ WIRD Y+/28 IN X UND 36 IN Y')).toEqual(['180° X', '90° Z']);
  });

  it('names one turn as one, none as none', () => {
    expect(writtenTurns(turnPhrase(turn('Y', 180)))).toEqual(['180° Y']);
    expect(writtenTurns(turnPhrase(IDENTITY))).toEqual([]);
    expect(writtenTurns('TEIL MIT 40 IN X UND 32 IN Y EINSPANNEN')).toEqual([]);
  });

  it('reads every turn the program can write', () => {
    for (const m of ALL) {
      const said = writtenTurns(turnPhrase(m));
      expect(said.length, m.join()).toBe(m.join() === IDENTITY.join() ? 0 : turnPhrase(m).split('GRAD').length - 1);
    }
  });
});
