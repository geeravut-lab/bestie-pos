import { useState } from 'react';
import { bangkokDate, formatTHB, hqRanges, hqSummary, parseSalesReport } from '@bestie/core';
import type { HqPeriod } from '@bestie/core';
import { fmt, useI18n } from '@bestie/i18n';
import { Spinner } from '@bestie/ui';
import { Notice, useLiveSync } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useRemote } from './useRemote';

const PERIODS: readonly HqPeriod[] = ['today', 'week', 'month'];

/** Head office (several shops of one business): sales of every shop side by side, against the period before, with each shop's share. Read only; needs `report.view`. */
export function HqPage({ ctx }: { ctx: PageContext }) {
  const { t, lang } = useI18n();
  const money = (n: number) => formatTHB(n, lang === 'th' ? 'th-TH' : 'en-GB');
  const canView = ctx.isOwner || ctx.permissions.includes('report.view');
  const [period, setPeriod] = useState<HqPeriod>('today');
  const label: Record<HqPeriod, string> = { today: t.hqToday, week: t.hqWeek, month: t.hqMonth };

  const data = useRemote(async () => {
    if (!canView) throw new Error('forbidden');
    const ranges = hqRanges(period, bangkokDate(Date.now()));
    const [shops, cur, prev] = await Promise.all([
      ctx.client
        .from('stores')
        .select('id, name')
        .eq('org_id', ctx.orgId)
        .is('deleted_at', null)
        .order('created_at'),
      ctx.client.rpc('sales_report', {
        p: { org_id: ctx.orgId, store_id: null, ...ranges.current },
      }),
      ctx.client.rpc('sales_report', {
        p: { org_id: ctx.orgId, store_id: null, ...ranges.previous },
      }),
    ]);
    if (shops.error || cur.error || prev.error) throw new Error('load');
    const current = parseSalesReport(cur.data);
    return {
      summary: hqSummary(
        (shops.data ?? []) as { id: string; name: string }[],
        current,
        parseSalesReport(prev.data),
      ),
      tenders: current.byTender,
      items: current.byItem.slice(0, 5),
    };
  }, `${ctx.orgId}|${period}`);
  const { reload } = data;
  useLiveSync(ctx.client, [`org:${ctx.orgId}`], reload);

  if (!canView)
    return (
      <div className="admin-page">
        <Notice kind="error">{t.repNoAccess}</Notice>
      </div>
    );
  const d = data.data;
  const change = (pct: number | null) =>
    pct === null ? t.hqNoBefore : `${pct > 0 ? '+' : ''}${pct}%`;
  return (
    <div className="admin-page">
      <h1>{t.hqTitle}</h1>
      <Notice kind="info">{t.hqIntro}</Notice>
      <div className="chips" role="group" aria-label={t.hqPeriod}>
        {PERIODS.map((p) => (
          <button
            key={p}
            type="button"
            className="chip"
            aria-pressed={period === p}
            onClick={() => setPeriod(p)}
          >
            {label[p]}
          </button>
        ))}
      </div>
      {data.status === 'loading' ? (
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      ) : null}
      {data.status === 'error' ? <Notice kind="error">{t.err_load_failed}</Notice> : null}
      {d ? (
        <>
          <section className="card admin-card" aria-label={t.hqTotals}>
            <h2>{t.hqTotals}</h2>
            <dl className="preview-list tabular">
              <div>
                <dt>{t.hqSales}</dt>
                <dd>{money(d.summary.totals.payable)}</dd>
              </div>
              <div>
                <dt>{t.hqBills}</dt>
                <dd>{d.summary.totals.bills}</dd>
              </div>
              <div>
                <dt>{t.hqAverage}</dt>
                <dd>{money(d.summary.totals.average)}</dd>
              </div>
              <div>
                <dt>{t.hqVsBefore}</dt>
                <dd>
                  {change(d.summary.totals.changePct)} ({money(d.summary.totals.prevPayable)})
                </dd>
              </div>
            </dl>
            {d.summary.best ? <p>{fmt(t.hqBest, { name: d.summary.best })}</p> : null}
            {d.summary.quiet.length > 0 && d.summary.rows.length > 1 ? (
              <p className="muted">{fmt(t.hqQuiet, { names: d.summary.quiet.join(', ') })}</p>
            ) : null}
          </section>
          <section className="card admin-card" aria-label={t.hqShops}>
            <h2>{t.hqShops}</h2>
            <table className="folio-lines">
              <thead>
                <tr>
                  <th>{t.hqShop}</th>
                  <th>{t.hqSales}</th>
                  <th>{t.hqBills}</th>
                  <th>{t.hqAverage}</th>
                  <th>{t.hqVsBefore}</th>
                  <th>{t.hqShare}</th>
                </tr>
              </thead>
              <tbody>
                {d.summary.rows.map((r) => (
                  <tr key={r.storeId}>
                    <td>{r.name}</td>
                    <td className="tabular">{money(r.payable)}</td>
                    <td className="tabular">{r.bills}</td>
                    <td className="tabular">{money(r.average)}</td>
                    <td className="tabular">{change(r.changePct)}</td>
                    <td>
                      <span
                        className="hq-bar"
                        style={{ width: `${Math.max(2, r.sharePct)}%` }}
                        aria-hidden="true"
                      />{' '}
                      <span className="tabular">{r.sharePct}%</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="card admin-card" aria-label={t.hqPayments}>
            <h2>{t.hqPayments}</h2>
            <ul className="member-list">
              {d.tenders.map((x) => (
                <li key={x.tender}>
                  {(t as Record<string, string>)[`repTender_${x.tender}`] ?? x.tender}:{' '}
                  <span className="tabular">{money(x.amount)}</span>
                </li>
              ))}
              {d.tenders.length === 0 ? <li className="muted">—</li> : null}
            </ul>
          </section>
          <section className="card admin-card" aria-label={t.hqTopItems}>
            <h2>{t.hqTopItems}</h2>
            <ol>
              {d.items.map((i) => (
                <li key={i.nameTh}>
                  {lang === 'th' ? i.nameTh : i.nameEn || i.nameTh} × {i.quantity} ·{' '}
                  <span className="tabular">{money(i.revenue)}</span>
                </li>
              ))}
              {d.items.length === 0 ? <li className="muted">—</li> : null}
            </ol>
          </section>
        </>
      ) : null}
    </div>
  );
}
