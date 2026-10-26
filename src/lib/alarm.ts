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
