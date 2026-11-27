import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// An effect written as an expression returns its value as the cleanup. Current Chrome's scroll calls return a
// Promise, which React then calls as a function and the whole app unmounts.
describe('effects', () => {
  it('never return a scroll call as their cleanup', () => {
    const files = readdirSync('src', { recursive: true, encoding: 'utf8' }).filter((f) => /\.tsx?$/.test(f));
    const bad = files.flatMap((f) =>
      (readFileSync(join('src', f), 'utf8').match(/use(Layout)?Effect\(\(\) => [^{][^\n]*\.scroll(IntoView|To|By)?\(/g) ?? []).map((m) => `${f}: ${m}`),
    );
    expect(bad).toEqual([]);
  });
});
