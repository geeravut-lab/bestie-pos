import { useState } from 'react';
import {
  addLine,
  formatTHB,
  hasUnsent,
  isOrderOpen,
  localizedName,
  moveToTable,
  orderBill,
  removeNewLine,
  sendNew,
  setCovers,
  setNote,
  setQuantity,
  voidSentLine,
} from '@bestie/core';
import type { Channel, LineDoc, OrderDoc, OrderGroupInput, OrderItemInput } from '@bestie/core';
import type { Item, Menu } from '@bestie/admin-ui';
import { errorText, fmt, useI18n } from '@bestie/i18n';
import type { Dict, ErrorKey } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useOpenOrders, useOrder, useOutboxCounts } from '@bestie/offline';
import { billConfigFor, usePosData } from './posData';
import type { PosTable } from './posData';
import { changeOrder } from './orderActions';
import { LoadFailed, Loading, Page } from './PosBits';
import { ModifierSheet } from './ModifierSheet';

const channelText = (t: Dict, c: Channel): string =>
  (t as Record<string, string>)[`channel_${c.replace('-', '_')}`] ?? c;

const groupInput = (menu: Menu, id: string): OrderGroupInput | null => {
  const g = menu.groups.find((x) => x.id === id);
  if (!g) return null;
  return {
    id: g.id,
    name: g.name,
    min: g.min_select,
    max: g.max_select,
    options: menu.opts
      .filter((o) => o.group_id === g.id && o.active)
      .map((o) => ({
        id: o.id,
        name: o.name,
        priceDelta: o.price_delta,
        channelDelta: o.channel_delta as Partial<Record<Channel, number>>,
      })),
  };
};
const itemInput = (i: Item): OrderItemInput => ({
  id: i.id,
  name: i.name,
  prices: i.prices,
  station: i.station,
});

/** The bill of one table / counter order: tap the menu to add, send to the kitchen, change before it is sent. */
export function OrderPage({ ctx, orderId }: { ctx: PageContext; orderId: string }) {
  const { t, lang } = useI18n();
  const locale = lang === 'th' ? ('th-TH' as const) : ('en-GB' as const);
  const order = useOrder(orderId);
  const remote = usePosData(ctx, order?.storeId ?? null);
  const openOrders = useOpenOrders(order?.storeId ?? null);
  const { pending } = useOutboxCounts();
  const [cat, setCat] = useState('');
  const [picking, setPicking] = useState<{ item: Item; groups: OrderGroupInput[] } | null>(null);
  const [error, setError] = useState<ErrorKey | null>(null);

  if (order === undefined || (order && (openOrders === undefined || remote.status === 'loading')))
    return <Loading />;
  if (order === null)
    return (
      <Page title={t.ordersTitle}>
        <Notice kind="error">{t.orderNotFound}</Notice>
        <AsyncButton variant="secondary" onClick={() => ctx.navigate('/orders')}>
          {t.ordersTitle}
        </AsyncButton>
      </Page>
    );
  if (remote.status === 'error' || !remote.data || openOrders === undefined)
    return <LoadFailed onRetry={remote.reload} />;

  const { menu, tables, config, stale } = remote.data;
  const open = isOrderOpen(order);
  const canEdit = open && (ctx.isOwner || ctx.permissions.includes('order.create'));
  const canVoid = open && (ctx.isOwner || ctx.permissions.includes('order.void'));
  const bill = orderBill(order, billConfigFor(config, order.channel));
  const tableName = tables.find((x) => x.id === order.tableId)?.name;
  const takenTables = new Set(openOrders.filter((o) => o.id !== order.id).map((o) => o.tableId));
  const freeTables: PosTable[] = tables.filter(
    (x) => !takenTables.has(x.id) && x.id !== order.tableId,
  );

  const apply = async (fn: (o: OrderDoc) => OrderDoc) => {
    setError(null);
    const err = await changeOrder(order.id, fn);
    if (err) setError(err);
  };

  const addItem = (item: Item) => {
    const groups = item.modifier_group_ids
      .map((id) => groupInput(menu, id))
      .filter((g): g is OrderGroupInput => g !== null);
    if (groups.some((g) => g.options.length > 0)) return setPicking({ item, groups });
    return apply((o) =>
      addLine(o, {
        lineId: crypto.randomUUID(),
        item: itemInput(item),
        groups,
        selected: [],
        quantity: 1,
        staffId: ctx.staffId,
      }),
    );
  };

  const cats = menu.cats.filter((c) => c.active);
  const shown = menu.items.filter(
    (i) => cats.some((c) => c.id === i.category_id) && (cat === '' || i.category_id === cat),
  );

  return (
    <Page title={fmt(t.orderTitle, { number: order.number })}>
      <p className="muted">
        {tableName ? fmt(t.orderAtTable, { name: tableName }) : channelText(t, order.channel)}
        {pending > 0 ? ` · ${t.orderWaitingSync}` : ''}
      </p>
      {stale ? <Notice kind="info">{t.orderStale}</Notice> : null}
      {!open ? (
        <Notice kind="info">{t.orderClosed}</Notice>
      ) : !canEdit ? (
        <Notice kind="info">{t.orderReadOnly}</Notice>
      ) : null}
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}

      <div className="order-screen">
        <section className="card admin-card" aria-label={t.orderItems}>
          <div className="chips" role="group" aria-label={t.orderItems}>
            <button
              type="button"
              className="chip"
              aria-pressed={cat === ''}
              onClick={() => setCat('')}
            >
              {t.menuAll}
            </button>
            {cats.map((c) => (
              <button
                key={c.id}
                type="button"
                className="chip"
                aria-pressed={cat === c.id}
                onClick={() => setCat(c.id)}
              >
                {localizedName(c.name, lang)}
              </button>
            ))}
          </div>
          <div className="item-grid">
            {shown.map((i) => (
              <button
                key={i.id}
                type="button"
                className="item-card"
                disabled={!canEdit || !i.available}
                onClick={() => void addItem(i)}
              >
                <strong>{localizedName(i.name, lang)}</strong>
                <span className="tabular">
                  {formatTHB(i.prices[order.channel] ?? i.prices.base, locale)}
                </span>
                {!i.available ? (
                  <span className="badge badge-warn">{t.orderSoldOutHint}</span>
                ) : null}
              </button>
            ))}
          </div>
        </section>

        <section className="card admin-card order-panel" aria-label={t.orderLines}>
          <h2>{t.orderLines}</h2>
          {order.lines.every((l) => l.status === 'void') ? (
            <p className="muted">{t.orderEmpty}</p>
          ) : null}
          <ul className="member-list">
            {order.lines
              .filter((l) => l.status !== 'void')
              .map((l) => (
                <LineRow
                  key={l.id}
                  line={l}
                  locale={locale}
                  canEdit={canEdit}
                  canVoid={canVoid}
                  apply={apply}
                />
              ))}
          </ul>
          <dl className="preview-list tabular">
            <div>
              <dt>{t.previewSubtotal}</dt>
              <dd>{formatTHB(bill.discountedSubtotal, locale)}</dd>
            </div>
            {bill.serviceCharge > 0 ? (
              <div>
                <dt>{t.previewService}</dt>
                <dd>{formatTHB(bill.serviceCharge, locale)}</dd>
              </div>
            ) : null}
            {bill.vat > 0 ? (
              <div>
                <dt>{t.previewVat}</dt>
                <dd>{formatTHB(bill.vat, locale)}</dd>
              </div>
            ) : null}
            <div>
              <dt>
                <strong>{t.previewTotal}</strong>
              </dt>
              <dd>
                <strong>{formatTHB(bill.total, locale)}</strong>
              </dd>
            </div>
          </dl>
          {canEdit ? (
            <>
              <AsyncButton
                disabled={!hasUnsent(order)}
                onClick={() => apply((o) => sendNew(o, Date.now()).order)}
              >
                {hasUnsent(order) ? t.orderSend : t.orderSendNothing}
              </AsyncButton>
              <div className="filters">
                {order.channel === 'dine-in' ? (
                  <div className="form-row">
                    <label className="label" htmlFor="order-move">
                      {t.orderMoveTable}
                    </label>
                    <select
                      id="order-move"
                      className="field"
                      value=""
                      onChange={(e) => {
                        const id = e.target.value; // read NOW: the controlled select resets before the change is applied
                        if (id) void apply((o) => moveToTable(o, id));
                      }}
                    >
                      <option value="">{tableName ?? '—'}</option>
                      {freeTables.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
                <div className="form-row">
                  <label className="label" htmlFor="order-covers">
                    {t.orderCovers}
                  </label>
                  <input
                    id="order-covers"
                    className="field tabular"
                    inputMode="numeric"
                    defaultValue={order.covers ?? ''}
                    key={order.covers ?? 'none'}
                    onBlur={(e) => {
                      const n = Number(e.target.value);
                      if (e.target.value !== '' && Number.isFinite(n) && n !== order.covers)
                        void apply((o) => setCovers(o, n));
                    }}
                  />
                </div>
              </div>
            </>
          ) : null}
        </section>
      </div>

      {picking ? (
        <ModifierSheet
          item={itemInput(picking.item)}
          groups={picking.groups}
          channel={order.channel}
          onClose={() => setPicking(null)}
          onAdd={async (selected, quantity, note) => {
            await apply((o) =>
              addLine(o, {
                lineId: crypto.randomUUID(),
                item: itemInput(picking.item),
                groups: picking.groups,
                selected,
                quantity,
                note,
                staffId: ctx.staffId,
              }),
            );
            setPicking(null);
          }}
        />
      ) : null}
    </Page>
  );
}

function LineRow({
  line,
  locale,
  canEdit,
  canVoid,
  apply,
}: {
  line: LineDoc;
  locale: 'th-TH' | 'en-GB';
  canEdit: boolean;
  canVoid: boolean;
  apply: (fn: (o: OrderDoc) => OrderDoc) => Promise<void>;
}) {
  const { t, lang } = useI18n();
  const name = localizedName(line.name, lang);
  const isNew = line.status === 'new';
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');
  const tag =
    line.status === 'new'
      ? t.orderNewTag
      : line.status === 'sent'
        ? t.orderSentTag
        : line.status === 'ready'
          ? t.orderReadyTag
          : t.orderServedTag;
  return (
    <li className="member-row line-row">
      <div className="member-head">
        <strong>{name}</strong>
        <span className="badge">{tag}</span>
        <span className="tabular line-total">
          {formatTHB(line.unitPrice * line.quantity, locale)}
        </span>
      </div>
      {line.modifiers.length > 0 ? (
        <p className="muted">{line.modifiers.map((m) => localizedName(m.name, lang)).join(', ')}</p>
      ) : null}
      {isNew && canEdit ? (
        <>
          <div className="qty-stepper" role="group" aria-label={fmt(t.orderQty, { name })}>
            <button
              type="button"
              aria-label={fmt(t.orderLess, { name })}
              onClick={() => void apply((o) => setQuantity(o, line.id, line.quantity - 1))}
            >
              −
            </button>
            <output className="tabular">{line.quantity}</output>
            <button
              type="button"
              aria-label={fmt(t.orderMore, { name })}
              disabled={line.quantity >= 99}
              onClick={() => void apply((o) => setQuantity(o, line.id, line.quantity + 1))}
            >
              +
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void apply((o) => removeNewLine(o, line.id))}
            >
              {t.orderRemove}
            </button>
          </div>
          <input
            className="field"
            aria-label={fmt(t.orderNoteFor, { name })}
            placeholder={t.orderNote}
            maxLength={200}
            defaultValue={line.note ?? ''}
            onBlur={(e) => {
              const text = e.target.value;
              if (text.trim() !== (line.note ?? '')) void apply((o) => setNote(o, line.id, text));
            }}
          />
        </>
      ) : (
        <>
          <p className="muted tabular">
            × {line.quantity}
            {line.note ? ` · ${line.note}` : ''}
          </p>
          {canVoid && !isNew ? (
            voiding ? (
              <div className="confirm-box">
                <div className="form-row">
                  <label className="label" htmlFor={`void-${line.id}`}>
                    {t.orderVoidReason}
                  </label>
                  <input
                    id={`void-${line.id}`}
                    className="field"
                    value={reason}
                    maxLength={100}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </div>
                <div className="actions">
                  <AsyncButton
                    variant="danger"
                    onClick={() => apply((o) => voidSentLine(o, line.id, reason))}
                  >
                    {t.orderVoidConfirm}
                  </AsyncButton>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setVoiding(false)}
                  >
                    {t.menuCancel}
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className="btn btn-secondary" onClick={() => setVoiding(true)}>
                {t.orderVoid}
              </button>
            )
          ) : null}
        </>
      )}
    </li>
  );
}
