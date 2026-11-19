import { useState } from 'react';
import {
  bookingLink,
  bookingSettingsPayload,
  bookingSettingsProblem,
  parseBookingSettings,
} from '@bestie/core';
import type { BookingSettings } from '@bestie/core';
import { errorText, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useRemote } from './useRemote';

type Loaded = { token: string | null; settings: BookingSettings };

/** The shop's online booking link and hours (module `booking.online`): show / copy the link, make a new one, set the bookable hours. */
export function BookingLinkPanel({ ctx, storeId }: { ctx: PageContext; storeId: string }) {
  const { t } = useI18n();
  const canEdit = ctx.isOwner || ctx.permissions.includes('menu.edit');
  const moduleOn = ctx.isModuleOn ? ctx.isModuleOn('booking.online') : true;
  const [draft, setDraft] = useState<BookingSettings | null>(null);
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [note, setNote] = useState<'saved' | 'copied' | 'new' | 'bad' | null>(null);
  const [error, setError] = useState<ErrorKey | null>(null);
  const data = useRemote<Loaded>(async () => {
    const r = await ctx.client
      .from('stores')
      .select('booking_token, booking_settings')
      .eq('id', storeId)
      .maybeSingle();
    if (r.error) throw new Error('load');
    const row = (r.data ?? {}) as { booking_token?: string | null; booking_settings?: unknown };
    return {
      token: typeof row.booking_token === 'string' ? row.booking_token : null,
      settings: parseBookingSettings(row.booking_settings),
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
  const link = current ? bookingLink(globalThis.location?.origin ?? '', current) : null;

  const save = async (rotate: boolean) => {
    setError(null);
    setNote(null);
    if (bookingSettingsProblem(s)) return setNote('bad');
    const { data: out, error: err } = await ctx.client.rpc('save_booking_settings', {
      p_store: storeId,
      p: { ...bookingSettingsPayload(s), rotate },
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

  return (
    <section className="card admin-card" aria-label={t.bkSetTitle}>
      <h2>{t.bkSetTitle}</h2>
      <p className="muted">{t.bkSetIntro}</p>
      {!moduleOn ? <Notice kind="info">{t.bkSetOff}</Notice> : null}
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      {link ? (
        <div className="form-row">
          <label className="label" htmlFor="bk-link">
            {t.bkSetLink}
          </label>
          <input
            id="bk-link"
            className="field"
            readOnly
            value={link}
            onFocus={(e) => e.currentTarget.select()}
          />
          <div className="actions">
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
          <div className="form-row">
            <label className="label" htmlFor="bk-open">
              {t.bkSetOpen}
            </label>
            <input
              id="bk-open"
              className="field"
              type="time"
              value={s.open}
              onChange={(e) => setDraft({ ...s, open: e.target.value })}
            />
          </div>
          <div className="form-row">
            <label className="label" htmlFor="bk-close">
              {t.bkSetClose}
            </label>
            <input
              id="bk-close"
              className="field"
              type="time"
              value={s.close}
              onChange={(e) => setDraft({ ...s, close: e.target.value })}
            />
          </div>
          <div className="form-row">
            <label className="label" htmlFor="bk-step">
              {t.bkSetStep}
            </label>
            <input
              id="bk-step"
              className="field"
              inputMode="numeric"
              value={s.stepMin}
              onChange={(e) => setDraft({ ...s, stepMin: num(e.target.value, 0) })}
            />
          </div>
          <div className="form-row">
            <label className="label" htmlFor="bk-lead">
              {t.bkSetLead}
            </label>
            <input
              id="bk-lead"
              className="field"
              inputMode="numeric"
              value={s.leadMin}
              onChange={(e) => setDraft({ ...s, leadMin: num(e.target.value, 0) })}
            />
          </div>
          <div className="form-row">
            <label className="label" htmlFor="bk-days">
              {t.bkSetDays}
            </label>
            <input
              id="bk-days"
              className="field"
              inputMode="numeric"
              value={s.maxDays}
              onChange={(e) => setDraft({ ...s, maxDays: num(e.target.value, 0) })}
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
