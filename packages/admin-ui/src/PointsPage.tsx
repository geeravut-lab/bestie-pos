import { parsePointsOverview } from '@bestie/core';
import { fmt, formatDateTime, useI18n } from '@bestie/i18n';
import { Spinner } from '@bestie/ui';
import { Notice, useLiveSync } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useRemote } from './useRemote';

/** The "Points" page: how many Bestie Points customers hold, what was earned and spent this month, the biggest balances and the latest movements. */
export function PointsPage({ ctx }: { ctx: PageContext }) {
  const { t, lang } = useI18n();
  const canView = ctx.isOwner || ctx.permissions.includes('customer.view');
  const data = useRemote(async () => {
    if (!canView) return null;
    const r = await ctx.client.rpc('points_overview', { p_org: ctx.orgId });
    if (r.error) throw new Error('load');
    return parsePointsOverview(r.data);
  }, `${ctx.orgId}:${canView}`);
  const { reload } = data;
  useLiveSync(ctx.client, [`org:${ctx.orgId}`], reload);
  const d = data.data;
  const kind = (k: string) => (t as Record<string, string>)[`custKind_${k}`] ?? k;

  return (
    <div className="admin-page">
      <h1>{t.povTitle}</h1>
      <Notice kind="info">{t.povIntro}</Notice>
      {!canView ? <Notice kind="info">{t.err_forbidden}</Notice> : null}
      {data.status === 'loading' && canView ? (
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      ) : null}
      {data.status === 'error' ? <Notice kind="error">{t.err_load_failed}</Notice> : null}
      {d ? (
        <>
          <section className="card admin-card" aria-label={t.povTitle}>
            <p>
              {t.povOutstanding}: <strong>{d.outstanding.toLocaleString()}</strong> · {t.povMembers}
              : <strong>{d.members}</strong>
            </p>
            <p className="muted">
              {t.povEarned}: {d.earned30d.toLocaleString()} · {t.povRedeemed}:{' '}
              {d.redeemed30d.toLocaleString()}
            </p>
            <p className="muted">{t.povRuleNote}</p>
          </section>
          <section className="card admin-card" aria-label={t.povTop}>
            <h2>{t.povTop}</h2>
            {d.top.length === 0 ? <p className="muted">{t.povNone}</p> : null}
            <ul className="member-list">
              {d.top.map((m) => (
                <li key={m.customerId}>
                  <strong>{m.name}</strong>{' '}
                  <span className="tabular">{m.balance.toLocaleString()}</span>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => ctx.navigate('/customers')}
            >
              {t.povOpenMembers}
            </button>
          </section>
          <section className="card admin-card" aria-label={t.povRecent}>
            <h2>{t.povRecent}</h2>
            <ul className="member-list">
              {d.recent.map((r, i) => (
                <li key={`${r.at}-${i}`}>
                  {kind(r.kind)} · {r.name}{' '}
                  <strong className="tabular">{r.points > 0 ? `+${r.points}` : r.points}</strong>{' '}
                  <span className="muted">{formatDateTime(lang, r.at)}</span>
                </li>
              ))}
            </ul>
            <p className="muted">{fmt(t.povFootnote, { n: d.recent.length })}</p>
          </section>
        </>
      ) : null}
    </div>
  );
}
