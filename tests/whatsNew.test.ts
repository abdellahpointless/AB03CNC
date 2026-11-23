import { describe, expect, it } from 'vitest';
import { regionById } from '../src/regions';
import { RELEASES, releasesFor } from '../src/lib/whatsNew';
import { CAM_RELEASES } from '../src/lib/cam/news';

describe("what's new", () => {
  it('shows each country only what applies to it', () => {
    const ma = releasesFor('ma', regionById('ma')!.features).map((r) => r.id);
    const tr = releasesFor('tr', regionById('tr')!.features).map((r) => r.id);
    expect(ma).toEqual(RELEASES.map((r) => r.id));
    // Türkiye: no toolpath (locked), no HAAS-2/4 rule, no preventive or cales entries.
    expect(tr).toEqual(['2026-11-23-look', '2026-11-02-news']);
    // Once a master admin unlocks the toolpath for Türkiye, its entry shows there too.
    expect(releasesFor('tr', { ...regionById('tr')!.features, toolpath: true }).map((r) => r.id)).toContain('2026-11-02-toolpath');
    // The private part's news is not in the shared list; it shows only with its flag (the server sets it for its people).
    expect(RELEASES.some((r) => /cam/i.test(r.id) || /CAM AI/.test(JSON.stringify(r)))).toBe(false);
    expect(releasesFor('ma', regionById('ma')!.features, CAM_RELEASES).map((r) => r.id)).not.toContain('2026-11-06-cam-ai');
    const lab = releasesFor('ma', { ...regionById('ma')!.features, lab: true }, CAM_RELEASES);
    expect(lab.map((r) => r.id)).toContain('2026-11-06-cam-ai');
    expect([...lab].sort((a, b) => b.date.localeCompare(a.date)).map((r) => r.id)).toEqual(lab.map((r) => r.id));
  });

  it('has unique ids, newest first, and every entry in both languages', () => {
    expect(new Set(RELEASES.map((r) => r.id)).size).toBe(RELEASES.length);
    expect([...RELEASES].sort((a, b) => b.date.localeCompare(a.date)).map((r) => r.id)).toEqual(RELEASES.map((r) => r.id));
    for (const r of [...RELEASES, ...CAM_RELEASES]) expect(r.tr.items.length).toBe(r.en.items.length);
  });
});
