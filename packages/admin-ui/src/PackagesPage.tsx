import { useState } from 'react';
import {
  formatTHB,
  localizedName,
  packageState,
  parseCustomerPackages,
  parsePriceInput,
  parseServicePackages,
  priceInputValue,
  visitValue,
} from '@bestie/core';
import type { CustomerCard, ServicePackage } from '@bestie/core';
import { errorText, fmt, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { CustomerPicker } from './CustomerPicker';
import { tx } from './stockInput';
import { bangkokToday } from './today';
import { useRemote } from './useRemote';

type Form = {
  id: string | null;
  th: string;
  en: string;
  price: string;
  visits: string;
  days: string;
  active: boolean;
};

/** The packages a shop sells ("10 visits"), selling one to a member (on a bill the till pays), and what a member still has. */
export function PackagesPage({ ctx }: { ctx: PageContext }) {
  const { t, lang } = useI18n();
  const locale = lang === 'th' ? ('th-TH' as const) : ('en-GB' as const);
  const money = (n: number) => formatTHB(n, locale);
  const storeId = ctx.storeId ?? ctx.homeStoreId ?? null;
  const canEdit = ctx.isOwner || ctx.permissions.includes('menu.edit');
  const canSell = ctx.isOwner || ctx.permissions.includes('order.create');
  const [form, setForm] = useState<Form | null>(null);
  const [bad, setBad] = useState(false);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [member, setMember] = useState<CustomerCard | null>(null);
  const [sellId, setSellId] = useState('');
  const today = bangkokToday();

  const data = useRemote<ServicePackage[]>(async () => {
    if (!storeId) throw new Error('shop');
    const r = await ctx.client
      .from('service_packages')
      .select('id, name, price, visits, valid_days, active')
      .eq('store_id', storeId)
      .is('deleted_at', null)
      .order('sort');
    if (r.error) throw new Error('load');
    return parseServicePackages(r.data);
  }, storeId ?? '');
  const mine = useRemote(async () => {
    if (!member) return [];
    const r = await ctx.client
      .from('customer_packages')
      .select('id, customer_id, name, price, visits_total, visits_left, valid_until, status')
      .eq('customer_id', member.id)
      .order('created_at', { ascending: false });
    return r.error ? [] : parseCustomerPackages(r.data);
  }, member?.id ?? '');

  if (ctx.isModuleOn && !ctx.isModuleOn('packages'))
    return (
      <div className="admin-page">
        <h1>{t.pkgTitle}</h1>
        <Notice kind="info">{t.pkgOff}</Notice>
      </div>
    );

  const save = async () => {
    if (!form || !storeId) return;
    setError(null);
    setBad(false);
    const price = parsePriceInput(form.price);
    const visits = /^\d{1,3}$/.test(form.visits.trim()) ? Number(form.visits) : NaN;
    const days =
      form.days.trim() === '' ? null : /^\d{1,4}$/.test(form.days.trim()) ? Number(form.days) : NaN;
    if (
      !form.th.trim() ||
      price === null ||
      price < 100 ||
      !(visits >= 1 && visits <= 100) ||
      (days !== null && !(days >= 1 && days <= 3650))
    )
      return setBad(true);
    const values = {
      name: { th: form.th.trim(), ...(form.en.trim() ? { en: form.en.trim() } : {}) },
      price,
      visits,
      valid_days: days,
      active: form.active,
    };
    const r = form.id
      ? await ctx.client.from('service_packages').update(values).eq('id', form.id).select('id')
      : await ctx.client
          .from('service_packages')
          .insert({ org_id: ctx.orgId, store_id: storeId, ...values });
    if (r.error) return setError(r.error.code === '42501' ? 'err_forbidden' : 'err_save_failed');
    setForm(null);
    data.reload();
  };

  const sell = async () => {
    if (!storeId || !member || !sellId) return;
    setError(null);
    const { data: id, error: err } = await ctx.client.rpc('sell_package', {
      p: { store_id: storeId, package_id: sellId, customer_id: member.id },
    });
    if (err || typeof id !== 'string')
      return setError(err?.code === '42501' ? 'err_forbidden' : 'err_save_failed');
    ctx.navigate(`/order/${id}`);
  };

  return (
    <div className="admin-page">
      <h1>{t.pkgTitle}</h1>
      <Notice kind="info">{t.pkgIntro}</Notice>
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      {data.status === 'loading' ? (
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      ) : null}
      {data.status === 'error' ? <Notice kind="error">{t.err_load_failed}</Notice> : null}

      <section className="card admin-card" aria-labelledby="pkg-catalogue">
        <h2 id="pkg-catalogue">{t.pkgCatalogue}</h2>
        {data.data && data.data.length === 0 ? <p className="muted">{t.pkgEmpty}</p> : null}
        <ul className="member-list">
          {(data.data ?? []).map((p) => (
            <li key={p.id} className="member-row">
              <div className="member-head">
                <strong>{localizedName(p.name, lang)}</strong>
                <span className="tabular">{money(p.price)}</span>
                {!p.active ? <span className="badge">{t.pkgInactive}</span> : null}
              </div>
              <p className="muted">
                {fmt(t.pkgVisits, { n: p.visits })} ·{' '}
                {fmt(t.pkgPerVisit, { amount: money(visitValue(p.price, p.visits)) })} ·{' '}
                {p.validDays ? fmt(t.pkgValidDays, { n: p.validDays }) : t.pkgNoExpiry}
              </p>
              {canEdit ? (
                <div className="actions">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() =>
                      setForm({
                        id: p.id,
                        th: p.name.th,
                        en: p.name.en ?? '',
                        price: priceInputValue(p.price),
                        visits: String(p.visits),
                        days: p.validDays ? String(p.validDays) : '',
                        active: p.active,
                      })
                    }
                  >
                    {t.stockEdit}
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
        {form ? (
          <form className="auth-form" onSubmit={(e) => e.preventDefault()} aria-label={t.pkgAdd}>
            <div className="filters">
              <div className="form-row">
                <label className="label" htmlFor="pkg-th">
                  {t.stockNameTh}
                </label>
                <input
                  id="pkg-th"
                  className="field"
                  maxLength={80}
                  value={form.th}
                  onChange={(e) => setForm({ ...form, th: e.target.value })}
                />
              </div>
              <div className="form-row">
                <label className="label" htmlFor="pkg-en">
                  {t.stockNameEn}
                </label>
                <input
                  id="pkg-en"
                  className="field"
                  maxLength={80}
                  value={form.en}
                  onChange={(e) => setForm({ ...form, en: e.target.value })}
                />
              </div>
            </div>
            <div className="filters">
              <div className="form-row">
                <label className="label" htmlFor="pkg-price">
                  {t.pkgPrice}
                </label>
                <input
                  id="pkg-price"
                  className="field tabular"
                  inputMode="decimal"
                  value={form.price}
                  onChange={(e) => setForm({ ...form, price: e.target.value })}
                />
              </div>
              <div className="form-row">
                <label className="label" htmlFor="pkg-visits">
                  {t.pkgVisitsField}
                </label>
                <input
                  id="pkg-visits"
                  className="field tabular"
                  inputMode="numeric"
                  value={form.visits}
                  onChange={(e) => setForm({ ...form, visits: e.target.value })}
                />
              </div>
              <div className="form-row">
                <label className="label" htmlFor="pkg-days">
                  {t.pkgDaysField}
                </label>
                <input
                  id="pkg-days"
                  className="field tabular"
                  inputMode="numeric"
                  value={form.days}
                  onChange={(e) => setForm({ ...form, days: e.target.value })}
                />
              </div>
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(e) => setForm({ ...form, active: e.target.checked })}
              />{' '}
              {t.pkgActive}
            </label>
            {bad ? <Notice kind="error">{t.pkgBad}</Notice> : null}
            <div className="actions">
              <AsyncButton type="submit" onClick={save}>
                {t.pkgSave}
              </AsyncButton>
              <button type="button" className="btn btn-secondary" onClick={() => setForm(null)}>
                {t.menuCancel}
              </button>
            </div>
          </form>
        ) : canEdit ? (
          <div className="actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() =>
                setForm({
                  id: null,
                  th: '',
                  en: '',
                  price: '',
                  visits: '10',
                  days: '180',
                  active: true,
                })
              }
            >
              {t.pkgAdd}
            </button>
          </div>
        ) : null}
      </section>

      <section className="card admin-card" aria-labelledby="pkg-member">
        <h2 id="pkg-member">{t.pkgMemberTitle}</h2>
        {!member ? (
          <CustomerPicker ctx={ctx} onPick={setMember} idPrefix="pkg" />
        ) : (
          <>
            <p>
              <strong>{member.name}</strong>{' '}
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setMember(null);
                  setSellId('');
                }}
              >
                {t.pkgOtherMember}
              </button>
            </p>
            <ul className="member-list">
              {(mine.data ?? []).length === 0 ? <li className="muted">{t.pkgNoneYet}</li> : null}
              {(mine.data ?? []).map((p) => {
                const st = packageState(p, today);
                return (
                  <li key={p.id} className="member-row">
                    <div className="member-head">
                      <strong>{localizedName(p.name, lang)}</strong>
                      <span className="badge">{tx(t, `pkgState_${st}`)}</span>
                    </div>
                    <p className="muted tabular">
                      {fmt(t.pkgLeft, { left: p.visitsLeft, total: p.visitsTotal })}
                      {p.validUntil ? ` · ${fmt(t.pkgUntil, { date: p.validUntil })}` : ''}
                    </p>
                  </li>
                );
              })}
            </ul>
            {canSell ? (
              <>
                <div className="form-row">
                  <label className="label" htmlFor="pkg-sell">
                    {t.pkgSellLabel}
                  </label>
                  <select
                    id="pkg-sell"
                    className="field"
                    value={sellId}
                    onChange={(e) => setSellId(e.target.value)}
                  >
                    <option value="">{t.calNone}</option>
                    {(data.data ?? [])
                      .filter((p) => p.active)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {localizedName(p.name, lang)} · {money(p.price)}
                        </option>
                      ))}
                  </select>
                </div>
                <div className="actions">
                  <AsyncButton onClick={sell} disabled={!sellId}>
                    {t.pkgSell}
                  </AsyncButton>
                </div>
              </>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
