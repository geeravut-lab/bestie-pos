import { useEffect, useState } from 'react';
import {
  karaokeBookingLink,
  karaokeBookingSettingsPayload,
  karaokeBookingSettingsProblem,
  parseKaraokeBookingSettings,
} from '@bestie/core';
import type { KaraokeBookingSettings } from '@bestie/core';
import { errorText, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton, QrSvg, Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { PrintPortal } from './PrintPortal';
import { useRemote } from './useRemote';

type Loaded = { token: string | null; settings: KaraokeBookingSettings; shop: string };

/** The karaoke shop's online room booking link, hours and deposit (module `karaoke.booking`): show / copy / print the link, make a new one, set the rules. */
export function KaraokeBookingLinkPanel({ ctx, storeId }: { ctx: PageContext; storeId: string }) {
  const { t } = useI18n();
  const canEdit = ctx.isOwner || ctx.permissions.includes('menu.edit');
  const moduleOn = ctx.isModuleOn ? ctx.isModuleOn('karaoke.booking') : true;
  const [draft, setDraft] = useState<KaraokeBookingSettings | null>(null);
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [note, setNote] = useState<'saved' | 'copied' | 'new' | 'bad' | null>(null);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    if (!printing) return;
    const id = window.setTimeout(() => {
      window.print();
      setPrinting(false);
    }, 60);
    return () => window.clearTimeout(id);
  }, [printing]);
  const data = useRemote<Loaded>(async () => {
    const r = await ctx.client
      .from('stores')
      .select('name, karaoke_booking_token, karaoke_booking_settings')
      .eq('id', storeId)
      .maybeSingle();
    if (r.error) throw new Error('load');
    const row = (r.data ?? {}) as {
      name?: string;
      karaoke_booking_token?: string | null;
      karaoke_booking_settings?: unknown;
    };
    return {
      token: typeof row.karaoke_booking_token === 'string' ? row.karaoke_booking_token : null,
      settings: parseKaraokeBookingSettings(row.karaoke_booking_settings),
      shop: typeof row.name === 'string' ? row.name : '',
    };
  }, storeId);

  if (data.status === 'loading')
    return (
      <p className="sso-working" role="status">
        <Spinner /> {t.loading}
      </p>
    );
  if (data.status === 'error' || !data.data)
    return <Notice kind="error">{t.err_load_failed}</Notice>;
  const s = draft ?? data.data.settings;
  const current = token === undefined ? data.data.token : token;
  const link = current ? karaokeBookingLink(globalThis.location?.origin ?? '', current) : null;

  const save = async (rotate: boolean) => {
    setError(null);
    setNote(null);
    if (karaokeBookingSettingsProblem(s)) return setNote('bad');
    const { data: out, error: err } = await ctx.client.rpc('save_karaoke_booking_settings', {
      p_store: storeId,
      p: { ...karaokeBookingSettingsPayload(s), rotate },
    });
    if (err) {
      if (err.code === '22023') return setNote('bad');
      return setError(err.code === '42501' ? 'err_forbidden' : 'err_save_failed');
    }
    const o = (out ?? {}) as { token?: unknown };
    if (typeof o.token === 'string') setToken(o.token);
    setNote(rotate ? 'new' : 'saved');
  };
  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setNote('copied');
    } catch {
      setNote(null);
    }
  };
  const num = (v: string, fallback: number) =>
    Number.isFinite(Number(v)) && v !== '' ? Math.trunc(Number(v)) : fallback;
  const field = (
    id: string,
    label: string,
    value: string | number,
    onChange: (v: string) => void,
    type = 'text',
  ) => (
    <div className="form-row">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="field"
        type={type}
        inputMode={type === 'text' && typeof value === 'number' ? 'numeric' : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );

  return (
    <section className="card admin-card" aria-label={t.kblTitle}>
      <h2>{t.kblTitle}</h2>
      <p className="muted">{t.kblIntro}</p>
      {!moduleOn ? <Notice kind="info">{t.kblOff}</Notice> : null}
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      {link ? (
        <div className="form-row">
          <label className="label" htmlFor="kbl-link">
            {t.bkSetLink}
          </label>
          <input
            id="kbl-link"
            className="field"
            readOnly
            value={link}
            onFocus={(e) => e.currentTarget.select()}
          />
          <div className="qr-print booking-qr">
            <QrSvg value={link} label={t.kblTitle} />
            <p className="muted">{t.bkQrHint}</p>
          </div>
          {printing ? (
            <PrintPortal pageCss="@page { size: A5; margin: 10mm; }">
              <div className="booking-poster">
                <h1>{data.data.shop}</h1>
                <h2>{t.kblTitle}</h2>
                <QrSvg value={link} label={t.kblTitle} />
                <p className="mono">{link}</p>
              </div>
            </PrintPortal>
          ) : null}
          <div className="actions">
            <AsyncButton variant="secondary" onClick={() => setPrinting(true)}>
              {t.bkQrPrint}
            </AsyncButton>
            <AsyncButton variant="secondary" onClick={copy}>
              {t.bkSetCopy}
            </AsyncButton>
            {canEdit ? (
              <AsyncButton variant="secondary" onClick={() => save(true)}>
                {t.bkSetNewLink}
              </AsyncButton>
            ) : null}
          </div>
        </div>
      ) : null}
      {canEdit ? (
        <form className="auth-form" onSubmit={(e) => e.preventDefault()}>
          {field('kbl-open', t.bkSetOpen, s.open, (v) => setDraft({ ...s, open: v }), 'time')}
          {field('kbl-close', t.kblLastStart, s.close, (v) => setDraft({ ...s, close: v }), 'time')}
          {field('kbl-step', t.bkSetStep, s.stepMin, (v) => setDraft({ ...s, stepMin: num(v, 0) }))}
          {field('kbl-lead', t.bkSetLead, s.leadMin, (v) => setDraft({ ...s, leadMin: num(v, 0) }))}
          {field('kbl-days', t.bkSetDays, s.maxDays, (v) => setDraft({ ...s, maxDays: num(v, 0) }))}
          {field('kbl-pct', t.kblDepositPct, s.depositPct, (v) =>
            setDraft({ ...s, depositPct: num(v, 0) }),
          )}
          {field('kbl-hold', t.kblHold, s.holdMin, (v) => setDraft({ ...s, holdMin: num(v, 0) }))}
          <div className="form-row">
            <label className="label" htmlFor="kbl-pay">
              {t.kblPayNote}
            </label>
            <textarea
              id="kbl-pay"
              className="field"
              rows={2}
              maxLength={200}
              value={s.payNote}
              onChange={(e) => setDraft({ ...s, payNote: e.target.value })}
            />
          </div>
          {note === 'bad' ? <Notice kind="error">{t.bkSetBad}</Notice> : null}
          {note === 'saved' ? <Notice kind="success">{t.bkSetSaved}</Notice> : null}
          {note === 'copied' ? <Notice kind="success">{t.bkSetCopied}</Notice> : null}
          {note === 'new' ? <Notice kind="success">{t.bkSetNewLinkDone}</Notice> : null}
          <div className="actions">
            <AsyncButton type="submit" onClick={() => save(false)}>
              {t.bkSetSave}
            </AsyncButton>
          </div>
        </form>
      ) : null}
    </section>
  );
}
