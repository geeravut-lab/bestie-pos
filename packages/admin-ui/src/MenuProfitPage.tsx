import { useState } from 'react';
import { bangkokDate, classifyMenu, formatTHB, guestName, parseProfitReport } from '@bestie/core';
import type { Quadrant } from '@bestie/core';
import { fmt, useI18n } from '@bestie/i18n';
import { Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useRemote } from './useRemote';

const DAYS = [7, 30, 90] as const;
const addDays = (d: string, n: number): string => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

/** Menu engineering: every dish placed by popularity and profit per portion (module-free; needs `report.view`). */
export function MenuProfitPage({ ctx }: { ctx: PageContext }) {
  const { t, lang } = useI18n();
  const money = (n: number) => formatTHB(n, lang === 'th' ? 'th-TH' : 'en-GB');
  const storeId = ctx.storeId ?? ctx.homeStoreId ?? null;
  const canView = ctx.isOwner || ctx.permissions.includes('report.view');
  const [days, setDays] = useState<(typeof DAYS)[number]>(30);
  const label = { 7: t.mp7, 30: t.mp30, 90: t.mp90 } as const;
  const names: Record<Quadrant, string> = {
    star: t.mpStar,
    plowhorse: t.mpPlow,
    puzzle: t.mpPuzzle,
    dog: t.mpDog,
    unknown: t.mpUnknown,
  };
  const hints: Record<Exclude<Quadrant, 'unknown'>, string> = {
    star: t.mpStarHint,
    plowhorse: t.mpPlowHint,
    puzzle: t.mpPuzzleHint,
    dog: t.mpDogHint,
  };

  const data = useRemote(async () => {
    if (!canView || !storeId) throw new Error('forbidden');
    const to = bangkokDate(Date.now());
    const r = await ctx.client.rpc('menu_profit_report', {
      p: { store_id: storeId, from: addDays(to, -(days - 1)), to },
    });
    if (r.error) throw new Error('load');
    return classifyMenu(parseProfitReport(r.data));
  }, `${storeId}|${days}`);

  if (!canView)
    return (
      <div className="admin-page">
        <Notice kind="error">{t.mpNoAccess}</Notice>
      </div>
    );
  const e = data.data;
  return (
    <div className="admin-page">
      <h1>{t.mpTitle}</h1>
      <Notice kind="info">{t.mpIntro}</Notice>
      <div className="chips" role="group" aria-label={t.mpPeriod}>
        {DAYS.map((d) => (
          <button
            key={d}
            type="button"
            className="chip"
            aria-pressed={days === d}
            onClick={() => setDays(d)}
          >
            {label[d]}
          </button>
        ))}
      </div>
      {data.status === 'loading' ? (
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      ) : null}
      {data.status === 'error' ? <Notice kind="error">{t.err_load_failed}</Notice> : null}
      {e && e.rows.length === 0 ? <p className="muted">{t.mpNone}</p> : null}
      {e && e.rows.length > 0 ? (
        <>
          <p className="muted">
            {fmt(t.mpKnown, { pct: Math.round(e.costKnownBps / 100) })} ·{' '}
            {fmt(t.mpAvg, { money: money(e.avgMargin) })}
          </p>
          <ul className="legend">
            {(Object.keys(hints) as (keyof typeof hints)[]).map((q) => (
              <li key={q}>
                <strong>{names[q]}</strong>: {hints[q]}
              </li>
            ))}
          </ul>
          <section className="card admin-card" aria-label={t.mpTitle}>
            <table className="table">
              <thead>
                <tr>
                  {[t.mpItem, t.mpQty, t.mpPrice, t.mpCost, t.mpMargin, t.mpProfit, t.mpGroup].map(
                    (h) => (
                      <th key={h} scope="col">
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {e.rows.map((r) => (
                  <tr key={r.itemId}>
                    <td>{guestName(r.name, lang)}</td>
                    <td className="tabular">{r.qty}</td>
                    <td className="tabular">{money(r.unitPrice)}</td>
                    <td className="tabular">
                      {r.costUnit === null ? t.mpNoCost : money(Math.round(r.costUnit))}
                    </td>
                    <td className="tabular">{r.unitMargin === null ? '—' : money(r.unitMargin)}</td>
                    <td className="tabular">{r.profit === null ? '—' : money(r.profit)}</td>
                    <td>
                      <span className={`badge quad-${r.quadrant}`}>{names[r.quadrant]}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      ) : null}
    </div>
  );
}
