import { useState } from 'react';
import { parsePointsHistory } from '@bestie/core';
import type { CustomerCard } from '@bestie/core';
import { errorText, fmt, formatDateTime, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { ClientRecordPanel } from './ClientRecordPanel';
import { CreditPanel } from './CreditPanel';
import { CryptoPanel } from './CryptoPanel';
import { CustomerPicker } from './CustomerPicker';
import { useRemote } from './useRemote';

/** Members: find or add one, see the Bestie Points balance and history, and (manager) correct points with a reason. */
export function CustomersPage({ ctx }: { ctx: PageContext }) {
  const { t } = useI18n();
  const canView = ctx.isOwner || ctx.permissions.includes('customer.view');
  const [picked, setPicked] = useState<CustomerCard | null>(null);
  if (!canView)
    return (
      <div className="admin-page">
        <Notice kind="error">{t.custNoAccess}</Notice>
      </div>
    );
  return (
    <div className="admin-page">
      <h1>{t.custTitle}</h1>
      <Notice kind="info">{t.custRule}</Notice>
      <section className="card admin-card">
        <CustomerPicker ctx={ctx} onPick={setPicked} />
      </section>
      {picked ? <CustomerDetail key={picked.id} ctx={ctx} card={picked} /> : null}
    </div>
  );
}

function CustomerDetail({ ctx, card }: { ctx: PageContext; card: CustomerCard }) {
  const { t, lang } = useI18n();
  const canAdjust = ctx.isOwner || ctx.permissions.includes('credit.adjust');
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<ErrorKey | null>(null);
  const [bad, setBad] = useState(false);
  const [done, setDone] = useState(false);

  const { status, data, reload } = useRemote(async () => {
    const [hist, bal] = await Promise.all([
      ctx.client
        .from('points_ledger')
        .select('id, kind, points, reason, order_id, created_at')
        .eq('customer_id', card.id)
        .order('created_at', { ascending: false })
        .limit(30),
      ctx.client.rpc('points_balance', { p_customer: card.id }),
    ]);
    if (hist.error || bal.error) throw new Error('load');
    return { history: parsePointsHistory(hist.data), balance: Number(bal.data ?? 0) };
  }, card.id);

  const adjust = async () => {
    setError(null);
    setBad(false);
    setDone(false);
    const n = /^-?\d{1,7}$/.test(delta.trim()) ? Number(delta) : NaN;
    if (!Number.isInteger(n) || n === 0 || reason.trim().length === 0) return setBad(true);
    const { error: err } = await ctx.client.rpc('adjust_points', {
      p_customer: card.id,
      p_points: n,
      p_reason: reason.trim(),
    });
    if (err) {
      if (err.code === '23514' || err.code === '22023') return setBad(true);
      return setError(err.code === '42501' ? 'err_forbidden' : 'err_save_failed');
    }
    setDelta('');
    setReason('');
    setDone(true);
    reload();
  };

  const kindLabel = (k: string) => (t as Record<string, string>)[`custKind_${k}`] ?? k;

  return (
    <section className="card admin-card" aria-label={card.name}>
      <h2>{card.name}</h2>
      <p className="muted">
        {fmt(t.custCode, { code: card.memberCode })}
        {card.phone ? ` · ${card.phone}` : ''}
      </p>
      {status === 'loading' ? (
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      ) : status === 'error' || !data ? (
        <>
          <Notice kind="error">{t.err_load_failed}</Notice>
          <AsyncButton variant="secondary" onClick={reload}>
            {t.retry}
          </AsyncButton>
        </>
      ) : (
        <>
          <p className="guest-total">
            <span>{t.custHistory}</span>
            <strong className="tabular">{fmt(t.custPoints, { n: data.balance })}</strong>
          </p>
          {data.history.length === 0 ? <p className="muted">{t.custHistoryEmpty}</p> : null}
          <ul className="member-list">
            {data.history.map((h) => (
              <li key={h.id} className="member-row">
                <div className="member-head">
                  <span>{kindLabel(h.kind)}</span>
                  <span className="tabular">
                    {h.points > 0 ? '+' : ''}
                    {h.points}
                  </span>
                  <span className="muted">{formatDateTime(lang, h.createdAt)}</span>
                </div>
                {h.reason ? <p className="muted">{h.reason}</p> : null}
              </li>
            ))}
          </ul>
        </>
      )}
      <ClientRecordPanel ctx={ctx} customerId={card.id} />
      <CreditPanel ctx={ctx} card={card} />
      <CryptoPanel ctx={ctx} card={card} />
      {ctx.isOwner || ctx.permissions.includes('credit.adjust') ? (
        <button type="button" className="btn btn-secondary" onClick={() => ctx.navigate('/crypto')}>
          {t.cryOpenPage}
        </button>
      ) : null}
      {canAdjust ? (
        <form className="auth-form" onSubmit={(e) => e.preventDefault()}>
          <h3>{t.custAdjustTitle}</h3>
          <div className="filters">
            <div className="form-row">
              <label className="label" htmlFor="adj-points">
                {t.custAdjustPoints}
              </label>
              <input
                id="adj-points"
                className="field tabular"
                inputMode="numeric"
                value={delta}
                onChange={(e) => setDelta(e.target.value)}
              />
            </div>
            <div className="form-row">
              <label className="label" htmlFor="adj-reason">
                {t.custAdjustReason}
              </label>
              <input
                id="adj-reason"
                className="field"
                value={reason}
                maxLength={200}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
          </div>
          {bad ? <Notice kind="error">{t.custAdjustBad}</Notice> : null}
          {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
          {done ? <Notice kind="success">{t.custAdjusted}</Notice> : null}
          <AsyncButton onClick={adjust}>{t.custAdjustApply}</AsyncButton>
        </form>
      ) : null}
    </section>
  );
}
