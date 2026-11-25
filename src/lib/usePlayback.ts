/*
 * Playing a program through, shared by the simulators: the instant shown (clock, read by the 3D view on every frame),
 * the move shown in the panels (step), the play loop at a multiple of the real speed, and the stop at each setup's
 * first move while the part turns.
 */
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type { Toolpath } from './toolpath';
import { turnMs, type SetupInfo } from './setups';

/** Multiples of the real speed the player offers. */
export const SPEEDS = [5, 10, 50, 250];

/** What the loop asks the page on every frame: wait for the part (details), and whether the 3D view turns the part. */
/** end: the move playback stops before (one tool's run, played alone); none: the program's end. */
export type PlayGate = { wait: () => boolean; mode3d: () => boolean; end?: () => number | null };

export function usePlayback(path: Toolpath, setups: SetupInfo[], gate: MutableRefObject<PlayGate>, initialSpeed = 2) {
  const total = path.moves.length;
  // Open at the start of the program: the raw part, before the first move.
  const clock = useRef(0);
  const [step, setStep] = useState(0);
  const [, setFrame] = useState(0);
  const seek = (n: number) => {
    clock.current = n;
    setStep(n);
  };
  /** While the part turns between setups, the new setup is shown before its first move. */
  const [turning, setTurning] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(initialSpeed);
  // Time at the end of each move, for playing at a multiple of the real speed.
  const timeline = useMemo(() => {
    let s = 0;
    return path.moves.map((m) => (s += m.seconds));
  }, [path]);
  const at = clock.current;
  const atMove = Math.min(Math.floor(at), total - 1);
  const elapsed = total ? (atMove > 0 ? timeline[atMove - 1] : 0) + Math.min(1, at - atMove) * path.moves[atMove].seconds : 0;
  // First move of each setup after the first: playback stops there while the part turns.
  const setupStarts = useMemo(() => setups.slice(1).map((x) => x.moves?.[0] ?? -1).filter((x) => x > 0), [setups]);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const from = clock.current >= total ? 0 : clock.current;
    let k = Math.floor(from);
    let sim = (k > 0 ? timeline[k - 1] : 0) + (from - k) * (path.moves[k]?.seconds ?? 0);
    let shownAt = 0;
    let holdUntil = 0;
    /** First move of the setup the part just turned for (shown as that setup until it starts). */
    let held = -1;
    if (clock.current >= total) seek(0);
    const tick = (now: number) => {
      if (now < holdUntil) {
        last = now;
        raf = requestAnimationFrame(tick);
        return;
      }
      if (holdUntil) holdUntil = 0;
      // Details: the clock waits for the part, so the cut is always shown right where the tool is.
      if (gate.current.wait()) {
        last = now;
        raf = requestAnimationFrame(tick);
        return;
      }
      sim += ((now - last) / 1000) * SPEEDS[speed];
      last = now;
      const before = k;
      const end = Math.min(total, gate.current.end?.() ?? total);
      while (k < end && timeline[k] <= sim) k++;
      // Reaching a new setup: stop before its first move, let the part turn, then go on.
      const start = setupStarts.find((x) => x >= before && x < k && x !== held);
      if (start !== undefined) {
        held = start;
        k = start;
        sim = timeline[start - 1];
        // The 3D view turns the part (and changes the cales); the 2D view just marks the new setup.
        const next = path.moves[start].setup;
        holdUntil = now + (gate.current.mode3d() ? turnMs(setups[next - 1] ?? null, setups[next] ?? null) + 150 : 600);
        setTurning(path.moves[start].setup);
        seek(k);
        raf = requestAnimationFrame(tick);
        return;
      }
      // The tool glides: the share of the move in progress, on every frame.
      // Stopped short of the program's end: just before the next move, so the tool shown is still the one played.
      const pos = k >= end ? (end < total ? end - 1e-3 : end) : k + Math.min(1, Math.max(0, (sim - (k > 0 ? timeline[k - 1] : 0)) / (path.moves[k].seconds || 1)));
      clock.current = pos;
      // The panels (current line, time) at ~15 updates a second: they do not need more.
      if (now - shownAt > 66 || k >= end) {
        shownAt = now;
        setStep(Math.min(total, Math.max(1, Math.ceil(pos))));
        setFrame((f) => f + 1);
        if (held >= 0 && k > held) setTurning(null);
      }
      if (k >= end) setPlaying(false);
      else raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      setTurning(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, speed]);
  return { total, clock, step, setStep, seek, turning, setTurning, playing, setPlaying, speed, setSpeed, timeline, elapsed };
}
