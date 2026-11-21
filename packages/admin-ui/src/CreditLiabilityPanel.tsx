import { useState } from 'react';
import {
  creditGroups,
  creditLiabilityCsv,
  formatTHB,
  parseCreditEntities,
  parseCreditLiability,
} from '@bestie/core';
import type { CreditLiabilityRow } from '@bestie/core';
import { errorText, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { bangkokToday } from './today';
import { useRemote } from './useRemote';

/** What each company owes its customers in unspent Credit as of a date (a liability, not revenue), the share topped up with crypto, a CSV for the accountant, and which company's Credit each shop sells. */
export function CreditLiabilityPanel({ ctx }: { ctx: PageContext }) {
  const { t, lang } = useI18n();
  const money = (n: number) => formatTHB(n, lang === 'th' ? 'th-TH' : 'en-GB');
  const [asOf, setAsOf] = useState(bangkokToday);
  const [rows, setRows] = useState<CreditLiabilityRow[] | null>(null);
  const [shownAsOf, setShownAsOf] = useState(asOf);
  const [error, setError] = useState<ErrorKey | null>(null);
  const groups = useRemote(async () => {
    const r = await ctx.client.rpc('credit_entity_check', { p_org: ctx.orgId });
    return r.error ? [] : creditGroups(parseCreditEntities(r.data));
  }, ctx.orgId);

  const show = async () => {
    setError(null);
    const r = await ctx.client.rpc('credit_liability_detail', { p_org: ctx.orgId, p_as_of: asOf });
    if (r.error) return setError(r.error.code === '42501' ? 'err_forbidden' : 'err_load_failed');
    setRows(parseCreditLiability(r.data));
    setShownAsOf(asOf);
  };
  const exportCsv = async () => {
    if (!rows) return;
    setError(null);
    const url = URL.createObjectURL(
      new Blob([creditLiabilityCsv(rows, shownAsOf)], { type: 'text/csv;charset=utf-8' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `credit-liability-${shownAsOf}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    const w = await ctx.client.rpc('write_audit', {
      p_org: ctx.orgId,
      p_store: null,
      p_action: 'export.report',
      p_entity: 'credit_liability',
      p_entity_id: null,
      p_detail: { as_of: shownAsOf },
    });
    if (w.error) setError('err_load_failed');
  };

  return (
    <section className="card admin-card" aria-label={t.repCreditDetail}>
      <h2>{t.repCreditDetail}</h2>
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      <form className="auth-form" onSubmit={(e) => e.preventDefault()}>
        <div className="form-row">
          <label className="label" htmlFor="cl-asof">
            {t.repCreditAsOf}
          </label>
          <input
            id="cl-asof"
            className="field"
            type="date"
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
          />
        </div>
        <div className="actions">
          <AsyncButton type="submit" onClick={show}>
            {t.repCreditShow}
          </AsyncButton>
          {rows ? (
            <AsyncButton variant="secondary" onClick={exportCsv}>
              {t.repCreditExport}
            </AsyncButton>
          ) : null}
        </div>
      </form>
      {rows ? (
        <div className="table-scroll">
          <table className="clearing-table">
            <thead>
              <tr>
                <th>{t.repCreditEntity}</th>
                <th>{t.repCreditCash}</th>
                <th>{t.repCreditPsp}</th>
                <th>{t.repCreditCrypto}</th>
                <th>{t.repCreditSpent}</th>
                <th>{t.repCreditAdjusted}</th>
                <th>{t.repCreditOwed}</th>
                <th>{t.repCreditCustomers}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.entityId}>
                  <td>{r.name}</td>
                  <td>{money(r.cash)}</td>
                  <td>{money(r.psp)}</td>
                  <td>{money(r.crypto)}</td>
                  <td>{money(r.spent)}</td>
                  <td>{money(r.adjusted)}</td>
                  <td>
                    <strong>{money(r.outstanding)}</strong>
                  </td>
                  <td>{r.customers}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {(groups.data ?? []).length > 0 ? (
        <>
          <h3>{t.repCreditEntities}</h3>
          <p className="muted">{t.repCreditOneEntity}</p>
          <ul className="plain-list">
            {(groups.data ?? []).map((g) => (
              <li key={g.entity}>
                <strong>{g.entity}</strong>: {g.shops.join(', ')}
                {!g.taxIdSet ? <Notice kind="info">{t.repCreditNoTax}</Notice> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
