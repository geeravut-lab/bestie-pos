import { useState } from 'react';
import {
  SELECTABLE_PROFILES,
  cleanModuleOverrides,
  moduleRows,
  normalizeOverrides,
  toggleModule,
} from '@bestie/core';
import type { ModuleId, ModuleRow, PlanTier, StoreModuleConfig } from '@bestie/core';
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

const tx = (t: Dict, key: string): string => (t as Record<string, string>)[key] ?? key;
const modName = (t: Dict, id: ModuleId): string => tx(t, `mod_${id}`);
const PLAN_NAME = (t: Dict, plan: PlanTier): string =>
  plan === 'basic' ? t.planBasic : plan === 'pro' ? t.planPro : t.planResort;

/** Owner: which modules each shop uses (store level of the toggle matrix), plus adding a shop to the group. */
export function ModulesPage({ ctx }: { ctx: PageContext }) {
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
      legal: { cryptoTopup: sign.cryptoTopup === true }, // only an explicit true opens the gate
    };
  }, ctx.orgId);

  if (status === 'loading')
    return (
      <p className="sso-working" role="status">
        <Spinner /> {t.loading}
      </p>
    );
  if (status === 'error' || !data) {
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
      <h1>{t.modulesTitle}</h1>
      <Notice kind="info">{t.modulesIntro}</Notice>
      <div className="actions">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => ctx.navigate('/settings/tenders')}
        >
          {t.tendersTitle}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => ctx.navigate('/settings/theme')}
        >
          {t.themeTitle}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => ctx.navigate('/ai/usage')}
        >
          {t.aiUsageTitle}
        </button>
      </div>
      {!canEdit ? <Notice kind="info">{t.modulesReadOnly}</Notice> : null}
      {data.stores.length > 0 ? (
        <ModuleToggles
          ctx={ctx}
          stores={data.stores}
          legal={data.legal}
          canEdit={canEdit}
          onSaved={reload}
        />
      ) : null}
      {canEdit ? <AddShopCard ctx={ctx} onAdded={reload} /> : null}
    </div>
  );
}

function ModuleToggles({
  ctx,
  stores,
  legal,
  canEdit,
  onSaved,
}: {
  ctx: PageContext;
  stores: StoreRow[];
  legal: { cryptoTopup: boolean };
  canEdit: boolean;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [storeId, setStoreId] = useState(stores[0]!.id);
  const store = stores.find((s) => s.id === storeId) ?? stores[0]!;
  const config: StoreModuleConfig = {
    profile: store.profile,
    plan: store.plan,
    moduleOverrides: cleanModuleOverrides(store.module_overrides),
    legalSignOff: legal,
  };
  const rows = moduleRows(config);
  const [pendingOff, setPendingOff] = useState<ModuleRow | null>(null);
  const [message, setMessage] = useState<{ kind: 'success' | 'info'; text: string } | null>(null);
  const [error, setError] = useState<ErrorKey | null>(null);

  const apply = async (id: ModuleId, on: boolean) => {
    setError(null);
    setMessage(null);
    const res = toggleModule(config, id, on);
    if (!res.ok) return setError('err_forbidden');
    const overrides = normalizeOverrides(store.profile, res.overrides);
    const { data: saved, error: err } = await ctx.client
      .from('stores')
      .update({ module_overrides: overrides })
      .eq('id', store.id)
      .select('id');
    if (err || saved?.length !== 1)
      return setError(err?.code === '42501' ? 'err_forbidden' : 'err_save_failed');
    setPendingOff(null);
    setMessage(
      res.autoEnabled.length > 0
        ? {
            kind: 'info',
            text: fmt(t.modulesAutoOn, {
              list: res.autoEnabled.map((m) => modName(t, m)).join(', '),
            }),
          }
        : { kind: 'success', text: t.modulesSaved },
    );
    onSaved();
  };

  const onSwitch = (row: ModuleRow, on: boolean) => {
    setMessage(null);
    if (!on && row.dependents.length > 0) return setPendingOff(row); // warn first, then confirm
    void apply(row.id, on);
  };

  return (
    <section className="card admin-card">
      {stores.length > 1 ? (
        <div className="form-row">
          <label className="label" htmlFor="mod-store">
            {t.modulesStore}
          </label>
          <select
            id="mod-store"
            className="field"
            value={storeId}
            onChange={(e) => {
              setStoreId(e.target.value);
              setPendingOff(null);
              setMessage(null);
              setError(null);
            }}
          >
            {stores.map((s) => (
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
        {rows.map((row) => {
          const name = modName(t, row.id);
          const note =
            row.locked === 'plan'
              ? fmt(t.modulesNeedsPlan, { plan: PLAN_NAME(t, row.plan) })
              : row.locked === 'legal'
                ? t.modulesNeedsLegal
                : row.chosen && !row.effective
                  ? t.modulesWaiting
                  : null;
          return (
            <li key={row.id} className="module-row">
              <label className="switch-row">
                <input
                  type="checkbox"
                  role="switch"
                  checked={row.chosen}
                  disabled={!canEdit || (row.locked !== null && !row.chosen)}
                  onChange={(e) => onSwitch(row, e.target.checked)}
                />
                <span className="switch-text">{name}</span>
                <span className="badge">{PLAN_NAME(t, row.plan)}</span>
              </label>
              {note ? <p className="muted module-note">{note}</p> : null}
              {row.dependsOn.length > 0 ? (
                <p className="muted module-note">
                  {fmt(t.modulesDependsOn, {
                    list: row.dependsOn.map((m) => modName(t, m)).join(', '),
                  })}
                </p>
              ) : null}
              {pendingOff?.id === row.id ? (
                <div className="confirm-box" role="alertdialog" aria-label={name}>
                  <p>
                    {fmt(t.modulesConfirmOff, {
                      name,
                      list: row.dependents.map((m) => modName(t, m)).join(', '),
                    })}
                  </p>
                  <div className="actions">
                    <AsyncButton variant="danger" onClick={() => apply(row.id, false)}>
                      {t.modulesConfirmButton}
                    </AsyncButton>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setPendingOff(null)}
                    >
                      {t.modulesCancel}
                    </button>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      {message ? <Notice kind={message.kind}>{message.text}</Notice> : null}
    </section>
  );
}

function AddShopCard({ ctx, onAdded }: { ctx: PageContext; onAdded: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [profile, setProfile] = useState<string>('restaurant');
  const [error, setError] = useState<ErrorKey | null>(null);
  const [done, setDone] = useState(false);
  const names: Record<string, string> = { restaurant: t.profileRestaurant, cafe: t.profileCafe };

  const add = async () => {
    setError(null);
    setDone(false);
    if (name.trim().length < 1) return setError('err_shop_invalid');
    const { error: err } = await ctx.client.rpc('create_store', {
      p_org: ctx.orgId,
      p_name: name.trim(),
      p_profile: profile,
    });
    if (err) {
      console.error('[shops] create_store failed', err.code ?? 'unknown');
      return setError(err.code === '42501' ? 'err_forbidden' : 'err_save_failed');
    }
    setName('');
    setDone(true);
    onAdded();
  };

  return (
    <section className="card admin-card">
      <h2>{t.shopsTitle}</h2>
      <p className="muted">{t.shopsIntro}</p>
      <form className="auth-form" onSubmit={(e) => e.preventDefault()}>
        <div className="filters">
          <div className="form-row">
            <label className="label" htmlFor="shop-name">
              {t.shopsName}
            </label>
            <input
              id="shop-name"
              className="field"
              value={name}
              maxLength={120}
              onChange={(e) => {
                setName(e.target.value);
                setDone(false);
              }}
            />
          </div>
          <div className="form-row">
            <label className="label" htmlFor="shop-profile">
              {t.shopsProfile}
            </label>
            <select
              id="shop-profile"
              className="field"
              value={profile}
              onChange={(e) => setProfile(e.target.value)}
            >
              {SELECTABLE_PROFILES.map((p) => (
                <option key={p} value={p}>
                  {names[p]}
                </option>
              ))}
            </select>
          </div>
        </div>
        {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
        {done ? <Notice kind="success">{t.shopsAdded}</Notice> : null}
        <AsyncButton type="submit" onClick={add}>
          {t.shopsAdd}
        </AsyncButton>
      </form>
    </section>
  );
}
