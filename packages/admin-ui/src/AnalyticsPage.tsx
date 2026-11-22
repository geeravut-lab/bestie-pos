import { useState } from 'react';
import { fmt, useI18n } from '@bestie/i18n';
import { Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useRemote } from './useRemote';

const obj = (x: unknown): Record<string, unknown> =>
  x && typeof x === 'object' ? (x as Record<string, unknown>) : {};
const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0;

/** Usage analytics for the platform administrator: who is active, which screens are opened, how the platform grows. Counts only, never content. */
export function AnalyticsPage({ ctx }: { ctx: PageContext }) {
  const { t } = useI18n();
  const [days, setDays] = useState(30);
  const data = useRemote(async () => {
    if (!ctx.isPlatformAdmin) return null;
    const r = await ctx.client.rpc('admin_analytics', { p_days: days });
    if (r.error) throw new Error('load');
    const o = obj(r.data);
    return {
      dau: num(o.dau),
      wau: num(o.wau),
      mau: num(o.mau),
      accounts: num(o.accounts),
      businesses: num(o.businesses),
      shops: num(o.shops),
      newBusinesses: num(o.new_businesses_30d),
      bills: num(o.paid_bills_30d),
      billsPrev: num(o.paid_bills_prev_30d),
      retention:
        o.retention_d7 === null || o.retention_d7 === undefined ? null : num(o.retention_d7),
      series: (Array.isArray(o.series) ? o.series : []).map((x) => ({
        day: String(obj(x).day),
        users: num(obj(x).users),
      })),
      pages: (Array.isArray(o.top_pages) ? o.top_pages : []).map((x) => ({
        page: String(obj(x).page),
        users: num(obj(x).users),
      })),
    };
  }, `${ctx.isPlatformAdmin}:${days}`);
  if (!ctx.isPlatformAdmin)
    return (
      <div className="admin-page">
        <Notice kind="error">{t.brandAdminOnly}</Notice>
      </div>
    );
  const d = data.data;
  const max = Math.max(1, ...(d?.series.map((s) => s.users) ?? [1]));
  const pageLabel = (p: string) =>
    (t as Record<string, string>)[`nav${p.charAt(0).toUpperCase()}${p.slice(1)}`] ?? p;
  return (
    <div className="admin-page">
      <h1>{t.anTitle}</h1>
      <Notice kind="info">{t.anIntro}</Notice>
      {data.status === 'loading' ? (
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      ) : null}
      {data.status === 'error' ? <Notice kind="error">{t.err_load_failed}</Notice> : null}
      {d ? (
        <>
          <section className="card admin-card" aria-label={t.anActive}>
            <h2>{t.anActive}</h2>
            <p>
              {t.anDau}: <strong>{d.dau}</strong> · {t.anWau}: <strong>{d.wau}</strong> · {t.anMau}:{' '}
              <strong>{d.mau}</strong>
            </p>
            <p className="muted">
              {t.anRetention}:{' '}
              <strong>{d.retention === null ? t.anNotYet : `${d.retention}%`}</strong>
            </p>
            <div className="chips" role="group" aria-label={t.anRange}>
              {[14, 30, 90].map((n) => (
                <button
                  key={n}
                  type="button"
                  className="chip"
                  aria-pressed={days === n}
                  onClick={() => setDays(n)}
                >
                  {fmt(t.anDays, { n })}
                </button>
              ))}
            </div>
            <div className="analytics-bars" role="img" aria-label={t.anDaily}>
              {d.series.map((s) => (
                <span
                  key={s.day}
                  className="analytics-bar"
                  title={`${s.day}: ${s.users}`}
                  style={{ height: `${Math.max(4, Math.round((100 * s.users) / max))}%` }}
                />
              ))}
            </div>
          </section>
          <section className="card admin-card" aria-label={t.anScreens}>
            <h2>{t.anScreens}</h2>
            {d.pages.length === 0 ? <p className="muted">{t.anNoData}</p> : null}
            <ul className="member-list">
              {d.pages.map((p) => (
                <li key={p.page}>
                  {pageLabel(p.page)} <code>{p.page}</code>{' '}
                  <strong className="tabular">{fmt(t.anPeople, { n: p.users })}</strong>
                </li>
              ))}
            </ul>
          </section>
          <section className="card admin-card" aria-label={t.anGrowth}>
            <h2>{t.anGrowth}</h2>
            <p>
              {t.anAccounts}: <strong>{d.accounts}</strong> · {t.anBusinesses}:{' '}
              <strong>{d.businesses}</strong> ({fmt(t.anNew30, { n: d.newBusinesses })}) ·{' '}
              {t.anShops}: <strong>{d.shops}</strong>
            </p>
            <p>
              {t.anBills}: <strong>{d.bills}</strong> ({fmt(t.anBillsPrev, { n: d.billsPrev })})
            </p>
          </section>
        </>
      ) : null}
    </div>
  );
}
