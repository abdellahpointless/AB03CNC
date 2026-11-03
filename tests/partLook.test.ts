import { describe, expect, it } from 'vitest';
import { partLook } from '../src/lib/partLook';

const programs = import.meta.glob('./corpus/*.txt', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

describe('partLook', () => {
  it('reads the material from the program header', () => {
    expect(partLook(programs['./corpus/O0164578.X20.txt'])).toBe('pom');
    expect(partLook(programs['./corpus/O0169538.X20.txt'])).toBe('fh');
    expect(partLook(programs['./corpus/O0107096.X20.txt'])).toBe('alu');
    expect(partLook('%\nO1\n(PLATTE MS 50X20X10)\nG54\n')).toBe('brass');
    expect(partLook('%\nO1\n(BLOCK C45)\n')).toBe('steel');
    expect(partLook('%\nO1\n(TEIL)\nT1 M6\n')).toBe('plain');
  });
});
