import { useState } from 'react';
import { bangkokDate, formatTHB, parseDisputes, parseRefunds } from '@bestie/core';
import type { Dispute, RefundRow, Reconciliation } from '@bestie/core';
import { fmt, useI18n } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';

type Answer = {
  available: boolean;
  provider?: string;
  result?: Reconciliation;
  disputes: Dispute[];
  refunds: RefundRow[];
};
const addDays = (d: string, n: number): string => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

/** Compare what Bestie booked through the payment provider with what the provider lists; show disputes and refunds (needs `report.view`; disputes need `refund.create`). */
export function ReconcilePage({ ctx }: { ctx: PageContext }) {
  const { t, lang } = useI18n();
  const money = (n: number) => formatTHB(n, lang === 'th' ? 'th-TH' : 'en-GB');
  const storeId = ctx.storeId ?? ctx.homeStoreId ?? null;
  const canView = ctx.isOwner || ctx.permissions.includes('report.view');
  const [today] = useState(() => bangkokDate(Date.now()));
  const [from, setFrom] = useState(addDays(today, -6));
  const [to, setTo] = useState(today);
  const [ans, setAns] = useState<Answer | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (!canView)
    return (
      <div className="admin-page">
        <Notice kind="error">{t.rcNoAccess}</Notice>
      </div>
    );
  const run = async () => {
    setErr(null);
    setAns(null);
    const { data } = await ctx.client.auth.getSession();
    const token = data.session?.access_token;
    if (!token || !storeId) return setErr(t.err_forbidden);
    const res = await fetch(`/api/payments/reconcile?store=${storeId}&from=${from}&to=${to}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 403) return setErr(t.err_forbidden);
    if (!res.ok) return setErr(t.rcFailed);
    const b = (await res.json()) as {
      available: boolean;
      provider?: string;
      result?: Reconciliation;
      disputes?: unknown;
      refunds?: unknown;
    };
    setAns({
      available: b.available,
      provider: b.provider,
      result: b.result,
      disputes: parseDisputes(b.disputes),
      refunds: parseRefunds(b.refunds),
    });
  };
  const r = ans?.result;
  const clean =
    r &&
    r.missingInBestie.length === 0 &&
    r.missingAtProvider.length === 0 &&
    r.amountDiffers.length === 0 &&
    r.needsReview.length === 0;
  return (
    <div className="admin-page">
      <h1>{t.rcTitle}</h1>
      <Notice kind="info">{t.rcIntro}</Notice>
      {err ? <Notice kind="error">{err}</Notice> : null}
      <form
        className="card admin-card auth-form"
        onSubmit={(e) => e.preventDefault()}
        aria-label={t.rcTitle}
      >
        <div className="form-row">
          <label className="label" htmlFor="rc-from">
            {t.rcFrom}
          </label>
          <input
            id="rc-from"
            className="field"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div className="form-row">
          <label className="label" htmlFor="rc-to">
            {t.rcTo}
          </label>
          <input
            id="rc-to"
            className="field"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        <div className="actions">
          <AsyncButton type="submit" onClick={run}>
            {t.rcRun}
          </AsyncButton>
        </div>
      </form>
      {ans && !ans.available ? <Notice kind="info">{t.rcNoProvider}</Notice> : null}
      {r ? (
        <section className="card admin-card" aria-label={t.rcTitle}>
          <p>
            {fmt(t.rcMatched, { n: r.matched })} ·{' '}
            {fmt(t.rcTotals, { provider: money(r.providerTotal), bestie: money(r.bestieTotal) })}
          </p>
          {clean ? <Notice kind="success">{t.rcAllOk}</Notice> : null}
          {r.missingInBestie.length > 0 ? (
            <>
              <h2>{t.rcMissingBestie}</h2>
              <ul>
                {r.missingInBestie.map((p) => (
                  <li key={p.providerRef}>
                    <span className="mono">{p.providerRef}</span> · {money(p.amount)}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {r.missingAtProvider.length > 0 ? (
            <>
              <h2>{t.rcMissingProvider}</h2>
              <ul>
                {r.missingAtProvider.map((b) => (
                  <li key={b.providerRef}>
                    {b.orderNumber ?? ''} <span className="mono">{b.providerRef}</span> ·{' '}
                    {money(b.amount)}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {r.amountDiffers.length > 0 ? (
            <>
              <h2>{t.rcDiffers}</h2>
              <ul>
                {r.amountDiffers.map((d) => (
                  <li key={d.bestie.providerRef}>
                    {d.bestie.orderNumber ?? ''}{' '}
                    <span className="mono">{d.bestie.providerRef}</span> ·{' '}
                    {fmt(t.rcBestieAmt, { a: money(d.bestie.amount) })} ·{' '}
                    {fmt(t.rcProviderAmt, { a: money(d.provider.amount) })}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {r.needsReview.length > 0 ? (
            <>
              <h2>{t.rcReview}</h2>
              <ul>
                {r.needsReview.map((b) => (
                  <li key={b.providerRef}>
                    {b.orderNumber ?? ''} <span className="mono">{b.providerRef}</span> ·{' '}
                    {money(b.amount)}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
      ) : null}
      {ans ? (
        <>
          <section className="card admin-card" aria-label={t.rcDisputes}>
            <h2>{t.rcDisputes}</h2>
            {ans.disputes.length === 0 ? <p className="muted">{t.rcDisputeNone}</p> : null}
            <ul>
              {ans.disputes.map((d) => (
                <li key={d.disputeRef}>
                  {fmt(t.rcDisputeRow, {
                    amount: money(d.amount),
                    reason: d.reason ?? '—',
                    status: d.status,
                  })}
                </li>
              ))}
            </ul>
          </section>
          <section className="card admin-card" aria-label={t.rcRefunds}>
            <h2>{t.rcRefunds}</h2>
            {ans.refunds.length === 0 ? <p className="muted">{t.rcRefundNone}</p> : null}
            <ul>
              {ans.refunds.map((x) => (
                <li key={x.refundRef}>
                  {x.orderNumber ?? ''} · {money(x.amount)} ·{' '}
                  <span className="mono">{x.refundRef}</span>
                </li>
              ))}
            </ul>
          </section>
        </>
      ) : null}
    </div>
  );
}
