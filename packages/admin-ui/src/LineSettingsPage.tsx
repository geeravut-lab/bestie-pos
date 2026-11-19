import { useState } from 'react';
import { errorText, fmt, formatDateTime, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice, useLiveSync } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { LineDiagnosis } from './LineDiagnosis';
import { useRemote } from './useRemote';

type Usage = {
  cap: number;
  reserve: number;
  halted_until: string | null;
  halted_reason: string | null;
  sent_month: number;
  queued: number;
  failed_month: number;
};
const MAX_CAP = 1_000_000;

/** Platform admin: how many LINE pushes were used this month, the monthly cap, the reserve kept for urgent notices, and the halt. */
export function LineSettingsPage({ ctx }: { ctx: PageContext }) {
  const { t, lang } = useI18n();
  const { status, data, reload } = useRemote(async () => {
    const r = await ctx.client.rpc('notify_usage');
    if (r.error || !r.data) throw new Error('load');
    return r.data as Usage;
  }, 'line-usage');
  useLiveSync(ctx.client, ['platform'], reload);
  const [now] = useState(() => Date.now());
  const [cap, setCap] = useState<string | null>(null);
  const [reserve, setReserve] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<ErrorKey | null>(null);

  if (!ctx.isPlatformAdmin)
    return (
      <div className="admin-page">
        <Notice kind="error">{t.brandAdminOnly}</Notice>
      </div>
    );
  if (status === 'loading')
    return (
      <p className="sso-working" role="status">
        <Spinner /> {t.loading}
      </p>
    );
  if (status === 'error' || !data)
    return (
      <div className="admin-page">
        <Notice kind="error">{t.err_load_failed}</Notice>
        <AsyncButton variant="secondary" onClick={reload}>
          {t.retry}
        </AsyncButton>
      </div>
    );

  const capV = cap ?? String(data.cap);
  const resV = reserve ?? String(data.reserve);
  const capN = /^\d{1,7}$/.test(capV) ? Number(capV) : NaN;
  const resN = /^\d{1,7}$/.test(resV) ? Number(resV) : NaN;
  const valid = Number.isInteger(capN) && Number.isInteger(resN) && capN <= MAX_CAP && resN <= capN;
  const dirty = valid && (capN !== data.cap || resN !== data.reserve);
  const halted = data.halted_until !== null && new Date(data.halted_until).getTime() > now;
  const pct = data.cap > 0 ? Math.min(100, Math.round((data.sent_month / data.cap) * 100)) : 100;

  const write = async (values: Record<string, unknown>) => {
    setError(null);
    setMessage(null);
    const { data: rows, error: err } = await ctx.client
      .from('notification_settings')
      .update(values)
      .eq('id', true)
      .select('id');
    if (err || rows?.length !== 1)
      return setError(err?.code === '42501' ? 'err_forbidden' : 'err_save_failed');
    setCap(null);
    setReserve(null);
    setMessage(t.modulesSaved);
    reload();
  };

  return (
    <div className="admin-page">
      <h1>{t.lineAdminTitle}</h1>
      <Notice kind="info">{t.lineAdminIntro}</Notice>
      <LineDiagnosis ctx={ctx} />
      <section className="card admin-card" aria-labelledby="line-usage">
        <h2 id="line-usage">{t.lineAdminUsage}</h2>
        <p className="guest-total">
          <span>{t.lineAdminSent}</span>
          <strong className="tabular">
            {data.sent_month} / {data.cap}
          </strong>
        </p>
        <div
          className="meter"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label={t.lineAdminSent}
        >
          <span style={{ width: `${pct}%` }} />
        </div>
        <ul className="member-list">
          <li className="member-row">
            {fmt(t.lineAdminQueued, { n: data.queued })} ·{' '}
            {fmt(t.lineAdminFailed, { n: data.failed_month })}
          </li>
        </ul>
        {halted ? (
          <Notice kind="error">
            {fmt(t.lineAdminHalted, {
              until: formatDateTime(lang, data.halted_until!),
              reason: data.halted_reason ?? '',
            })}
            <div className="actions">
              <AsyncButton
                variant="secondary"
                onClick={() => write({ halted_until: null, halted_reason: null })}
                onActionError={setError}
              >
                {t.lineAdminResume}
              </AsyncButton>
            </div>
          </Notice>
        ) : null}
      </section>
      <section className="card admin-card" aria-labelledby="line-cap">
        <h2 id="line-cap">{t.lineAdminCapTitle}</h2>
        <p className="muted">{t.lineAdminCapHint}</p>
        <div className="filters">
          <div className="form-row">
            <label className="label" htmlFor="line-cap-in">
              {t.lineAdminCap}
            </label>
            <input
              id="line-cap-in"
              className="field tabular"
              inputMode="numeric"
              value={capV}
              onChange={(e) => setCap(e.target.value.trim())}
            />
          </div>
          <div className="form-row">
            <label className="label" htmlFor="line-res-in">
              {t.lineAdminReserve}
            </label>
            <input
              id="line-res-in"
              className="field tabular"
              inputMode="numeric"
              value={resV}
              onChange={(e) => setReserve(e.target.value.trim())}
            />
          </div>
        </div>
        {!valid ? <Notice kind="error">{t.lineAdminInvalid}</Notice> : null}
        {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
        {message ? <Notice kind="success">{message}</Notice> : null}
        <div className="actions">
          <AsyncButton
            disabled={!dirty}
            onClick={() => write({ line_monthly_cap: capN, line_reserve: resN })}
            onActionError={setError}
          >
            {t.menuSave}
          </AsyncButton>
        </div>
      </section>
    </div>
  );
}
