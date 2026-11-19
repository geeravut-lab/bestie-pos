import { GuestCalls } from './GuestCalls';
import { useState } from 'react';
import { formatTHB, liveLines, itemCount, orderBill } from '@bestie/core';
import type { OrderDoc } from '@bestie/core';
import { errorText, fmt, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { Spinner, useAsyncAction } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useOpenOrders } from '@bestie/offline';
import { billConfigFor, usePosData, usePosStore } from './posData';
import type { PosConfig, PosTable } from './posData';
import { openOrder } from './orderActions';
import { LoadFailed, Loading, NeedsDevice, Page } from './PosBits';
import { TableManager } from './TableManager';

/** Tables grouped by zone: tap a free table to open a bill, tap a busy one to continue it. Works with no signal. */
export function FloorPlanPage({ ctx }: { ctx: PageContext }) {
  const { t } = useI18n();
  const { storeId, binding } = usePosStore(ctx);
  const remote = usePosData(ctx, storeId);
  const orders = useOpenOrders(storeId);
  const canManage = ctx.isOwner || ctx.permissions.includes('menu.edit');

  if (!storeId)
    return (
      <Page title={t.tablesTitle}>
        <Notice kind="error">{t.posNoShop}</Notice>
      </Page>
    );
  if (remote.status === 'loading' || orders === undefined) return <Loading />;
  if (remote.status === 'error' || !remote.data) return <LoadFailed onRetry={remote.reload} />;
  const { tables, config, stale } = remote.data;

  const orderOf = (tableId: string): OrderDoc | undefined =>
    orders.find((o) => o.tableId === tableId);
  const zones = new Map<string, PosTable[]>();
  for (const tb of tables) zones.set(tb.zone, [...(zones.get(tb.zone) ?? []), tb]);

  return (
    <Page title={t.tablesTitle}>
      {stale ? <Notice kind="info">{t.tableStale}</Notice> : null}
      <GuestCalls ctx={ctx} storeId={storeId} />
      {!binding ? <NeedsDevice ctx={ctx} /> : null}
      {tables.length === 0 ? <Notice kind="info">{t.tablesEmpty}</Notice> : null}
      {[...zones.entries()].map(([zone, list]) => (
        <section key={zone} className="card admin-card">
          <h2>{zone || t.tablesNoZone}</h2>
          <div className="table-grid">
            {list.map((tb) => (
              <TableCard
                key={tb.id}
                table={tb}
                order={orderOf(tb.id)}
                bills={orders.filter((o) => o.tableId === tb.id).length}
                config={config}
                canOpen={binding !== null}
                onOpen={async () => {
                  if (!binding) return;
                  const id = await openOrder({
                    binding,
                    staffId: ctx.staffId,
                    channel: 'dine-in',
                    tableId: tb.id,
                  });
                  ctx.navigate(`/order/${id}`);
                }}
                onContinue={(id) => ctx.navigate(`/order/${id}`)}
              />
            ))}
          </div>
        </section>
      ))}
      {canManage ? (
        <TableManager
          ctx={ctx}
          storeId={storeId}
          tables={tables}
          orders={orders}
          onChanged={remote.reload}
        />
      ) : null}
    </Page>
  );
}

function TableCard({
  table,
  order,
  bills,
  config,
  canOpen,
  onOpen,
  onContinue,
}: {
  table: PosTable;
  order: OrderDoc | undefined;
  /** How many open bills sit on this table (a split makes more than one). */
  bills: number;
  config: PosConfig;
  canOpen: boolean;
  onOpen: () => Promise<void>;
  onContinue: (id: string) => void;
}) {
  const { t, lang } = useI18n();
  const locale = lang === 'th' ? 'th-TH' : 'en-GB';
  const [error, setError] = useState<ErrorKey | null>(null);
  const { run, pending } = useAsyncAction(onOpen, { onError: setError });
  const busy = order !== undefined;
  return (
    <div>
      <button
        type="button"
        className="table-card"
        data-state={busy ? 'busy' : 'free'}
        aria-busy={pending || undefined}
        disabled={!busy && !canOpen}
        onClick={() => (order ? onContinue(order.id) : void run())}
      >
        {pending ? <Spinner /> : null}
        <strong>{table.name}</strong>
        {order ? (
          <>
            <span>{bills > 1 ? fmt(t.tablesBills, { n: bills }) : t.tablesBusy}</span>
            <span className="tabular">
              {itemCount(order)} ·{' '}
              {formatTHB(orderBill(order, billConfigFor(config, order.channel)).total, locale)}
            </span>
            {liveLines(order).some((l) => l.status === 'ready') ? (
              <span className="badge">{t.orderReadyTag}</span>
            ) : null}
          </>
        ) : (
          <>
            <span>{t.tablesFree}</span>
            <span className="muted">{fmt(t.tablesSeats, { n: table.seats })}</span>
          </>
        )}
      </button>
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
    </div>
  );
}
