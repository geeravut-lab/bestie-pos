import { useState } from 'react';
import {
  formatTHB,
  parsePackageDeferred,
  parseServicePolicy,
  servicePolicyPayload,
  tipsByPersonMonth,
} from '@bestie/core';
import type { PackageDeferred, ServicePolicy } from '@bestie/core';
import { errorText, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { bangkokToday } from './today';
import { useRemote } from './useRemote';

const guestLabel = (n: { th: string; en?: string }, lang: string): string =>
  lang === 'th' ? n.th : n.en || n.th;

/** The accounting choices of a service shop (owner), the package income received in advance, and the tips per person per month. */
export function AccountingPage({ ctx }: { ctx: PageContext }) {
  const { t, lang } = useI18n();
  const storeId = ctx.storeId ?? ctx.homeStoreId ?? null;
  const canReport = ctx.isOwner || ctx.permissions.includes('report.view');
  const [draft, setDraft] = useState<ServicePolicy | null>(null);
  const [note, setNote] = useState<'saved' | 'failed' | null>(null);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [asOf, setAsOf] = useState(bangkokToday);
  const [report, setReport] = useState<PackageDeferred | null>(null);

  const policy = useRemote<ServicePolicy>(async () => {
    if (!storeId) return parseServicePolicy({});
    const r = await ctx.client.rpc('service_policy', { p_store: storeId });
    if (r.error) throw new Error('load');
    return parseServicePolicy(r.data);
  }, storeId ?? '');
  const tips = useRemote(
    async () => {
      if (!storeId || !canReport) return [];
      const since = new Date(Date.now() - 366 * 86_400_000).toISOString();
      const [tp, st] = await Promise.all([
        ctx.client
          .from('staff_tips')
          .select('staff_id, amount, status, created_at')
          .eq('store_id', storeId)
          .gte('created_at', since),
        ctx.client.from('staff').select('id, display_name').eq('org_id', ctx.orgId),
      ]);
      if (tp.error) throw new Error('load');
      const names = new Map(
        ((st.data ?? []) as { id: string; display_name: string }[]).map((x) => [
          x.id,
          x.display_name,
        ]),
      );
      return tipsByPersonMonth(
        ((tp.data ?? []) as Record<string, unknown>[]).map((r) => ({
          staffId: String(r.staff_id),
          name: names.get(String(r.staff_id)) ?? '—',
          amount: Number(r.amount) || 0,
          status: r.status === 'paid' ? ('paid' as const) : ('owed' as const),
          createdAt: String(r.created_at),
        })),
      );
    },
    `${storeId ?? ''}:${canReport}`,
  );

  if (policy.status === 'loading')
    return (
      <div className="admin-page">
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      </div>
    );
  if (policy.status === 'error' || !policy.data)
    return (
      <div className="admin-page">
        <Notice kind="error">{t.err_load_failed}</Notice>
      </div>
    );
  const p = draft ?? policy.data;
  const save = async () => {
    setError(null);
    setNote(null);
    if (!storeId) return;
    const r = await ctx.client.rpc('save_service_policy', {
      p_store: storeId,
      p: servicePolicyPayload(p),
    });
    if (r.error) {
      if (r.error.code === '42501') return setError('err_forbidden');
      return setNote('failed');
    }
    setNote('saved');
    policy.reload();
  };
  const showReport = async () => {
    setError(null);
    const r = await ctx.client.rpc('package_deferred_report', {
      p: { org_id: ctx.orgId, store_id: storeId, as_of: asOf },
    });
    if (r.error) return setError(r.error.code === '42501' ? 'err_forbidden' : 'err_load_failed');
    setReport(parsePackageDeferred(r.data));
  };

  return (
    <div className="admin-page">
      <h1>{t.accTitle}</h1>
      <Notice kind="info">{t.accIntro}</Notice>
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}

      <section className="card admin-card" aria-label={t.accTitle}>
        {!ctx.isOwner ? <Notice kind="info">{t.accOwnerOnly}</Notice> : null}
        <form className="auth-form" onSubmit={(e) => e.preventDefault()}>
          <fieldset disabled={!ctx.isOwner}>
            <legend>{t.accCommission}</legend>
            <label className="check-row">
              <input
                type="radio"
                name="acc-comm"
                checked={p.commissionBase === 'net'}
                onChange={() => setDraft({ ...p, commissionBase: 'net' })}
              />
              <span>{t.accCommNet}</span>
            </label>
            <label className="check-row">
              <input
                type="radio"
                name="acc-comm"
                checked={p.commissionBase === 'as_sold'}
                onChange={() => setDraft({ ...p, commissionBase: 'as_sold' })}
              />
              <span>{t.accCommAsSold}</span>
            </label>
          </fieldset>
          <fieldset disabled={!ctx.isOwner}>
            <label className="check-row">
              <input
                type="checkbox"
                checked={p.depositInvoice}
                onChange={(e) => setDraft({ ...p, depositInvoice: e.target.checked })}
              />
              <span>{t.accDepositInvoice}</span>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={p.noshowFeeVat}
                onChange={(e) => setDraft({ ...p, noshowFeeVat: e.target.checked })}
              />
              <span>{t.accNoshowVat}</span>
            </label>
          </fieldset>
          <fieldset disabled={!ctx.isOwner}>
            <legend>{t.accPackage}</legend>
            <label className="check-row">
              <input
                type="radio"
                name="acc-pack"
                checked={p.packageRevenue === 'deferred'}
                onChange={() => setDraft({ ...p, packageRevenue: 'deferred' })}
              />
              <span>{t.accPackDeferred}</span>
            </label>
            <label className="check-row">
              <input
                type="radio"
                name="acc-pack"
                checked={p.packageRevenue === 'at_sale'}
                onChange={() => setDraft({ ...p, packageRevenue: 'at_sale' })}
              />
              <span>{t.accPackAtSale}</span>
            </label>
          </fieldset>
          <p className="muted">{t.accVatNote}</p>
          <p className="muted">{t.accTipsNote}</p>
          {note === 'saved' ? <Notice kind="success">{t.accSaved}</Notice> : null}
          {note === 'failed' ? <Notice kind="error">{t.accSaveFailed}</Notice> : null}
          {ctx.isOwner ? (
            <div className="actions">
              <AsyncButton type="submit" onClick={save}>
                {t.accSave}
              </AsyncButton>
            </div>
          ) : null}
        </form>
      </section>

      {canReport ? (
        <section className="card admin-card" aria-label={t.accDeferredTitle}>
          <h2>{t.accDeferredTitle}</h2>
          {p.packageRevenue === 'at_sale' ? <Notice kind="info">{t.accAtSaleNote}</Notice> : null}
          <form className="auth-form" onSubmit={(e) => e.preventDefault()}>
            <div className="form-row">
              <label className="label" htmlFor="acc-asof">
                {t.accAsOf}
              </label>
              <input
                id="acc-asof"
                className="field"
                type="date"
                value={asOf}
                onChange={(e) => setAsOf(e.target.value)}
              />
            </div>
            <div className="actions">
              <AsyncButton type="submit" onClick={showReport}>
                {t.accShow}
              </AsyncButton>
            </div>
          </form>
          {report ? (
            <>
              <dl className="stat-list">
                <div>
                  <dt>{t.accSold}</dt>
                  <dd>{formatTHB(report.sold)}</dd>
                </div>
                <div>
                  <dt>{t.accByVisits}</dt>
                  <dd>{formatTHB(report.releasedByVisits)}</dd>
                </div>
                <div>
                  <dt>{t.accByExpiry}</dt>
                  <dd>{formatTHB(report.releasedByExpiry)}</dd>
                </div>
                <div>
                  <dt>{t.accDeferred}</dt>
                  <dd>
                    <strong>{formatTHB(report.deferred)}</strong>
                  </dd>
                </div>
              </dl>
              {report.rows.length === 0 ? <p className="muted">{t.accNoPackages}</p> : null}
              {report.rows.length > 0 ? (
                <table className="clearing-table">
                  <thead>
                    <tr>
                      <th>{t.accColMember}</th>
                      <th>{t.accColPackage}</th>
                      <th>{t.accColPrice}</th>
                      <th>{t.accColUsed}</th>
                      <th>{t.accColUntil}</th>
                      <th>{t.accColDeferred}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.rows.map((r) => (
                      <tr key={r.id}>
                        <td>{r.member}</td>
                        <td>{guestLabel(r.name, lang)}</td>
                        <td>{formatTHB(r.price)}</td>
                        <td>{formatTHB(r.used)}</td>
                        <td>
                          {r.validUntil ?? '—'}
                          {r.expired ? ` · ${t.accExpired}` : ''}
                        </td>
                        <td>{formatTHB(r.deferred)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </>
          ) : null}
        </section>
      ) : null}

      {canReport ? (
        <section className="card admin-card" aria-label={t.accTipsTitle}>
          <h2>{t.accTipsTitle}</h2>
          <p className="muted">{t.accTipsIntro}</p>
          {tips.status === 'ready' && (tips.data ?? []).length === 0 ? (
            <p className="muted">{t.accNoTips}</p>
          ) : null}
          {tips.status === 'ready' && (tips.data ?? []).length > 0 ? (
            <table className="clearing-table">
              <thead>
                <tr>
                  <th>{t.accColMonth}</th>
                  <th>{t.accColPerson}</th>
                  <th>{t.accColTaken}</th>
                  <th>{t.accColPaid}</th>
                  <th>{t.accColOwed}</th>
                </tr>
              </thead>
              <tbody>
                {(tips.data ?? []).map((r) => (
                  <tr key={`${r.month}-${r.staffId}`}>
                    <td>{r.month}</td>
                    <td>{r.name}</td>
                    <td>{formatTHB(r.taken)}</td>
                    <td>{formatTHB(r.paidOut)}</td>
                    <td>{formatTHB(r.owed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
