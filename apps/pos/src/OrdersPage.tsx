import { OpenDrawer } from './printing/OpenDrawer';
import { formatTHB, itemCount, orderBill } from '@bestie/core';
import type { OrderDoc } from '@bestie/core';
import { fmt, useI18n } from '@bestie/i18n';
import type { Dict } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useOpenOrders } from '@bestie/offline';
import { billConfigFor, usePosData, usePosStore } from './posData';
import { openOrder } from './orderActions';
import { LoadFailed, Loading, NeedsDevice, Page } from './PosBits';

const channelText = (t: Dict, c: OrderDoc['channel']): string =>
  (t as Record<string, string>)[`channel_${c.replace('-', '_')}`] ?? c;

/**
 * `sell`: start a counter / takeaway order right away (the queue number is the order number) and see what is open.
 * `list`: just the open orders of the shop, tables and counter together.
 */
export function OrdersPage({ ctx, mode }: { ctx: PageContext; mode: 'sell' | 'list' }) {
  const { t, lang } = useI18n();
  const locale = lang === 'th' ? 'th-TH' : 'en-GB';
  const { storeId, binding } = usePosStore(ctx);
  const remote = usePosData(ctx, storeId);
  const orders = useOpenOrders(storeId);
  const canCreate = ctx.isOwner || ctx.permissions.includes('order.create');

  if (!storeId)
    return (
      <Page title={t.ordersTitle}>
        <Notice kind="error">{t.posNoShop}</Notice>
      </Page>
    );
  if (remote.status === 'loading' || orders === undefined) return <Loading />;
  if (remote.status === 'error' || !remote.data) return <LoadFailed onRetry={remote.reload} />;
  const { tables, config } = remote.data;
  const tableName = (id: string | null) => tables.find((x) => x.id === id)?.name;

  return (
    <Page title={mode === 'sell' ? t.sellTitle : t.ordersTitle}>
      {!binding ? <NeedsDevice ctx={ctx} /> : null}
      {binding ? (
        <div className="actions">
          <OpenDrawer ctx={ctx} storeId={binding.storeId} deviceId={binding.deviceId} />
        </div>
      ) : null}
      {mode === 'sell' && binding && canCreate ? (
        <div className="actions">
          <AsyncButton
            onClick={async () => {
              const id = await openOrder({ binding, staffId: ctx.staffId, channel: 'takeaway' });
              ctx.navigate(`/order/${id}`);
            }}
          >
            {t.sellNew}
          </AsyncButton>
          {ctx.isModuleOn?.('delivery') ? (
            <AsyncButton
              variant="secondary"
              onClick={async () => {
                const id = await openOrder({ binding, staffId: ctx.staffId, channel: 'delivery' });
                ctx.navigate(`/order/${id}`);
              }}
            >
              {t.dlvNew}
            </AsyncButton>
          ) : null}
        </div>
      ) : null}
      <section className="card admin-card">
        <h2>{t.sellOpenList}</h2>
        {orders.length === 0 ? <p className="muted">{t.sellNone}</p> : null}
        <ul className="member-list">
          {orders.map((o) => (
            <li key={o.id} className="member-row">
              <button
                type="button"
                className="order-row"
                onClick={() => ctx.navigate(`/order/${o.id}`)}
              >
                <strong className="tabular">{o.number}</strong>
                <span>
                  {o.tableId
                    ? fmt(t.orderAtTable, { name: tableName(o.tableId) ?? '—' })
                    : channelText(t, o.channel)}
                </span>
                {o.lines.some((l) => l.status === 'new' && l.createdBy === null) ? (
                  <span className="badge badge-warn">{t.orderGuestTag}</span>
                ) : null}
                <span className="muted tabular">
                  {itemCount(o)} ·{' '}
                  {formatTHB(orderBill(o, billConfigFor(config, o.channel)).total, locale)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </Page>
  );
}
