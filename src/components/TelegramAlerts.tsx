import React, { useEffect, useMemo, useState } from 'react';
import qrcode from 'qrcode-generator';
import { BellRing, ExternalLink, MessageCircle, Phone, PhoneCall, RefreshCw, Send, Unlink, BellOff } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import i18n, { useT } from '../i18n';

type Mode = 'off' | 'message' | 'call';
type Event = 'machineProblem' | 'lockout' | 'safetyOverride';
interface Me {
  name: string;
  tgUsername: string | null;
  lang: 'en' | 'tr';
  modes: Record<Event, Mode>;
  linkedAt: number;
}
interface Status {
  configured: boolean;
  bot: string | null;
  me: Me | null;
  events: Event[];
}

const EVENT_ICON: Record<Event, string> = { machineProblem: '🛠️', lockout: '🔒', safetyOverride: '🛡️' };

function Qr({ text }: { text: string }) {
  const { d, size } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let path = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) path += `M${c + 4} ${r + 4}h1v1h-1z`;
    return { d: path, size: n + 8 };
  }, [text]);
  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="w-36 h-36 rounded-[var(--radius-md)] shrink-0" shapeRendering="crispEdges" role="img" aria-label="QR">
      <rect width={size} height={size} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}

/** Master dashboard: Telegram messages and calls when something happens in a country. */
export default function TelegramAlerts() {
  const { t } = useT('master');
  const [status, setStatus] = useState<Status | null>(null);
  const [link, setLink] = useState<{ url: string; code: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [tgUser, setTgUser] = useState('');

  const load = () =>
    api<Status>('/alerts')
      .then((s) => {
        setStatus(s);
        setTgUser(s.me?.tgUsername ?? '');
      })
      .catch((e) => setError(errorMessage(e, t('common:errors.generic'))));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError('');
    setNote('');
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e, t('common:errors.generic')));
    } finally {
      setBusy(null);
    }
  };

  const save = (patch: Partial<{ modes: Partial<Record<Event, Mode>>; tgUsername: string }>) =>
    run('save', async () => {
      const res = await api<{ me: Me }>('/alerts/me', { method: 'PUT', body: patch });
      setStatus((s) => (s ? { ...s, me: res.me } : s));
      setNote(t('alerts.saved'));
    });

  if (!status) return null;
  const me = status.me;

  return (
    <section className="aurora-card aurora-card-static p-5 space-y-4">
      <div className="flex items-start gap-3">
        <div className="p-2 rounded-[var(--radius-md)] bg-[#2AABEE]/15 border border-[#2AABEE]/30 text-[#2AABEE] shrink-0">
          <Send size={18} />
        </div>
        <div className="min-w-0">
          <h3 className="section-label text-[var(--text-primary)]">{t('alerts.title')}</h3>
          <p className="text-xs text-[var(--text-secondary)] mt-0.5">{t('alerts.subtitle')}</p>
        </div>
      </div>

      {!status.configured && (
        <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] p-4 space-y-2 text-xs text-[var(--text-secondary)]">
          <p className="font-semibold text-[var(--text-primary)]">{t('alerts.setupTitle')}</p>
          <ol className="list-decimal pl-5 space-y-1">
            <li>{t('alerts.setup1')}</li>
            <li>{t('alerts.setup2')}</li>
            <li>{t('alerts.setup3')}</li>
          </ol>
        </div>
      )}

      {status.configured && !me && (
        <div className="space-y-3">
          {!link ? (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => run('link', async () => setLink(await api('/alerts/link', { method: 'POST', body: { lang: i18n.language === 'tr' ? 'tr' : 'en' } })))}
              className="btn-primary text-xs py-2 px-4"
            >
              <Send size={14} />
              <span>{t('alerts.connect')}</span>
            </button>
          ) : (
            <div className="flex flex-col sm:flex-row gap-4 items-start">
              <Qr text={link.url} />
              <div className="space-y-3 text-xs text-[var(--text-secondary)]">
                <p>
                  <b className="text-[var(--text-primary)]">1.</b> {t('alerts.step1')}
                </p>
                <a href={link.url} target="_blank" rel="noreferrer" className="btn-secondary text-xs py-1.5 px-3 inline-flex">
                  <ExternalLink size={13} />
                  <span>{t('alerts.openTelegram', { bot: status.bot })}</span>
                </a>
                <p>
                  <b className="text-[var(--text-primary)]">2.</b> {t('alerts.step2')}
                </p>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() =>
                    run('check', async () => {
                      const res = await api<{ linked: boolean; me?: Me }>('/alerts/link/check', { method: 'POST', body: { code: link.code } });
                      if (res.linked && res.me) {
                        setLink(null);
                        setStatus((s) => (s ? { ...s, me: res.me! } : s));
                        setTgUser(res.me.tgUsername ?? '');
                      } else setNote(t('alerts.notYet'));
                    })
                  }
                  className="btn-primary text-xs py-1.5 px-3"
                >
                  {busy === 'check' ? <RefreshCw size={13} className="animate-spin" /> : <BellRing size={13} />}
                  <span>{t('alerts.pressedStart')}</span>
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {me && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="badge-positive text-xs py-1 px-2.5">✅ {t('alerts.linked', { name: me.name })}</span>
            <button type="button" disabled={busy !== null} onClick={() => run('test', async () => { await api('/alerts/test', { method: 'POST', body: {} }); setNote(t('alerts.testSent')); })} className="btn-secondary text-xs py-1 px-2.5">
              <MessageCircle size={13} />
              <span>{t('alerts.testMessage')}</span>
            </button>
            <button type="button" disabled={busy !== null || !me.tgUsername} onClick={() => run('call', async () => { await api('/alerts/test', { method: 'POST', body: { call: true } }); setNote(t('alerts.callSent')); })} className="btn-secondary text-xs py-1 px-2.5">
              <PhoneCall size={13} />
              <span>{t('alerts.testCall')}</span>
            </button>
            <button type="button" disabled={busy !== null} onClick={() => run('unlink', async () => { await api('/alerts/me', { method: 'DELETE' }); setStatus((s) => (s ? { ...s, me: null } : s)); })} className="btn-secondary text-xs py-1 px-2.5 ml-auto">
              <Unlink size={13} />
              <span>{t('alerts.disconnect')}</span>
            </button>
          </div>

          <div className="space-y-2">
            {status.events.map((e) => (
              <div key={e} className="flex flex-col sm:flex-row sm:items-center gap-2 justify-between rounded-[var(--radius-md)] bg-[rgba(var(--ov),0.03)] px-3 py-2">
                <span className="text-xs text-[var(--text-primary)] font-semibold">
                  <span className="mr-1.5" aria-hidden>{EVENT_ICON[e]}</span>
                  {t(`alerts.event.${e}`)}
                </span>
                <div className="inline-flex rounded-full border border-[var(--border-subtle)] p-0.5 shrink-0" role="radiogroup" aria-label={t(`alerts.event.${e}`)}>
                  {(['off', 'message', 'call'] as Mode[]).map((m) => {
                    const Icon = m === 'off' ? BellOff : m === 'message' ? MessageCircle : Phone;
                    const active = me.modes[e] === m;
                    return (
                      <button
                        key={m}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        disabled={busy !== null || (m === 'call' && !me.tgUsername)}
                        title={m === 'call' && !me.tgUsername ? t('alerts.needUsername') : undefined}
                        onClick={() => save({ modes: { [e]: m } })}
                        className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold transition-colors disabled:opacity-40 ${
                          active ? (m === 'call' ? 'bg-[var(--rose-500)] text-white' : m === 'message' ? 'bg-[#2AABEE] text-white' : 'bg-[rgba(var(--ov),0.12)] text-[var(--text-primary)]') : 'text-[var(--text-secondary)]'
                        }`}
                      >
                        <Icon size={12} />
                        {t(`alerts.mode.${m}`)}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] p-3 space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-[var(--text-primary)]">
              <Phone size={13} /> {t('alerts.callsTitle')}
            </div>
            <p className="text-[11px] text-[var(--text-tertiary)] leading-relaxed">{t('alerts.callsHelp')}</p>
            <form
              className="flex gap-2"
              onSubmit={(ev) => {
                ev.preventDefault();
                save({ tgUsername: tgUser });
              }}
            >
              <input className="aurora-input text-xs flex-1 min-w-0" placeholder="@username" value={tgUser} onChange={(ev) => setTgUser(ev.target.value)} maxLength={33} autoComplete="off" />
              <button type="submit" disabled={busy !== null} className="btn-secondary text-xs py-1.5 px-3">{t('alerts.save')}</button>
            </form>
          </div>
        </div>
      )}

      {note && <div className="badge-positive text-xs py-1.5 px-3">{note}</div>}
      {error && <div className="badge-danger text-xs py-1.5 px-3">{error}</div>}
    </section>
  );
}
