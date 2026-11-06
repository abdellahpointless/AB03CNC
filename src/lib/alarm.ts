/*
 * The end-of-shift ringing, made with the Web Audio API (no sound file). Browsers only let a page
 * make sound after the person clicked on it, so unlockSound() runs on the first click.
 * shortcut: a PC whose page was reloaded and never clicked since stays silent (the notification
 * still shows); a kiosk browser flag (autoplay allowed) would make it ring anyway.
 */

let ctx: AudioContext | null = null;

export function unlockSound(): void {
  try {
    ctx ??= new AudioContext();
    void ctx.resume();
  } catch {
    /* no sound on this device */
  }
}

/** One ring, like a desk phone: two short trills. */
export function ring(): void {
  if (!ctx || ctx.state !== 'running') return unlockSound();
  const out = ctx.createGain();
  out.gain.value = 0.18;
  out.connect(ctx.destination);
  const t0 = ctx.currentTime;
  for (const start of [0, 0.6])
    for (let i = 0; i < 10; i++) {
      const o = ctx.createOscillator();
      o.frequency.value = i % 2 ? 1180 : 920;
      o.connect(out);
      o.start(t0 + start + i * 0.04);
      o.stop(t0 + start + i * 0.04 + 0.035);
    }
}

/** Found: two rising notes, soft (the right turns of a program were found). */
export function chime(): void {
  if (!ctx || ctx.state !== 'running') return unlockSound();
  const t0 = ctx.currentTime;
  [880, 1318.5].forEach((f, i) => {
    const o = ctx!.createOscillator();
    const g = ctx!.createGain();
    o.type = 'sine';
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t0 + i * 0.16);
    g.gain.exponentialRampToValueAtTime(0.2, t0 + i * 0.16 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.16 + 0.6);
    o.connect(g).connect(ctx!.destination);
    o.start(t0 + i * 0.16);
    o.stop(t0 + i * 0.16 + 0.62);
  });
}
