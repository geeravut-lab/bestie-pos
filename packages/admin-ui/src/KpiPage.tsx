import { useState } from 'react';
import {
  averageBill,
  bangkokDate,
  changePct,
  formatTHB,
  hqRanges,
  parseKpi,
  splitDuration,
  wasteShareBps,
} from '@bestie/core';
import type { HqPeriod, Kpi } from '@bestie/core';
import { fmt, useI18n } from '@bestie/i18n';
import { Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useRemote } from './useRemote';

const PERIODS: readonly HqPeriod[] = ['today', 'week', 'month'];

/** The shop's KPIs for a period against the one before (needs `report.view`). */
export function KpiPage({ ctx }: { ctx: PageContext }) {
  const { t, lang } = useI18n();
  const money = (n: number) => formatTHB(n, lang === 'th' ? 'th-TH' : 'en-GB');
  const storeId = ctx.storeId ?? ctx.homeStoreId ?? null;
  const canView = ctx.isOwner || ctx.permissions.includes('report.view');
  const [period, setPeriod] = useState<HqPeriod>('week');
  const label: Record<HqPeriod, string> = { today: t.kpToday, week: t.kpWeek, month: t.kpMonth };

  const data = useRemote(async () => {
    if (!canView || !storeId) throw new Error('forbidden');
    const ranges = hqRanges(period, bangkokDate(Date.now()));
    const [cur, prev] = await Promise.all([
      ctx.client.rpc('kpi_report', { p: { store_id: storeId, ...ranges.current } }),
      ctx.client.rpc('kpi_report', { p: { store_id: storeId, ...ranges.previous } }),
    ]);
    if (cur.error || prev.error) throw new Error('load');
    return { cur: parseKpi(cur.data), prev: parseKpi(prev.data) };
  }, `${storeId}|${period}`);

  if (!canView)
    return (
      <div className="admin-page">
        <Notice kind="error">{t.mpNoAccess}</Notice>
      </div>
    );
  const dur = (sec: number | null): string => {
    if (sec === null) return t.kpNoData;
    const d = splitDuration(sec);
    if (d.h > 0) return fmt(t.kpHour, { h: d.h, m: d.m });
    if (d.m > 0) return fmt(t.kpMin, { m: d.m, s: d.s });
    return fmt(t.kpSec, { s: d.s });
  };
  const pct = (bps: number | null): string =>
    bps === null ? t.kpNoData : `${Math.round(bps / 10) / 10}%`;
  const cards = (k: Kpi): { id: string; title: string; value: string }[] => [
    { id: 'bills', title: t.kpBills, value: String(k.bills) },
    { id: 'sales', title: t.kpSales, value: money(k.sales) },
    {
      id: 'avg',
      title: t.kpAvg,
      value: averageBill(k) === null ? t.kpNoData : money(averageBill(k)!),
    },
    { id: 'kitchen', title: t.kpToKitchen, value: dur(k.orderToKitchenSec) },
    { id: 'prep', title: t.kpPrep, value: dur(k.prepSec) },
    { id: 'waste', title: t.kpWaste, value: money(k.wasteCost) },
    { id: 'wasteShare', title: t.kpWasteShare, value: pct(wasteShareBps(k)) },
    { id: 'stockouts', title: t.kpStockouts, value: String(k.stockouts) },
    { id: 'noshow', title: t.kpNoShow, value: pct(k.noShowRateBps) },
    { id: 'repeat', title: t.kpRepeat, value: pct(k.repeatRateBps) },
    { id: 'resolve', title: t.kpResolve, value: dur(k.feedbackResolutionSec) },
  ];
  const d = data.data;
  const before = d ? cards(d.prev) : [];
  const change = (id: string): string | null => {
    if (!d) return null;
    const pairs: Record<string, [number | null, number | null]> = {
      bills: [d.cur.bills, d.prev.bills],
      sales: [d.cur.sales, d.prev.sales],
      avg: [averageBill(d.cur), averageBill(d.prev)],
    };
    const p = pairs[id];
    const c = p ? changePct(p[0], p[1]) : null;
    return c === null ? null : `${c > 0 ? '+' : ''}${c}%`;
  };
  return (
    <div className="admin-page">
      <h1>{t.kpTitle}</h1>
      <Notice kind="info">{t.kpIntro}</Notice>
      <div className="chips" role="group" aria-label={t.mpPeriod}>
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
        <ul className="member-list">
          {cards(d.cur).map((c, i) => (
            <li key={c.id} className="card admin-card">
              <h2>{c.title}</h2>
              <p className="kpi-value">
                <strong className="tabular">{c.value}</strong>{' '}
                {change(c.id) ? <span className="badge">{change(c.id)}</span> : null}
              </p>
              <p className="muted">{fmt(t.kpBefore, { value: before[i]!.value })}</p>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="muted">{t.kpNote}</p>
    </div>
  );
}
