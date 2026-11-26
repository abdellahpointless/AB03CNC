import { beforeAll, describe, expect, it } from 'vitest';
import { camProgram, editProgram, reorderOps, type CamInput, type CamOp } from '../src/lib/cam/program';
import { plateWithHoles, pocketPart, pocketWithHole, roundedRect } from './heightPart';

// You: the operations of a clamping in the order the operator drags them to (sent as their keys, which a tool changed
// by hand keeps). The program is checked again; an order
// whose cuts are not verified (an operation before the facing, a drill before its spot drill, a mill before the one
// whose material it was made for) stays locked and says why.

// A: 40 x 30 x 12 from a 44 x 34 blank, a Ø3.3 and a Ø5 hole through: facing, outside, spot drill, the two drills.
const input: CamInput = { tris: plateWithHoles(40, 30, 12, [{ c: [8, 8], d: 3.3 }, { c: [32, 22], d: 5 }]), material: 'ALU', tools: [], brand: 'HAAS', raw: [44, 34, 17.5], orient: { side: 'Z+', spin: false }, noNest: true };
// B: 40 x 30 x 12, a 28 x 18 pocket 5 deep with R1.5 corners: facing, the Ø16 roughing, then smaller mills for the rest.
const pocket: CamInput = { ...input, tris: pocketPart(40, 30, 12, roundedRect([6, 6, 34, 24], 1.5), 5), raw: [40, 30, 17.5] };
let made: ReturnType<typeof camProgram>;
let madeB: ReturnType<typeof camProgram>;
beforeAll(() => {
  made = camProgram(input);
  madeB = camProgram(pocket);
}, 900_000);
/** The tool codes of clamping 1 in their made order (one per tool, as the page lists them). */
const codes = () => [...new Set(made.setups[0].ops.map((o) => o.tool.code))];
const byPurpose = (p: string) => made.setups[0].ops.find((o) => o.purpose === p)!.tool.code;
const side = () => made.setups[0].side;
/** The keys of clamping 1's operations of these tools, the tools in this order (each tool's own as made). */
const keysOf = (r: ReturnType<typeof camProgram>, tools: string[]) => tools.flatMap((c) => r.setups[0].ops.filter((o) => o.tool.code === c).map((o) => o.key!));

describe('operations in the order the operator gives', () => {
  it('runs the drills before the outside when dragged there: checked again, every tool change whole, still unlocked', () => {
    const drills = made.setups[0].ops.filter((o) => o.purpose === 'centre' || o.purpose === 'drill').map((o) => o.tool.code);
    const order = [byPurpose('face'), ...drills, byPurpose('outline')];
    expect(codes().slice().sort()).toEqual(order.slice().sort());
    const r = editProgram(input, made, {}, { [side()]: keysOf(made, order) });
    const got = [...new Set(r.setups[0].ops.map((o) => o.tool.code))];
    expect(got).toEqual(order);
    expect(r.setups[0].ops.some((o) => o.cut.unsafe)).toBe(false);
    expect(r.notes.some((n) => n.key === 'orderLocked')).toBe(false);
    expect(r.check.collisions).toBe(0);
    expect(r.check.match).toBeGreaterThanOrEqual(made.check.match - 0.002);
    // The downloaded text in that order: each operation its own tool change (T, M6, G43 H, coolant) and spindle start.
    const names = [...r.code.matchAll(/\(TOOLPATH ([^)]+)\)/g)].map((m) => m[1].split('_')[0]);
    expect(names.slice(0, 5)).toEqual(['PLAN', 'ZENTRIERBOHREN', 'BOHREN', 'BOHREN', 'FRAESEN']);
    const ops = r.setups.reduce((a, s) => a + s.ops.length, 0);
    expect(r.code.match(/T\d+ M6/g)!.length).toBe(ops);
    expect(r.code.match(/G43 H\d+ Z\d+\. M0?8/g)!.length).toBe(ops);
    for (const s of r.setups) for (const o of s.ops) expect(o.lines.find((l) => /S\d+/.test(l)), o.name).toMatch(/M0?3/);
  }, 600_000);

  it('locks an operation moved before the facing, and says which', () => {
    const face = byPurpose('face');
    const other = codes().find((c) => c !== face)!;
    const r = editProgram(input, made, {}, { [side()]: keysOf(made, [other, face]) });
    expect(r.setups[0].ops[0].tool.code).toBe(other);
    expect(r.setups[0].ops[0].cut.unsafe).toBe(true);
    expect(r.notes).toContainEqual(expect.objectContaining({ key: 'orderLocked', setup: 1 }));
  }, 600_000);

  it('locks a drill moved before its spot drill', () => {
    const r = editProgram(input, made, {}, { [side()]: keysOf(made, [byPurpose('drill'), byPurpose('centre')]) });
    const drill = r.setups[0].ops.find((o) => o.purpose === 'drill')!;
    expect(drill.cut.unsafe).toBe(true);
    expect(r.notes.some((n) => n.key === 'orderLocked')).toBe(true);
  }, 600_000);

  it('locks a mill moved before the mill whose material it was made for', () => {
    const mills = madeB.setups[0].ops.filter((o) => o.purpose === 'rough' || o.purpose === 'rest');
    expect(mills.map((o) => o.purpose)).toEqual(['rough', 'rest', 'rest']);
    const firstMill = mills[0].tool.code;
    const later = mills[2].tool.code;
    const r = editProgram(pocket, madeB, {}, { [madeB.setups[0].side]: keysOf(madeB, [later, firstMill]) });
    expect(r.setups[0].ops.find((o) => o.tool.code === later)!.cut.unsafe).toBe(true);
    expect(r.notes.some((n) => n.key === 'orderLocked')).toBe(true);
  }, 600_000);

  it('leaves unlisted operations where they were and ignores keys the program has not', () => {
    const r = editProgram(input, made, {}, { [side()]: ['Z+|NOPE|NOPE_00.00_000_000_X|0'] });
    expect(r.setups[0].ops.map((o) => o.name)).toEqual(made.setups[0].ops.map((o) => o.name));
    expect(r.notes.some((n) => n.key === 'orderLocked')).toBe(false);
  }, 600_000);

  it('moves only what was moved: a tool used in two places stays in both (one run of a tool after the drill)', () => {
    // The face, the Ø16's outline, the drill, the Ø16's roughing, a rest mill: the rest mill dragged before the drill.
    const op = (key: string, code: string, purpose: string) => ({ key, name: key, purpose, tool: { code, number: code.length }, cut: {}, lines: [] }) as unknown as CamOp;
    const ops = [op('face', 'A', 'face'), op('outline', 'B', 'outline'), op('drill', 'C', 'drill'), op('rough', 'B', 'rough'), op('rest', 'D', 'rest')];
    const r = reorderOps(ops, ['face', 'outline', 'rest', 'drill', 'rough'], 1);
    expect(r.ops.map((o) => o.key)).toEqual(['face', 'outline', 'rest', 'drill', 'rough']);
    // The rest mill now runs before the roughing it was made after: locked, said why.
    expect(r.ops.find((o) => o.key === 'rest')!.cut.unsafe).toBe(true);
    expect(r.ops.filter((o) => o.key !== 'rest').some((o) => o.cut.unsafe)).toBe(false);
    expect(r.notes).toContainEqual(expect.objectContaining({ key: 'orderLocked', setup: 1 }));
  });

  it('keeps a tool changed by hand where it was dragged', () => {
    const part: CamInput = { ...input, tris: pocketWithHole(40, 30, 12, [10, 8, 30, 22], 6, { c: [20, 15], d: 4 }), raw: [44, 34, 16.5] };
    const m = camProgram(part);
    const ops = m.setups[0].ops;
    const rest = ops.find((o) => o.purpose === 'rest')!;
    const drill = ops.find((o) => o.purpose === 'drill')!;
    // The rest mill dragged before the drill, then changed by hand to a Ø6.
    const asked = ops.filter((o) => o !== rest).flatMap((o) => (o === drill ? [rest.key!, o.key!] : [o.key!]));
    const r = editProgram(part, m, { [rest.key!]: { tool: { d: 6, l: 40 } } }, { [m.setups[0].side]: asked });
    expect(r.setups[0].ops.map((o) => o.key)).toEqual(asked);
    expect(r.setups[0].ops.find((o) => o.key === rest.key)!.tool.diameter).toBe(6);
  }, 600_000);
});
