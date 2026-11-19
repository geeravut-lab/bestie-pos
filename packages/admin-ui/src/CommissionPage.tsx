import { useState } from 'react';
import {
  bpsToPct,
  commissionCsv,
  commissionTotals,
  formatTHB,
  parseCommissionRates,
  parseCommissionReport,
  parseTips,
  pctToBps,
  presetRange,
  tipsOwed,
} from '@bestie/core';
import type { RangePreset } from '@bestie/core';
import { errorText, fmt, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useRemote } from './useRemote';

const PRESETS: readonly RangePreset[] = ['today', 'yesterday', 'last7', 'last30', 'month'];
const clock = () => Date.now();
type Person = { id: string; name: string };

/** Commission per person from the paid bills, the rates behind it, and the tips owed to each person. */
export function CommissionPage({ ctx }: { ctx: PageContext }) {
  const { t, lang } = useI18n();
  const locale = lang === 'th' ? ('th-TH' as const) : ('en-GB' as const);
  const money = (n: number) => formatTHB(n, locale);
  const canView = ctx.isOwner || ctx.permissions.includes('report.view');
  const canRates = ctx.isOwner || ctx.permissions.includes('staff.manage');
  const canPay = ctx.isOwner || ctx.permissions.includes('refund.create');
  const [storeId, setStoreId] = useState(ctx.storeId ?? '');
  const [range, setRange] = useState(() => presetRange('month', clock()));
  const [error, setError] = useState<ErrorKey | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [rate, setRate] = useState<{ person: string; service: string; product: string } | null>(
    null,
  );
  const [rateBad, setRateBad] = useState(false);
  const [till, setTill] = useState('');

  const base = useRemote(async () => {
    const [shops, people] = await Promise.all([
      ctx.client
        .from('stores')
        .select('id, name')
        .eq('org_id', ctx.orgId)
        .is('deleted_at', null)
        .order('created_at'),
      ctx.client
        .from('staff')
        .select('id, display_name')
        .eq('org_id', ctx.orgId)
        .eq('active', true)
        .order('display_name'),
    ]);
    if (shops.error) throw new Error('load');
    return {
      shops: ((shops.data ?? []) as { id: string; name: string }[]).filter(
        (s) => typeof s.id === 'string',
      ),
      people: ((people.data ?? []) as { id: string; display_name: string }[]).map((p): Person => ({
        id: p.id,
        name: p.display_name,
      })),
    };
  }, ctx.orgId);

  const data = useRemote(async () => {
    if (!canView) throw new Error('forbidden');
    const [rep, rates, tips, tills] = await Promise.all([
      ctx.client.rpc('commission_report', {
        p: { org_id: ctx.orgId, store_id: storeId || null, from: range.from, to: range.to },
      }),
      storeId
        ? ctx.client
            .from('commission_rates')
            .select('staff_id, service_bps, product_bps')
            .eq('store_id', storeId)
        : Promise.resolve({ data: [], error: null }),
      storeId
        ? ctx.client
            .from('staff_tips')
            .select('id, staff_id, amount, method, status, created_at')
            .eq('store_id', storeId)
            .eq('status', 'owed')
        : Promise.resolve({ data: [], error: null }),
      storeId
        ? ctx.client
            .from('devices')
            .select('id, name')
            .eq('store_id', storeId)
            .eq('active', true)
            .eq('role', 'cashier')
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (rep.error) throw new Error(rep.error.code ?? 'query');
    return {
      rows: parseCommissionReport(rep.data),
      rates: rates.error ? [] : parseCommissionRates(rates.data),
      tips: tips.error ? [] : parseTips(tips.data),
      tills: ((tills.data ?? []) as { id: string; name: string }[]).filter(
        (x) => typeof x.id === 'string',
      ),
    };
  }, `${ctx.orgId}|${storeId}|${range.from}|${range.to}`);

  if (ctx.isModuleOn && !ctx.isModuleOn('commission'))
    return (
      <div className="admin-page">
        <h1>{t.commTitle}</h1>
        <Notice kind="info">{t.commOff}</Notice>
      </div>
    );
  if (!canView)
    return (
      <div className="admin-page">
        <Notice kind="error">{errorText('err_forbidden', t)}</Notice>
      </div>
    );

  const people = base.data?.people ?? [];
  const nameOf = (id: string | null) =>
    id ? (people.find((p) => p.id === id)?.name ?? '—') : t.commDefault;
  const d = data.data;
  const totals = commissionTotals(d?.rows ?? []);
  const owed = tipsOwed(d?.tips ?? []);
  const presetLabel: Record<RangePreset, string> = {
    today: t.repPresetToday,
    yesterday: t.repPresetYesterday,
    last7: t.repPresetLast7,
    last30: t.repPresetLast30,
    month: t.repPresetMonth,
  };

  const exportCsv = async () => {
    if (!d) return;
    setError(null);
    const csv = commissionCsv(d.rows, {
      name: t.commStaff,
      services: t.commServices,
      products: t.commProducts,
      serviceRate: t.commServiceRate,
      productRate: t.commProductRate,
      commission: t.commCommission,
    });
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `commission-${range.from}_${range.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    const { error: err } = await ctx.client.rpc('write_audit', {
      p_org: ctx.orgId,
      p_store: storeId || null,
      p_action: 'export.report',
      p_entity: 'commission_report',
      p_entity_id: null,
      p_detail: { from: range.from, to: range.to },
    });
    if (err) setError('err_load_failed');
  };

  const saveRate = async () => {
    if (!rate || !storeId) return;
    setError(null);
    setRateBad(false);
    const svc = pctToBps(rate.service);
    const prod = pctToBps(rate.product);
    if (svc === null || prod === null) return setRateBad(true);
    const { error: err } = await ctx.client.rpc('set_commission_rate', {
      p: { store_id: storeId, staff_id: rate.person || null, service_bps: svc, product_bps: prod },
    });
    if (err) return setError(err.code === '42501' ? 'err_forbidden' : 'err_save_failed');
    setRate(null);
    setNote(t.commSaved);
    data.reload();
  };
  const payOut = async (staffId: string) => {
    if (!storeId) return;
    setError(null);
    setNote(null);
    if (!till) return setError('err_invalid_input');
    const { error: err } = await ctx.client.rpc('pay_out_tips', {
      p: { store_id: storeId, staff_id: staffId, device_id: till },
    });
    if (err) return setError(err.code === '42501' ? 'err_forbidden' : 'err_save_failed');
    setNote(t.commTipsPaid);
    data.reload();
  };

  return (
    <div className="admin-page">
      <h1>{t.commTitle}</h1>
      <Notice kind="info">{t.commIntro}</Notice>
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      {note ? <Notice kind="success">{note}</Notice> : null}
      <section className="card admin-card">
        <div className="filters">
          {(base.data?.shops.length ?? 0) > 1 ? (
            <div className="form-row">
              <label className="label" htmlFor="com-shop">
                {t.repShop}
              </label>
              <select
                id="com-shop"
                className="field"
                value={storeId}
                onChange={(e) => setStoreId(e.target.value)}
              >
                <option value="">{t.repAllShops}</option>
                {(base.data?.shops ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="chips" role="group">
            {PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                className="chip"
                aria-pressed={
                  range.from === presetRange(p, clock()).from &&
                  range.to === presetRange(p, clock()).to
                }
                onClick={() => setRange(presetRange(p, clock()))}
              >
                {presetLabel[p]}
              </button>
            ))}
          </div>
        </div>
      </section>
      {data.status === 'loading' ? (
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      ) : null}
      {data.status === 'error' ? <Notice kind="error">{t.err_load_failed}</Notice> : null}
      {d ? (
        <section className="card admin-card" aria-labelledby="com-table">
          <h2 id="com-table">{t.commCommission}</h2>
          {d.rows.length === 0 ? <p className="muted">{t.commEmpty}</p> : null}
          {d.rows.length > 0 ? (
            <table className="table">
              <thead>
                <tr>
                  <th>{t.commStaff}</th>
                  <th>{t.commServices}</th>
                  <th>{t.commProducts}</th>
                  <th>{t.commRate}</th>
                  <th>{t.commCommission}</th>
                </tr>
              </thead>
              <tbody>
                {d.rows.map((r) => (
                  <tr key={`${r.storeId}-${r.staffId}`}>
                    <td>{r.name}</td>
                    <td className="tabular">{money(r.serviceSales)}</td>
                    <td className="tabular">{money(r.productSales)}</td>
                    <td className="tabular">
                      {bpsToPct(r.serviceBps)}% / {bpsToPct(r.productBps)}%
                    </td>
                    <td className="tabular">
                      <strong>{money(r.commission)}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th>{t.commTotal}</th>
                  <td className="tabular">{money(totals.serviceSales)}</td>
                  <td className="tabular">{money(totals.productSales)}</td>
                  <td />
                  <td className="tabular">
                    <strong>{money(totals.commission)}</strong>
                  </td>
                </tr>
              </tfoot>
            </table>
          ) : null}
          <div className="actions">
            <AsyncButton variant="secondary" onClick={exportCsv} disabled={d.rows.length === 0}>
              {t.commExport}
            </AsyncButton>
          </div>
        </section>
      ) : null}

      {canRates ? (
        <section className="card admin-card" aria-labelledby="com-rates">
          <h2 id="com-rates">{t.commRatesTitle}</h2>
          {!storeId ? <p className="muted">{t.commRatesPick}</p> : null}
          {storeId && d ? (
            <>
              <ul className="member-list">
                {d.rates.length === 0 ? <li className="muted">{t.commNoRates}</li> : null}
                {d.rates.map((x) => (
                  <li key={x.staffId ?? 'default'} className="member-row">
                    <strong>{nameOf(x.staffId)}</strong> · {t.commServiceRate}{' '}
                    {bpsToPct(x.serviceBps)}% · {t.commProductRate} {bpsToPct(x.productBps)}%
                    <div className="actions">
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() =>
                          setRate({
                            person: x.staffId ?? '',
                            service: bpsToPct(x.serviceBps),
                            product: bpsToPct(x.productBps),
                          })
                        }
                      >
                        {t.stockEdit}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              {rate ? (
                <form
                  className="auth-form"
                  onSubmit={(e) => e.preventDefault()}
                  aria-label={t.commRatesTitle}
                >
                  <div className="form-row">
                    <label className="label" htmlFor="com-person">
                      {t.commPerson}
                    </label>
                    <select
                      id="com-person"
                      className="field"
                      value={rate.person}
                      onChange={(e) => setRate({ ...rate, person: e.target.value })}
                    >
                      <option value="">{t.commDefault}</option>
                      {people.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="filters">
                    <div className="form-row">
                      <label className="label" htmlFor="com-svc">
                        {t.commServiceRate} (%)
                      </label>
                      <input
                        id="com-svc"
                        className="field tabular"
                        inputMode="decimal"
                        value={rate.service}
                        onChange={(e) => setRate({ ...rate, service: e.target.value })}
                      />
                    </div>
                    <div className="form-row">
                      <label className="label" htmlFor="com-prod">
                        {t.commProductRate} (%)
                      </label>
                      <input
                        id="com-prod"
                        className="field tabular"
                        inputMode="decimal"
                        value={rate.product}
                        onChange={(e) => setRate({ ...rate, product: e.target.value })}
                      />
                    </div>
                  </div>
                  {rateBad ? <Notice kind="error">{t.commRateBad}</Notice> : null}
                  <div className="actions">
                    <AsyncButton type="submit" onClick={saveRate}>
                      {t.commSaveRate}
                    </AsyncButton>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setRate(null)}
                    >
                      {t.menuCancel}
                    </button>
                  </div>
                </form>
              ) : (
                <div className="actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => {
                      setRateBad(false);
                      setRate({ person: '', service: '0', product: '0' });
                    }}
                  >
                    {t.commSetRate}
                  </button>
                </div>
              )}
            </>
          ) : null}
        </section>
      ) : null}

      <section className="card admin-card" aria-labelledby="com-tips">
        <h2 id="com-tips">{t.commTipsTitle}</h2>
        {!storeId ? <p className="muted">{t.commRatesPick}</p> : null}
        {storeId && owed.size === 0 && d ? <p className="muted">{t.commTipsNone}</p> : null}
        {storeId && owed.size > 0 ? (
          <>
            {canPay ? (
              <div className="form-row">
                <label className="label" htmlFor="com-till">
                  {t.commTipsTill}
                </label>
                <select
                  id="com-till"
                  className="field"
                  value={till}
                  onChange={(e) => setTill(e.target.value)}
                >
                  <option value="">{t.calNone}</option>
                  {(d?.tills ?? []).map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <ul className="member-list">
              {[...owed.entries()].map(([staffId, amount]) => (
                <li key={staffId} className="member-row">
                  <strong>{nameOf(staffId)}</strong> ·{' '}
                  {fmt(t.commTipsOwed, { amount: money(amount) })}
                  {canPay ? (
                    <div className="actions">
                      <AsyncButton variant="secondary" onClick={() => payOut(staffId)}>
                        {fmt(t.commTipsPay, { amount: money(amount) })}
                      </AsyncButton>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>
    </div>
  );
}
