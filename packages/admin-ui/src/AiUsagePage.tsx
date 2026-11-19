import { useState } from 'react';
import { formatTHB, mergePrices, summarizeUsage } from '@bestie/core';
import type { UsageRow } from '@bestie/core';
import { errorText, fmt, useI18n } from '@bestie/i18n';
import type { Dict } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useRemote } from './useRemote';

type Loaded = { usd_thb: number; prices: unknown; rows: UsageRow[] };
const tx = (t: Dict, key: string): string => (t as Record<string, string>)[key] ?? key;

/** First and last Bangkok-calendar day of a `YYYY-MM` month. */
export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, '0');
  return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(last).padStart(2, '0')}` };
}
const thisMonth = (): string => {
  const d = new Date(Date.now() + 7 * 3_600_000); // Bangkok
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

/** What AI cost this business this month, per task. The platform admin sees every business, one line per business and task. */
export function AiUsagePage({ ctx }: { ctx: PageContext }) {
  const { t, lang } = useI18n();
  const locale = lang === 'th' ? ('th-TH' as const) : ('en-GB' as const);
  const canSee = ctx.isOwner || ctx.isPlatformAdmin || ctx.permissions.includes('report.view');
  const [month, setMonth] = useState(thisMonth());
  const range = /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? monthRange(month) : monthRange(thisMonth());
  const { status, data, reload } = useRemote(async () => {
    const r = await ctx.client.rpc('ai_usage_summary', {
      p_org: ctx.isPlatformAdmin ? null : ctx.orgId,
      p_from: range.from,
      p_to: range.to,
    });
    if (r.error || !r.data) throw new Error('load');
    return r.data as Loaded;
  }, `${ctx.orgId}:${ctx.isPlatformAdmin}:${range.from}`);

  if (!canSee)
    return (
      <div className="admin-page">
        <Notice kind="error">{errorText('err_forbidden', t)}</Notice>
      </div>
    );
  const body = () => {
    if (status === 'loading')
      return (
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      );
    if (status === 'error' || !data)
      return (
        <>
          <Notice kind="error">{t.err_load_failed}</Notice>
          <AsyncButton variant="secondary" onClick={reload}>
            {t.retry}
          </AsyncButton>
        </>
      );
    const prices = mergePrices(data.prices);
    const sum = summarizeUsage(data.rows, prices, Number(data.usd_thb), ctx.isPlatformAdmin);
    if (sum.lines.length === 0) return <p className="muted">{t.aiUsageEmpty}</p>;
    return (
      <>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{ctx.isPlatformAdmin ? `${t.aiUsageOrg} · ` : ''}AI</th>
                <th>{t.aiUsageCalls}</th>
                <th>{t.aiUsageIn}</th>
                <th>{t.aiUsageOut}</th>
                <th>{t.aiUsageCost}</th>
              </tr>
            </thead>
            <tbody>
              {sum.lines.map((l) => (
                <tr key={l.key}>
                  <td>
                    {ctx.isPlatformAdmin ? `${l.key.split(' · ')[0]} · ` : ''}
                    {tx(t, `aiTask_${l.task}`)}
                  </td>
                  <td className="tabular">{l.calls}</td>
                  <td className="tabular">{l.inputTokens.toLocaleString(locale)}</td>
                  <td className="tabular">{l.outputTokens.toLocaleString(locale)}</td>
                  <td className="tabular">
                    {l.satang === null ? t.aiUsageNoPrice : formatTHB(l.satang, locale)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="guest-total">
          <span>{t.aiUsageTotal}</span>
          <strong className="tabular">{formatTHB(sum.totalSatang, locale)}</strong>
        </p>
        <p className="muted">{fmt(t.aiUsageNote, { rate: Number(data.usd_thb) })}</p>
        <p className="muted">{t.aiUsageCostNote}</p>
      </>
    );
  };

  return (
    <div className="admin-page">
      <h1>{t.aiUsageTitle}</h1>
      <Notice kind="info">{t.aiUsageIntro}</Notice>
      <section className="card admin-card">
        <div className="form-row">
          <label className="label" htmlFor="ai-month">
            {t.aiUsageMonth}
          </label>
          <input
            id="ai-month"
            className="field"
            type="month"
            value={month}
            max={thisMonth()}
            onChange={(e) => e.target.value && setMonth(e.target.value)}
          />
        </div>
        {body()}
      </section>
    </div>
  );
}
