import { useState } from 'react';
import {
  DEFAULT_POINTS_RULE,
  ROUNDING_RULES,
  SERVICE_CHARGE_BASE_OPTIONS,
  SERVICE_CHARGE_VAT_OPTIONS,
  applyRounding,
  baht,
  billOptionsToColumn,
  computeBill,
  formatTHB,
  parseBillOptions,
  parsePointsRule,
  parseRoundingConfig,
  pointsEarned,
  pointsRuleProblems,
  pointsRuleToColumn,
  roundingToColumn,
} from '@bestie/core';
import type { BillOptions, PointsRule, RoundingRule } from '@bestie/core';
import { errorText, fmt, useI18n } from '@bestie/i18n';
import type { Dict, ErrorKey } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useRemote } from './useRemote';

type StoreRow = {
  id: string;
  name: string;
  vat_registered: boolean;
  vat_bps: number;
  service_charge_bps: number;
  price_mode: 'inclusive' | 'exclusive';
  rounding: unknown;
  bill_options: unknown;
  shift_required?: boolean;
  qr_auto_send?: boolean;
};

const tx = (t: Dict, key: string, fallback = key): string =>
  (t as Record<string, string>)[key] ?? fallback;
const pct = (bps: number): string => String(bps / 100);
/** "7" / "7.5" → basis points; null when it is not a number between 0 and 100 with at most 2 decimals. */
const toBps = (s: string): number | null => {
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(s.trim())) return null;
  const v = Math.round(parseFloat(s) * 100);
  return v >= 0 && v <= 10_000 ? v : null;
};
const toSatang = (s: string): number | null =>
  /^\d{1,5}(\.\d{1,2})?$/.test(s.trim()) ? Math.round(parseFloat(s) * 100) : null;

/** Owner: VAT, service charge, accounting options, cash rounding and the Points rule — all selectable, all audited. */
export function BillingPage({ ctx }: { ctx: PageContext }) {
  const { t } = useI18n();
  const canEdit = ctx.isOwner || ctx.permissions.includes('settings.manage');
  const { status, data, reload } = useRemote(async () => {
    const [stores, org] = await Promise.all([
      ctx.client
        .from('stores')
        .select(
          'id, name, vat_registered, vat_bps, service_charge_bps, price_mode, rounding, bill_options, shift_required, qr_auto_send',
        )
        .eq('org_id', ctx.orgId)
        .is('deleted_at', null)
        .order('created_at'),
      ctx.client.from('orgs').select('points_rule').eq('id', ctx.orgId).maybeSingle(),
    ]);
    if (stores.error || org.error) throw new Error('load');
    return {
      stores: (stores.data ?? []) as StoreRow[],
      points: parsePointsRule((org.data as { points_rule?: unknown } | null)?.points_rule),
    };
  }, ctx.orgId);

  if (status === 'loading')
    return (
      <p className="sso-working" role="status">
        <Spinner /> {t.loading}
      </p>
    );
  if (status === 'error' || !data || data.stores.length === 0) {
    return (
      <div className="admin-page">
        <Notice kind="error">{t.err_load_failed}</Notice>
        <AsyncButton variant="secondary" onClick={reload}>
          {t.retry}
        </AsyncButton>
      </div>
    );
  }
  return (
    <div className="admin-page">
      <h1>{t.billingTitle}</h1>
      <Notice kind="info">{t.billingIntro}</Notice>
      <StoreBilling ctx={ctx} stores={data.stores} canEdit={canEdit} onSaved={reload} />
      <PointsRuleCard ctx={ctx} rule={data.points} canEdit={canEdit} onSaved={reload} />
    </div>
  );
}

function StoreBilling({
  ctx,
  stores,
  canEdit,
  onSaved,
}: {
  ctx: PageContext;
  stores: StoreRow[];
  canEdit: boolean;
  onSaved: () => void;
}) {
  const { t, lang } = useI18n();
  const [storeId, setStoreId] = useState(stores[0]!.id);
  const store = stores.find((s) => s.id === storeId) ?? stores[0]!;
  const [vatRegistered, setVatRegistered] = useState(store.vat_registered);
  const [shiftRequired, setShiftRequired] = useState(store.shift_required === true);
  const [qrAutoSend, setQrAutoSend] = useState(store.qr_auto_send === true);
  const [vat, setVat] = useState(pct(store.vat_bps || 700));
  const [service, setService] = useState(pct(store.service_charge_bps));
  const [priceMode, setPriceMode] = useState(store.price_mode);
  const [opts, setOpts] = useState<BillOptions>(parseBillOptions(store.bill_options));
  const [cashRule, setCashRule] = useState<RoundingRule>(
    parseRoundingConfig(store.rounding).cash ?? 'none',
  );
  const [error, setError] = useState<ErrorKey | null>(null);
  const [saved, setSaved] = useState(false);

  const switchStore = (id: string) => {
    const s = stores.find((x) => x.id === id)!;
    setStoreId(id);
    setVatRegistered(s.vat_registered);
    setVat(pct(s.vat_bps || 700));
    setService(pct(s.service_charge_bps));
    setPriceMode(s.price_mode);
    setOpts(parseBillOptions(s.bill_options));
    setShiftRequired(s.shift_required === true);
    setQrAutoSend(s.qr_auto_send === true);
    setCashRule(parseRoundingConfig(s.rounding).cash ?? 'none');
    setSaved(false);
    setError(null);
  };

  const vatBps = vatRegistered ? toBps(vat) : 0;
  const serviceBps = toBps(service);
  const valid = vatBps !== null && serviceBps !== null;

  // live preview with the CURRENT form values
  const preview = valid
    ? (() => {
        const bill = computeBill({
          lines: [{ unitPrice: baht(500), quantity: 2 }],
          priceMode,
          vatBps: vatBps!,
          serviceChargeBps: serviceBps!,
          options: opts,
        });
        return { bill, cash: applyRounding(bill.total, cashRule) };
      })()
    : null;
  const locale = lang === 'th' ? 'th-TH' : 'en-GB';

  const save = async () => {
    setError(null);
    setSaved(false);
    if (!valid) return setError('err_billing_invalid');
    const rounding = { ...parseRoundingConfig(store.rounding), cash: cashRule };
    const { data: rows, error: err } = await ctx.client
      .from('stores')
      .update({
        vat_registered: vatRegistered,
        vat_bps: vatBps,
        service_charge_bps: serviceBps,
        price_mode: priceMode,
        bill_options: billOptionsToColumn(opts),
        shift_required: shiftRequired,
        qr_auto_send: qrAutoSend,
        rounding: roundingToColumn(rounding),
      })
      .eq('id', store.id)
      .select('id');
    if (err || rows?.length !== 1)
      return setError(err?.code === '42501' ? 'err_forbidden' : 'err_save_failed');
    setSaved(true);
    onSaved();
  };

  const radio = <V extends string>(
    name: string,
    value: V,
    options: readonly V[],
    onChange: (v: V) => void,
    label: (v: V) => string,
  ) => (
    <div className="radio-group" role="radiogroup" aria-label={name}>
      {options.map((o) => (
        <label key={o} className="check-row">
          <input
            type="radio"
            name={name}
            checked={value === o}
            disabled={!canEdit}
            onChange={() => {
              onChange(o);
              setSaved(false);
            }}
          />
          <span>{label(o)}</span>
        </label>
      ))}
    </div>
  );

  return (
    <section className="card admin-card">
      <h2>{t.billingTax}</h2>
      {stores.length > 1 ? (
        <div className="form-row">
          <label className="label" htmlFor="bill-store">
            {t.billingStore}
          </label>
          <select
            id="bill-store"
            className="field"
            value={storeId}
            onChange={(e) => switchStore(e.target.value)}
          >
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <label className="switch-row">
        <input
          type="checkbox"
          role="switch"
          checked={vatRegistered}
          disabled={!canEdit}
          onChange={(e) => {
            setVatRegistered(e.target.checked);
            setSaved(false);
          }}
        />
        <span className="switch-text">{t.billingVatRegistered}</span>
      </label>
      <label className="switch-row">
        <input
          type="checkbox"
          role="switch"
          checked={shiftRequired}
          disabled={!canEdit}
          onChange={(e) => {
            setShiftRequired(e.target.checked);
            setSaved(false);
          }}
        />
        <span className="switch-text">{t.billingShiftRequired}</span>
      </label>
      <label className="switch-row">
        <input
          type="checkbox"
          role="switch"
          checked={qrAutoSend}
          disabled={!canEdit}
          onChange={(e) => {
            setQrAutoSend(e.target.checked);
            setSaved(false);
          }}
        />
        <span className="switch-text">{t.billingQrAutoSend}</span>
      </label>
      <div className="filters">
        <div className="form-row">
          <label className="label" htmlFor="bill-vat">
            {t.billingVatRate}
          </label>
          <input
            id="bill-vat"
            className="field tabular"
            inputMode="decimal"
            value={vatRegistered ? vat : '0'}
            disabled={!canEdit || !vatRegistered}
            onChange={(e) => {
              setVat(e.target.value);
              setSaved(false);
            }}
          />
        </div>
        <div className="form-row">
          <label className="label" htmlFor="bill-service">
            {t.billingServiceRate}
          </label>
          <input
            id="bill-service"
            className="field tabular"
            inputMode="decimal"
            value={service}
            disabled={!canEdit}
            onChange={(e) => {
              setService(e.target.value);
              setSaved(false);
            }}
          />
        </div>
      </div>

      <fieldset className="audit-group">
        <legend>{t.billingPriceMode}</legend>
        {radio('priceMode', priceMode, ['inclusive', 'exclusive'] as const, setPriceMode, (v) =>
          v === 'inclusive' ? t.billingPriceInclusive : t.billingPriceExclusive,
        )}
      </fieldset>
      <fieldset className="audit-group">
        <legend>{t.billingScVat}</legend>
        {radio(
          'scVat',
          opts.serviceChargeVat,
          SERVICE_CHARGE_VAT_OPTIONS,
          (v) => setOpts({ ...opts, serviceChargeVat: v }),
          (v) => (v === 'taxable' ? t.billingScTaxable : t.billingScNotTaxable),
        )}
      </fieldset>
      <fieldset className="audit-group">
        <legend>{t.billingScBase}</legend>
        {radio(
          'scBase',
          opts.serviceChargeBase,
          SERVICE_CHARGE_BASE_OPTIONS,
          (v) => setOpts({ ...opts, serviceChargeBase: v }),
          (v) => (v === 'after_discounts' ? t.billingScAfter : t.billingScBefore),
        )}
      </fieldset>
      <fieldset className="audit-group">
        <legend>{t.billingRounding}</legend>
        {radio('cashRounding', cashRule, ROUNDING_RULES, setCashRule, (v) =>
          tx(t, `billingRound_${v}`, v),
        )}
      </fieldset>

      <div className="preview-box" aria-live="polite">
        <strong>{fmt(t.billingPreview, { amount: formatTHB(baht(1000), locale) })}</strong>
        {preview ? (
          <dl className="preview-list tabular">
            <div>
              <dt>{t.previewSubtotal}</dt>
              <dd>{formatTHB(preview.bill.discountedSubtotal, locale)}</dd>
            </div>
            <div>
              <dt>{t.previewService}</dt>
              <dd>{formatTHB(preview.bill.serviceCharge, locale)}</dd>
            </div>
            <div>
              <dt>{t.previewVat}</dt>
              <dd>{formatTHB(preview.bill.vat, locale)}</dd>
            </div>
            <div>
              <dt>{t.previewTotal}</dt>
              <dd>{formatTHB(preview.bill.total, locale)}</dd>
            </div>
            <div>
              <dt>{t.previewCash}</dt>
              <dd>{formatTHB(preview.cash.rounded, locale)}</dd>
            </div>
          </dl>
        ) : null}
      </div>

      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      {saved ? <Notice kind="success">{t.billingSaved}</Notice> : null}
      {canEdit ? <AsyncButton onClick={save}>{t.billingSave}</AsyncButton> : null}
    </section>
  );
}

function PointsRuleCard({
  ctx,
  rule,
  canEdit,
  onSaved,
}: {
  ctx: PageContext;
  rule: PointsRule;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const { t, lang } = useI18n();
  const [earn, setEarn] = useState(String(rule.earnSatangPerPoint / 100));
  const [redeem, setRedeem] = useState(String(rule.redeemSatangPerPoint / 100));
  const [max, setMax] = useState(pct(rule.maxRedeemBps));
  const [credit, setCredit] = useState(rule.creditEarnsPoints);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [saved, setSaved] = useState(false);
  const locale = lang === 'th' ? 'th-TH' : 'en-GB';

  const earnS = toSatang(earn);
  const redeemS = toSatang(redeem);
  const maxB = toBps(max);
  const draft: PointsRule | null =
    earnS !== null && redeemS !== null && maxB !== null
      ? {
          earnSatangPerPoint: earnS,
          redeemSatangPerPoint: redeemS,
          maxRedeemBps: maxB,
          creditEarnsPoints: credit,
        }
      : null;
  const ok = draft !== null && pointsRuleProblems(draft).length === 0;
  const touch = (fn: () => void) => () => {
    fn();
    setSaved(false);
  };

  const save = async () => {
    setError(null);
    setSaved(false);
    if (!draft || !ok) return setError('err_billing_invalid');
    const { data: rows, error: err } = await ctx.client
      .from('orgs')
      .update({ points_rule: pointsRuleToColumn(draft) })
      .eq('id', ctx.orgId)
      .select('id');
    if (err || rows?.length !== 1)
      return setError(err?.code === '42501' ? 'err_forbidden' : 'err_save_failed');
    setSaved(true);
    onSaved();
  };

  const effective = draft && ok ? draft : DEFAULT_POINTS_RULE;
  const demoSpend = baht(500);

  return (
    <section className="card admin-card">
      <h2>{t.pointsTitle}</h2>
      <Notice kind="info">{t.pointsNever}</Notice>
      <div className="filters">
        <div className="form-row">
          <label className="label" htmlFor="pt-earn">
            {t.pointsEarn}
          </label>
          <input
            id="pt-earn"
            className="field tabular"
            inputMode="decimal"
            value={earn}
            disabled={!canEdit}
            onChange={(e) => touch(() => setEarn(e.target.value))()}
          />
        </div>
        <div className="form-row">
          <label className="label" htmlFor="pt-redeem">
            {t.pointsRedeem}
          </label>
          <input
            id="pt-redeem"
            className="field tabular"
            inputMode="decimal"
            value={redeem}
            disabled={!canEdit}
            onChange={(e) => touch(() => setRedeem(e.target.value))()}
          />
        </div>
        <div className="form-row">
          <label className="label" htmlFor="pt-max">
            {t.pointsMax}
          </label>
          <input
            id="pt-max"
            className="field tabular"
            inputMode="decimal"
            value={max}
            disabled={!canEdit}
            onChange={(e) => touch(() => setMax(e.target.value))()}
          />
        </div>
      </div>
      <label className="switch-row">
        <input
          type="checkbox"
          role="switch"
          checked={credit}
          disabled={!canEdit}
          onChange={(e) => touch(() => setCredit(e.target.checked))()}
        />
        <span className="switch-text">{t.pointsCredit}</span>
      </label>
      <p className="muted" aria-live="polite">
        {fmt(t.pointsPreview, {
          spend: formatTHB(demoSpend, locale),
          points: pointsEarned(demoSpend, effective),
          discount: formatTHB(100 * effective.redeemSatangPerPoint, locale),
        })}
      </p>
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      {saved ? <Notice kind="success">{t.billingSaved}</Notice> : null}
      {canEdit ? <AsyncButton onClick={save}>{t.pointsSave}</AsyncButton> : null}
    </section>
  );
}
