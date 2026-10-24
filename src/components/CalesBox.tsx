import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { CheckCheck, CircleDashed, Hammer, Lock, PackageCheck, PackagePlus, Undo2, X } from 'lucide-react';
import { CALE_HEIGHTS, calesSummary, statusOf, type CalesState } from '../lib/cales';
import type { CalesScene, Preview, Rect, Theme } from '../lib/calesScene';
import { confirmCales, reportCales, requestCales, type FleetMachine } from '../lib/fleet';
import { errorMessage } from '../lib/api';
import i18n, { useT } from '../i18n';
import { EASE_OUT, SPRING_POP } from '../lib/motion';

/*
 * The cales box of a machine: a small closed box next to the machine's photo. Pressing it makes the
 * box grow into a large 3D view where the lid opens on the cales (see lib/calesScene). There the
 * person confirms that every pair is there, or picks a pair and reports it missing or damaged.
 * The state is the server's, shared by everyone on the machine; each press is saved there at once.
 *
 * The 3D part (three.js) is loaded only when a machine is opened, and built while nobody is
 * looking (idle time), so pressing the box starts moving at once.
 */

type Pic = { url: string; box: Rect; w: number; h: number };
type Engine = { scene: CalesScene; canvas: HTMLCanvasElement; contents: boolean };
type Events = { pick: (h: number | null) => void; hover: (h: number | null) => void };

/** Pictures of the closed box, kept while the page is open (per machine name and colour mode). */
const pictures = new Map<string, Pic>();
const PIC_W = 520; // drawn larger than shown, so it stays sharp while it grows
const PIC_H = 330;

const docTheme = (): Theme => (document.documentElement.classList.contains('light') ? 'light' : 'dark');
const media = (q: string) => typeof matchMedia !== 'undefined' && matchMedia(q).matches;
const toRect = (r: DOMRect): Rect => ({ x: r.left, y: r.top, w: r.width, h: r.height });

function useDocTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(docTheme);
  useEffect(() => {
    const mo = new MutationObserver(() => setTheme(docTheme()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  }, []);
  return theme;
}

/** Runs `fn` when the browser has nothing else to do (or after `timeout` ms at the latest). */
function whenIdle(fn: () => void, timeout: number): () => void {
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
    cancelIdleCallback?: (id: number) => void;
  };
  if (w.requestIdleCallback) {
    const id = w.requestIdleCallback(fn, { timeout });
    return () => w.cancelIdleCallback?.(id);
  }
  const id = window.setTimeout(fn, Math.min(timeout, 700));
  return () => window.clearTimeout(id);
}

/** "2 pairs missing", "All there"... `checked`: I confirmed the box this shift. */
function useSummaryText(state: CalesState, checked: boolean, canAct: boolean) {
  const { t } = useT('preventive');
  const s = calesSummary(state);
  const tone = s.missing.length ? 'bad' : s.damaged.length ? 'warn' : checked ? 'ok' : 'todo';
  const problems = [
    s.missing.length ? t('cales.nMissing', { count: s.missing.length }) : '',
    s.damaged.length ? t('cales.nDamaged', { count: s.damaged.length }) : '',
  ].filter(Boolean);
  const text = problems.length ? problems.join(' · ') : !canAct ? t('cales.nothingReported') : checked ? t('cales.allThere') : t('cales.notChecked');
  return { tone, text, checked: checked && problems.length ? t('cales.checked') : '' };
}

interface BoxProps {
  machine: FleetMachine;
  canAct: boolean;
  /** Missing / damaged pairs of this box. */
  state: CalesState;
  /** I confirmed this box this shift. */
  checked: boolean;
  /** Heights with new cales asked for. */
  requested: number[];
  /** Something was saved: reload. */
  onChanged: () => Promise<unknown> | void;
}

export default function CalesBox({ machine, canAct, state, checked: checkedByMe, requested, onChanged }: BoxProps) {
  const { t } = useT('preventive');
  const theme = useDocTheme();
  const picKey = `${machine.name}|${theme}|${i18n.language}`;
  const [pic, setPic] = useState<Pic | null>(() => pictures.get(picKey) ?? null);
  const [open, setOpen] = useState(false);
  const thumbRef = useRef<HTMLButtonElement>(null);
  const artRef = useRef<HTMLSpanElement>(null);
  const engine = useRef<Engine | null>(null);
  const pending = useRef<Promise<Engine | null> | null>(null);
  const alive = useRef(true);
  const events = useRef<Events>({ pick: () => {}, hover: () => {} });
  const { tone, text, checked } = useSummaryText(state, checkedByMe, canAct);

  /** The 3D scene, created once (its code is only downloaded now). Null when 3D is not available. */
  const getEngine = useCallback((): Promise<Engine | null> => {
    if (!pending.current) {
      pending.current = import('../lib/calesScene')
        .then(({ CalesScene }) => {
          if (!alive.current) return null;
          const canvas = document.createElement('canvas');
          canvas.className = 'cales-canvas';
          const scene = new CalesScene(canvas, {
            machineName: machine.name,
            label: i18n.t('preventive:cales.title').toLocaleUpperCase(i18n.language),
            theme: docTheme(),
            interactive: true,
            contents: false,
            onPick: (h) => events.current.pick(h),
            onHover: (h) => events.current.hover(h),
          });
          engine.current = { scene, canvas, contents: false };
          return engine.current;
        })
        .catch((err) => {
          console.warn('Cales box: no 3D on this device', err);
          return null;
        });
    }
    return pending.current;
  }, [machine.name]);

  // Get ready quietly once the machine sheet has settled: first the picture, then the cales.
  useEffect(() => {
    alive.current = true;
    let cancelContents = () => {};
    const cancelPicture = whenIdle(async () => {
      const e = await getEngine();
      if (!e || !alive.current) return;
      const key = `${machine.name}|${docTheme()}|${i18n.language}`;
      if (!pictures.has(key)) pictures.set(key, e.scene.snapshot(PIC_W, PIC_H));
      setPic(pictures.get(key)!);
      cancelContents = whenIdle(() => {
        const cur = engine.current;
        if (alive.current && cur && !cur.contents) {
          cur.scene.buildContents();
          cur.scene.warmUp();
          cur.contents = true;
        }
      }, 2500);
    }, 1200);
    return () => {
      alive.current = false;
      cancelPicture();
      cancelContents();
      engine.current?.scene.dispose();
      engine.current = null;
      pending.current = null;
    };
  }, [getEngine, machine.name]);

  // Colour mode changed: new background, new picture.
  useEffect(() => {
    const e = engine.current;
    if (!e) return;
    e.scene.setTheme(theme);
    if (!open) {
      if (!pictures.has(picKey)) pictures.set(picKey, e.scene.snapshot(PIC_W, PIC_H));
      setPic(pictures.get(picKey)!);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);

  const anchor = useCallback(() => artRef.current?.querySelector('img')?.getBoundingClientRect() ?? null, []);

  return (
    <>
      <motion.button
        ref={thumbRef}
        type="button"
        className={`cales-thumb no-glass tone-${tone}`}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('cales.openLabel', { name: machine.name, status: text })}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ ...SPRING_POP, delay: 0.18 }}
      >
        <span ref={artRef} className="cales-thumb-art" style={{ visibility: open ? 'hidden' : undefined }}>
          {pic ? <img src={pic.url} alt="" draggable={false} /> : <span className="cales-thumb-ghost" />}
        </span>
        <span className="cales-thumb-text">
          <span className="cales-thumb-title">{t('cales.title')}</span>
          <span className="cales-thumb-status">
            <i className="cales-dot" />
            {text}
          </span>
        </span>
      </motion.button>
      {open &&
        createPortal(
          <CalesViewer
            machine={machine}
            canAct={canAct}
            state={state}
            checked={checkedByMe}
            requested={requested}
            onChanged={onChanged}
            pic={pic}
            warm={engine.current}
            getEngine={getEngine}
            events={events}
            anchor={anchor}
            tone={tone}
            summary={checked ? `${text} · ${checked}` : text}
            onClosed={() => {
              setOpen(false);
              thumbRef.current?.focus({ preventScroll: true });
            }}
          />,
          document.body,
        )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// The open box
// ---------------------------------------------------------------------------------------------

interface ViewerProps {
  machine: FleetMachine;
  canAct: boolean;
  state: CalesState;
  checked: boolean;
  requested: number[];
  onChanged: BoxProps['onChanged'];
  pic: Pic | null;
  /** The scene if it is already built. */
  warm: Engine | null;
  getEngine: () => Promise<Engine | null>;
  events: React.MutableRefObject<Events>;
  /** Where the small picture is on the page now. */
  anchor: () => DOMRect | null;
  tone: string;
  summary: string;
  onClosed: () => void;
}

const FLY = { type: 'spring', duration: 0.6, bounce: 0 } as const;

function CalesViewer({ machine, canAct, state, checked, requested, onChanged, pic, warm, getEngine, events, anchor, tone, summary, onClosed }: ViewerProps) {
  const { t } = useT('preventive');
  const stageRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const footRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const eng = useRef<Engine | null>(warm);
  const reduce = useMemo(() => media('(prefers-reduced-motion: reduce)'), []);
  const touch = useMemo(() => media('(pointer: coarse)'), []);

  const [ready, setReady] = useState(false); // scene attached and drawing
  const [no3d, setNo3d] = useState(false);
  const [landed, setLanded] = useState(!pic);
  const [stageOn, setStageOn] = useState(false); // the 3D canvas is showing
  const [controls, setControls] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [hoverH, setHoverH] = useState<number | null>(null);
  const [preview, setPreview] = useState<Preview>(null);
  /** How many cales of the picked pair a report is about. */
  const [count, setCount] = useState<1 | 2>(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** The picture of the box flying between the page and the big view. */
  const [fly, setFly] = useState<{ from: Rect | null; to: Rect; opacity: number } | null>(null);
  const trip = useRef<'in' | 'out'>('in');
  const stageOnRef = useRef(false);
  stageOnRef.current = stageOn;
  const closing = useRef(false);

  /** Where the closed box is drawn in the big view (or a good guess before the scene exists). */
  const targetRect = useCallback((): Rect | null => {
    const stage = stageRef.current;
    if (!stage || !pic) return null;
    const s = stage.getBoundingClientRect();
    const e = eng.current;
    if (e && e.canvas.parentElement === stage) {
      const box = e.scene.closedBoxRect();
      const k = box.w / pic.box.w;
      return { x: s.left + box.x - pic.box.x * k, y: s.top + box.y - pic.box.y * k, w: pic.w * k, h: pic.h * k };
    }
    const top = headRef.current?.offsetHeight ?? 0;
    const bottom = footRef.current?.offsetHeight ?? 0;
    const k = Math.min((s.width * 0.86) / pic.w, ((s.height - top - bottom) * 0.86) / pic.h);
    return { x: s.left + (s.width - pic.w * k) / 2, y: s.top + top + (s.height - top - bottom - pic.h * k) / 2, w: pic.w * k, h: pic.h * k };
  }, [pic]);

  /** Puts the canvas in the stage and sizes the scene to it, leaving room for the header and buttons. */
  const attach = useCallback((e: Engine) => {
    const stage = stageRef.current;
    if (!stage) return;
    if (e.canvas.parentElement !== stage) stage.appendChild(e.canvas);
    const s = stage.getBoundingClientRect();
    e.scene.resize(s.width, s.height);
    e.scene.setInsets({ top: headRef.current?.offsetHeight ?? 0, bottom: footRef.current?.offsetHeight ?? 0, left: 0, right: 0 });
  }, []);

  // Opening: the picture leaves the machine page and grows to where the 3D box will be.
  useLayoutEffect(() => {
    const e = eng.current;
    if (e) {
      attach(e);
      e.scene.setSelected(null);
      e.scene.renderStill();
    }
    const to = targetRect();
    if (!to) return;
    const from = anchor();
    setFly(reduce || !from ? { from: null, to, opacity: 1 } : { from: toRect(from), to, opacity: 1 });
    closeRef.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Meanwhile: make sure the scene exists, with its cales, and start drawing.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const e = eng.current ?? (await getEngine());
      if (cancelled) return;
      if (!e) {
        setNo3d(true);
        setControls(true);
        setFly((f) => (f ? { ...f, opacity: 0 } : f));
        return;
      }
      if (!e.contents) {
        e.scene.buildContents();
        e.scene.warmUp();
        e.contents = true;
      }
      eng.current = e;
      attach(e);
      e.scene.setTheme(docTheme());
      e.scene.setStatuses(state, checked);
      e.scene.renderStill(); // one frame of the closed box; drawing starts when it shows (below)
      setReady(true);
      // The picture may have aimed at a guess: aim at where the box really is.
      const to = targetRect();
      if (to) setFly((f) => (f && trip.current === 'in' ? { ...f, to } : f));
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Landed and drawn: swap the picture for the live box, open the lid.
  useEffect(() => {
    if (!ready || !landed || closing.current) return;
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => {
        setStageOn(true);
        setFly((f) => (f ? { ...f, opacity: 0 } : f));
        eng.current?.scene.start();
        eng.current?.scene.open();
        window.setTimeout(() => !closing.current && setControls(true), reduce ? 0 : 380);
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [ready, landed, reduce]);

  // Keep the scene in step.
  useEffect(() => {
    eng.current?.scene.setStatuses(state, checked);
  }, [state, checked, ready]);
  useEffect(() => {
    eng.current?.scene.setSelected(selected);
    setPreview(null);
    setCount(2);
    setError('');
  }, [selected, ready]);
  useEffect(() => {
    eng.current?.scene.setPreview(preview, count);
  }, [preview, count, ready]);

  // Clicks in the 3D view.
  useEffect(() => {
    const ev = events.current;
    ev.pick = (h) => setSelected((cur) => (h === null || cur === h ? null : h));
    ev.hover = (h) => setHoverH(h);
    return () => {
      ev.pick = () => {};
      ev.hover = () => {};
    };
  }, [events]);

  // Follow size changes of the window.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const e = eng.current;
      if (e && e.canvas.parentElement === stage) attach(e);
    });
    ro.observe(stage);
    return () => ro.disconnect();
  }, [attach]);

  const finish = useCallback(() => {
    eng.current?.scene.stop();
    onClosed();
  }, [onClosed]);

  /** The lid closes, then the box shrinks back next to the machine. */
  const close = useCallback(async () => {
    if (closing.current) return;
    closing.current = true;
    setSelected(null);
    setControls(false);
    const e = eng.current;
    if (e && stageOnRef.current) await e.scene.close();
    const from = targetRect();
    const to = anchor();
    trip.current = 'out';
    setStageOn(false);
    setLeaving(true);
    if (pic && from && to && !reduce) setFly({ from, to: toRect(to), opacity: 1 });
    else window.setTimeout(finish, 220);
  }, [anchor, finish, pic, reduce, targetRect]);

  // Escape puts the picked pair back, then closes the box (not the machine sheet behind it).
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.stopImmediatePropagation();
      ev.preventDefault();
      if (selectedRef.current !== null) setSelected(null);
      else void close();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [close]);

  /** Saves on the server and reloads; `after` runs once it is saved. */
  const run = async (fn: () => Promise<unknown>, after: () => void) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await onChanged();
      after();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const mark = (kind: 'MISSING' | 'DAMAGED' | 'FOUND') => {
    const h = selected;
    if (h !== null) void run(() => reportCales(machine.id, h, kind, count), () => setSelected(null)); // back into its place, showing what was reported
  };

  const request = () => {
    const h = selected;
    if (h !== null) void run(() => requestCales(machine.id, h), () => {});
  };

  const confirmAll = () =>
    void run(
      () => confirmCales(machine.id),
      () => {
        setSelected(null);
        eng.current?.scene.celebrate();
      },
    );

  const hoverChip = (h: number | null) => {
    setHoverH(h);
    eng.current?.scene.setHovered(h);
  };

  /** Hovering (or focusing) Missing / Damaged shows what it will look like. */
  const previewOn = (p: Exclude<Preview, null>) => ({
    onPointerEnter: () => setPreview(p),
    onPointerLeave: () => setPreview(null),
    onFocus: () => setPreview(p),
    onBlur: () => setPreview(null),
  });

  const status = selected === null ? null : statusOf(state, selected);
  const pair = selected === null ? undefined : state[selected];
  const flyState = fly && { x: fly.to.x, y: fly.to.y, scale: fly.to.w / (pic?.w || 1), opacity: fly.opacity };

  return (
    <div className="cales-viewer" role="dialog" aria-modal="true" aria-label={`${t('cales.box')}, ${machine.name}`}>
      <motion.div
        className="cales-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: leaving ? 0 : 1 }}
        transition={{ duration: leaving ? 0.32 : 0.25, ease: EASE_OUT }}
        onMouseDown={() => void close()}
      />
      <motion.div
        className="cales-panel"
        initial={{ opacity: 0 }}
        animate={{ opacity: leaving ? 0 : 1 }}
        transition={{ duration: leaving ? 0.3 : 0.28, ease: EASE_OUT }}
      >
        <div ref={stageRef} className={`cales-stage ${stageOn ? 'on' : ''}`}>
          {no3d && <div className="cales-msg">{t('cales.noWebgl')}</div>}
          {!no3d && !stageOn && !pic && !leaving && <div className="cales-msg">{t('cales.loading')}</div>}
        </div>

        <div ref={headRef} className="cales-head">
          <div className="min-w-0">
            <h2 className="cales-title">
              {t('cales.box')} <span>· {machine.name}</span>
            </h2>
            <div className={`cales-summary tone-${tone}`}>
              <i className="cales-dot" />
              {summary}
            </div>
          </div>
          <button ref={closeRef} type="button" className="btn-icon" onClick={() => void close()} aria-label={t('cales.close')}>
            <X size={15} />
          </button>
        </div>

        <motion.div
          ref={footRef}
          className="cales-foot"
          initial={{ opacity: 0, y: 10 }}
          animate={controls ? { opacity: 1, y: 0 } : { opacity: 0, y: 10 }}
          transition={SPRING_POP}
          style={{ pointerEvents: controls ? undefined : 'none' }}
        >
          {error && (
            <div role="alert" className="badge-danger self-center py-1.5 text-xs">
              {error}
            </div>
          )}
          <div className="cales-actions">
            <AnimatePresence mode="popLayout" initial={false}>
              {selected === null || status === null ? (
                <motion.div
                  key="all"
                  className="cales-actions-row"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6, transition: { duration: 0.12 } }}
                  transition={SPRING_POP}
                >
                  {canAct ? (
                    <button type="button" className="btn-success text-sm py-2 px-4" disabled={busy} onClick={confirmAll}>
                      <CheckCheck size={16} />
                      <span>{CALE_HEIGHTS.some((h) => statusOf(state, h) === 'missing') ? t('cales.foundRest') : t('cales.foundAll')}</span>
                    </button>
                  ) : (
                    <span className="badge-warning py-1.5">
                      <Lock size={13} /> {t('cales.viewOnly')}
                    </span>
                  )}
                  <span className="cales-hint">{touch ? t('cales.hintTouch') : t('cales.hint')}</span>
                </motion.div>
              ) : (
                <motion.div
                  key="pair"
                  className="cales-actions-row"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6, transition: { duration: 0.12 } }}
                  transition={SPRING_POP}
                >
                  <span className="cales-pair-title">
                    <b>{t('cales.pair', { h: selected })}</b>
                    <span className={`cales-state s-${status}`}>
                      {t(`cales.state.${status}`)}
                      {pair?.count === 1 && ` · ${t('cales.oneOfTwo')}`}
                    </span>
                  </span>
                  {canAct && (
                    <span className="inline-flex gap-1" role="group" aria-label={t('cales.howMany')}>
                      {([2, 1] as const).map((n) => (
                        <button key={n} type="button" className={`cales-chip no-glass ${count === n ? 'on' : ''}`} aria-pressed={count === n} onClick={() => setCount(n)}>
                          {n === 2 ? t('cales.both') : t('cales.one')}
                        </button>
                      ))}
                    </span>
                  )}
                  {canAct && status === 'missing' && (
                    <button type="button" className="btn-success text-sm py-2 px-4" disabled={busy} onClick={() => mark('FOUND')}>
                      <Undo2 size={15} />
                      <span>{t('cales.foundIt')}</span>
                    </button>
                  )}
                  {canAct && status !== 'missing' && (
                    <button type="button" className="btn-danger text-sm py-2 px-4" disabled={busy} onClick={() => mark('MISSING')} {...previewOn('missing')}>
                      <CircleDashed size={15} />
                      <span>{t('cales.missing')}</span>
                    </button>
                  )}
                  {canAct && status !== 'damaged' && (
                    <button type="button" className="btn-warning text-sm py-2 px-4" disabled={busy} onClick={() => mark('DAMAGED')} {...previewOn('damaged')}>
                      <Hammer size={15} />
                      <span>{t('cales.damaged')}</span>
                    </button>
                  )}
                  {pair && requested.includes(selected) && (
                    <span className="badge-neutral py-1.5">
                      <PackageCheck size={13} /> {t('cales.requested')}
                    </span>
                  )}
                  {pair && canAct && !requested.includes(selected) && (
                    <button type="button" className="btn-secondary text-sm py-2 px-4" disabled={busy} onClick={request}>
                      <PackagePlus size={15} />
                      <span>{t('cales.request', { count: pair.count })}</span>
                    </button>
                  )}
                  <button type="button" className="btn-secondary text-sm py-2 px-4" onClick={() => setSelected(null)}>
                    {t('cales.putBack')}
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <div className="cales-chips" role="group" aria-label={t('cales.heights')}>
            {CALE_HEIGHTS.map((h) => {
              const s = statusOf(state, h);
              const ok = s === 'present' && checked;
              return (
                <button
                  key={h}
                  type="button"
                  className={`cales-chip no-glass s-${s} ${ok ? 'ok' : ''} ${selected === h ? 'on' : ''} ${hoverH === h ? 'hover' : ''}`}
                  aria-pressed={selected === h}
                  aria-label={`${t('cales.pair', { h })}: ${t(`cales.state.${s}`)}`}
                  onClick={() => setSelected(selected === h ? null : h)}
                  onPointerEnter={() => hoverChip(h)}
                  onPointerLeave={() => hoverChip(null)}
                >
                  <span>{h}</span>
                  <i />
                </button>
              );
            })}
          </div>
        </motion.div>
      </motion.div>

      {pic && fly && flyState && (
        <motion.img
          key={trip.current}
          src={pic.url}
          alt=""
          className="cales-fly"
          style={{ width: pic.w, height: pic.h }}
          initial={
            fly.from
              ? { x: fly.from.x, y: fly.from.y, scale: fly.from.w / pic.w, opacity: 1 }
              : { x: fly.to.x, y: fly.to.y, scale: fly.to.w / pic.w, opacity: 0 }
          }
          animate={flyState}
          transition={{ default: reduce ? { duration: 0 } : FLY, opacity: { duration: fly.opacity ? 0.18 : 0.22, ease: EASE_OUT } }}
          onAnimationComplete={() => {
            if (trip.current === 'in') setLanded(true);
            else finish();
          }}
        />
      )}
    </div>
  );
}
