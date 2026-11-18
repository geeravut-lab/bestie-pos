import { useState } from 'react';
import { errorText, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { loadMenu } from './menuData';
import { MenuItemsTab } from './MenuItemsTab';
import { MenuOptionsTab } from './MenuOptionsTab';
import { useRemote } from './useRemote';

type StoreRow = { id: string; name: string; profile?: string };

/** Menu editor: categories, items (prices per channel, station, options) and add-on option groups. Needs `menu.edit` to change. */
export function MenuPage({ ctx }: { ctx: PageContext }) {
  const { t } = useI18n();
  const { status, data, reload } = useRemote(async () => {
    const r = await ctx.client
      .from('stores')
      .select('id, name, profile')
      .eq('org_id', ctx.orgId)
      .is('deleted_at', null)
      .order('created_at');
    if (r.error) throw new Error('load');
    return (r.data ?? []) as StoreRow[];
  }, ctx.orgId);

  if (status === 'loading')
    return (
      <p className="sso-working" role="status">
        <Spinner /> {t.loading}
      </p>
    );
  if (status === 'error' || !data || data.length === 0) {
    return (
      <div className="admin-page">
        <Notice kind="error">{errorText('err_load_failed', t)}</Notice>
        <AsyncButton variant="secondary" onClick={reload}>
          {t.retry}
        </AsyncButton>
      </div>
    );
  }
  return <MenuEditor ctx={ctx} stores={data} />;
}

function MenuEditor({ ctx, stores }: { ctx: PageContext; stores: StoreRow[] }) {
  const { t } = useI18n();
  const canEdit = ctx.isOwner || ctx.permissions.includes('menu.edit');
  const [storeId, setStoreId] = useState(
    stores.find((s) => s.id === ctx.storeId)?.id ?? stores[0]!.id,
  );
  const [tab, setTab] = useState<'items' | 'options'>('items');
  const [demoError, setDemoError] = useState<ErrorKey | null>(null);
  const profile = stores.find((s) => s.id === storeId)?.profile;
  const { status, data, reload } = useRemote(
    () => loadMenu(ctx.client, storeId),
    `${ctx.orgId}:${storeId}`,
  );

  return (
    <div className="admin-page">
      <h1>{t.menuTitle}</h1>
      <Notice kind="info">{t.menuIntro}</Notice>
      {!canEdit ? <Notice kind="info">{t.menuReadOnly}</Notice> : null}
      {stores.length > 1 ? (
        <div className="form-row">
          <label className="label" htmlFor="menu-store">
            {t.menuStore}
          </label>
          <select
            id="menu-store"
            className="field"
            value={storeId}
            onChange={(e) => setStoreId(e.target.value)}
          >
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {canEdit &&
      data &&
      data.cats.length === 0 &&
      data.items.length === 0 &&
      (profile === 'restaurant' || profile === 'cafe') ? (
        <section className="card admin-card">
          <h2>{t.menuDemoTitle}</h2>
          <p className="muted">{profile === 'cafe' ? t.menuDemoCafe : t.menuDemoRestaurant}</p>
          {demoError ? <Notice kind="error">{errorText(demoError, t)}</Notice> : null}
          <AsyncButton
            variant="secondary"
            onClick={async () => {
              setDemoError(null);
              const { error } = await ctx.client.rpc('seed_demo_menu', { p_store: storeId });
              if (error) setDemoError('err_load_failed');
              else reload();
            }}
          >
            {t.menuDemoLoad}
          </AsyncButton>
        </section>
      ) : null}
      <div className="tabs" role="tablist" aria-label={t.menuTitle}>
        {(['items', 'options'] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            className="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
          >
            {k === 'items' ? t.menuTabItems : t.menuTabOptions}
          </button>
        ))}
      </div>
      {status === 'loading' ? (
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      ) : status === 'error' || !data ? (
        <>
          <Notice kind="error">{t.err_load_failed}</Notice>
          <AsyncButton variant="secondary" onClick={reload}>
            {t.retry}
          </AsyncButton>
        </>
      ) : tab === 'items' ? (
        <MenuItemsTab
          ctx={ctx}
          storeId={storeId}
          menu={data}
          canEdit={canEdit}
          onChanged={reload}
        />
      ) : (
        <MenuOptionsTab
          ctx={ctx}
          storeId={storeId}
          menu={data}
          canEdit={canEdit}
          onChanged={reload}
        />
      )}
    </div>
  );
}
