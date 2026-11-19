import { useState } from 'react';
import { cleanModuleOverrides, moduleRows, normalizeOverrides, toggleModule } from '@bestie/core';
import type { ModuleId, PlanTier, StoreModuleConfig } from '@bestie/core';
import { errorText, fmt, useI18n } from '@bestie/i18n';
import type { Dict, ErrorKey } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useRemote } from './useRemote';

type StoreRow = {
  id: string;
  name: string;
  profile: StoreModuleConfig['profile'];
  plan: PlanTier;
  module_overrides: unknown;
};

/** The payment methods a shop can switch: cash is always on and not listed as a switch. Points is a discount, not money, but is switched the same way. */
const TENDERS = ['tender.promptpay', 'tender.gateway', 'tender.credit', 'tender.points'] as const;
const tx = (t: Dict, key: string): string => (t as Record<string, string>)[key] ?? key;

/**
 * Owner: which ways of paying each shop offers. The same switches as the module screen, in words a cashier's boss understands;
 * the till hides a switched-off method and the database refuses it (`tender_module_on`).
 */
export function TendersPage({ ctx }: { ctx: PageContext }) {
  const { t } = useI18n();
  const canEdit = ctx.isOwner || ctx.permissions.includes('settings.manage');
  const { status, data, reload } = useRemote(async () => {
    const [stores, org] = await Promise.all([
      ctx.client
        .from('stores')
        .select('id, name, profile, plan, module_overrides')
        .eq('org_id', ctx.orgId)
        .is('deleted_at', null)
        .order('created_at'),
      ctx.client.from('orgs').select('legal_sign_off').eq('id', ctx.orgId).maybeSingle(),
    ]);
    if (stores.error || org.error) throw new Error('load');
    const sign = ((org.data as { legal_sign_off?: { cryptoTopup?: unknown } } | null)
      ?.legal_sign_off ?? {}) as { cryptoTopup?: unknown };
    return {
      stores: (stores.data ?? []) as StoreRow[],
      legal: { cryptoTopup: sign.cryptoTopup === true },
    };
  }, ctx.orgId);
  const [storeId, setStoreId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<ErrorKey | null>(null);

  if (status === 'loading')
    return (
      <p className="sso-working" role="status">
        <Spinner /> {t.loading}
      </p>
    );
  if (status === 'error' || !data || data.stores.length === 0)
    return (
      <div className="admin-page">
        <Notice kind="error">{t.err_load_failed}</Notice>
        <AsyncButton variant="secondary" onClick={reload}>
          {t.retry}
        </AsyncButton>
      </div>
    );

  const store = data.stores.find((s) => s.id === (storeId ?? ctx.homeStoreId)) ?? data.stores[0]!;
  const config: StoreModuleConfig = {
    profile: store.profile,
    plan: store.plan,
    moduleOverrides: cleanModuleOverrides(store.module_overrides),
    legalSignOff: data.legal,
  };
  const rows = moduleRows(config).filter((r) => (TENDERS as readonly string[]).includes(r.id));
  const name = (id: ModuleId) => tx(t, `mod_${id}`);

  const apply = async (id: ModuleId, on: boolean) => {
    setError(null);
    setMessage(null);
    const res = toggleModule(config, id, on);
    if (!res.ok) return setError('err_forbidden');
    const { data: saved, error: err } = await ctx.client
      .from('stores')
      .update({ module_overrides: normalizeOverrides(store.profile, res.overrides) })
      .eq('id', store.id)
      .select('id');
    if (err || saved?.length !== 1)
      return setError(err?.code === '42501' ? 'err_forbidden' : 'err_save_failed');
    const also = [...res.autoEnabled, ...res.autoDisabled];
    setMessage(
      also.length > 0 ? fmt(t.tendersAlso, { list: also.map(name).join(', ') }) : t.modulesSaved,
    );
    reload();
  };

  return (
    <div className="admin-page">
      <h1>{t.tendersTitle}</h1>
      <Notice kind="info">{t.tendersIntro}</Notice>
      {!canEdit ? <Notice kind="info">{t.modulesReadOnly}</Notice> : null}
      <section className="card admin-card">
        {data.stores.length > 1 ? (
          <div className="form-row">
            <label className="label" htmlFor="tender-store">
              {t.modulesStore}
            </label>
            <select
              id="tender-store"
              className="field"
              value={store.id}
              onChange={(e) => {
                setStoreId(e.target.value);
                setMessage(null);
                setError(null);
              }}
            >
              {data.stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <h2>{store.name}</h2>
        )}
        <ul className="module-list">
          <li className="module-row">
            <label className="switch-row">
              <input type="checkbox" role="switch" checked disabled aria-label={t.tendersCash} />
              <span className="switch-text">{t.tendersCash}</span>
            </label>
            <p className="muted module-note">{t.tendersCashNote}</p>
          </li>
          {rows.map((row) => (
            <li key={row.id} className="module-row">
              <label className="switch-row">
                <input
                  type="checkbox"
                  role="switch"
                  checked={row.effective}
                  disabled={!canEdit || (row.locked !== null && !row.chosen)}
                  onChange={(e) => void apply(row.id, e.target.checked)}
                />
                <span className="switch-text">{name(row.id)}</span>
              </label>
              <p className="muted module-note">{tx(t, `tendersNote_${row.id}`)}</p>
              {row.locked === 'plan' ? (
                <p className="muted module-note">
                  {t.modulesNeedsPlan.replace('{plan}', row.plan)}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
        {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
        {message ? <Notice kind="success">{message}</Notice> : null}
      </section>
    </div>
  );
}
