import { useEffect, useState } from 'react';
import { parseTourLink, tourLink } from '@bestie/core';
import type { TourSettings } from '@bestie/core';
import { errorText, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton, QrSvg, Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { PrintPortal } from './PrintPortal';
import { useRemote } from './useRemote';

type Loaded = { token: string; settings: TourSettings; enabled: boolean; shop: string };

/** The shop's online tour booking link and its rules (module `tours.online`): show / copy / print the link, make a new one, set notice, days ahead, deposit and hold. */
export function TourLinkPanel({ ctx, storeId }: { ctx: PageContext; storeId: string }) {
  const { t } = useI18n();
  const moduleOn = ctx.isModuleOn ? ctx.isModuleOn('tours.online') : true;
  const [draft, setDraft] = useState<TourSettings | null>(null);
  const [token, setToken] = useState<string | undefined>(undefined);
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
    const [link, shop] = await Promise.all([
      ctx.client.rpc('tour_link', { p_store: storeId }),
      ctx.client.from('stores').select('name').eq('id', storeId).maybeSingle(),
    ]);
    const parsed = link.error ? null : parseTourLink(link.data);
    if (!parsed) throw new Error('load');
    const name = (shop.data as { name?: string } | null)?.name;
    return { ...parsed, shop: typeof name === 'string' ? name : '' };
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
  const current = token ?? data.data.token;
  const link = tourLink(globalThis.location?.origin ?? '', current);

  const save = async () => {
    setError(null);
    setNote(null);
    if (
      s.depositPct < 0 ||
      s.depositPct > 100 ||
      s.holdMin < 15 ||
      s.daysAhead < 1 ||
      s.noticeMin < 0
    )
      return setNote('bad');
    const r = await ctx.client.rpc('save_tour_booking_settings', {
      p: {
        store_id: storeId,
        deposit_pct: s.depositPct,
        hold_min: s.holdMin,
        days_ahead: s.daysAhead,
        notice_min: s.noticeMin,
        pay_note: s.payNote,
      },
    });
    if (r.error) return setError(r.error.code === '42501' ? 'err_forbidden' : 'err_save_failed');
    setNote('saved');
  };
  const rotate = async () => {
    setError(null);
    setNote(null);
    const r = await ctx.client.rpc('rotate_tour_token', { p_store: storeId });
    if (r.error || typeof r.data !== 'string')
      return setError(r.error?.code === '42501' ? 'err_forbidden' : 'err_save_failed');
    setToken(r.data);
    setNote('new');
  };
  const copy = async () => {
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
  ) => (
    <div className="form-row">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="field"
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );

  return (
    <section className="card admin-card" aria-label={t.tolTitle}>
      <h2>{t.tolTitle}</h2>
      <p className="muted">{t.tolIntro}</p>
      {!moduleOn ? <Notice kind="info">{t.tolOff}</Notice> : null}
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      <div className="form-row">
        <label className="label" htmlFor="tol-link">
          {t.bkSetLink}
        </label>
        <input
          id="tol-link"
          className="field"
          readOnly
          value={link}
          onFocus={(e) => e.currentTarget.select()}
        />
        <div className="qr-print booking-qr">
          <QrSvg value={link} label={t.tolTitle} />
          <p className="muted">{t.bkQrHint}</p>
        </div>
        {printing ? (
          <PrintPortal pageCss="@page { size: A5; margin: 10mm; }">
            <div className="booking-poster">
              <h1>{data.data.shop}</h1>
              <h2>{t.tolTitle}</h2>
              <QrSvg value={link} label={t.tolTitle} />
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
          <AsyncButton variant="secondary" onClick={rotate}>
            {t.bkSetNewLink}
          </AsyncButton>
        </div>
      </div>
      <form className="auth-form" onSubmit={(e) => e.preventDefault()}>
        {field('tol-notice', t.tolNoticeLabel, s.noticeMin, (v) =>
          setDraft({ ...s, noticeMin: num(v, 0) }),
        )}
        {field('tol-days', t.bkSetDays, s.daysAhead, (v) =>
          setDraft({ ...s, daysAhead: num(v, 0) }),
        )}
        {field('tol-pct', t.kblDepositPct, s.depositPct, (v) =>
          setDraft({ ...s, depositPct: num(v, 0) }),
        )}
        {field('tol-hold', t.kblHold, s.holdMin, (v) => setDraft({ ...s, holdMin: num(v, 0) }))}
        <div className="form-row">
          <label className="label" htmlFor="tol-pay">
            {t.kblPayNote}
          </label>
          <textarea
            id="tol-pay"
            className="field"
            rows={2}
            maxLength={300}
            value={s.payNote}
            onChange={(e) => setDraft({ ...s, payNote: e.target.value })}
          />
        </div>
        {note === 'bad' ? <Notice kind="error">{t.bkSetBad}</Notice> : null}
        {note === 'saved' ? <Notice kind="success">{t.bkSetSaved}</Notice> : null}
        {note === 'copied' ? <Notice kind="success">{t.bkSetCopied}</Notice> : null}
        {note === 'new' ? <Notice kind="success">{t.bkSetNewLinkDone}</Notice> : null}
        <div className="actions">
          <AsyncButton type="submit" onClick={save}>
            {t.bkSetSave}
          </AsyncButton>
        </div>
      </form>
    </section>
  );
}
