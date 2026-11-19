import { useEffect, useRef, useState } from 'react';
import {
  addLine,
  formatTHB,
  hasUnsent,
  isOrderOpen,
  setSeat,
  liveLines,
  localizedName,
  menuImageUrl,
  moveToTable,
  orderBill,
  removeNewLine,
  sendNew,
  setCovers,
  setNote,
  setQuantity,
  resolveScan,
  validateSelection,
  voidSentLine,
} from '@bestie/core';
import type {
  Channel,
  LineDoc,
  OrderDoc,
  OrderGroupInput,
  OrderItemInput,
  RoundingRule,
  Satang,
} from '@bestie/core';
import type { Item, Menu } from '@bestie/admin-ui';
import { errorText, fmt, useI18n } from '@bestie/i18n';
import type { Dict, ErrorKey } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useOnline, useOpenOrders, useOpenShift, useOrder, useOutboxCounts } from '@bestie/offline';
import { billConfigFor, usePosData } from './posData';
import type { PosTable } from './posData';
import { changeOrder, mergeBills, payCash, splitBill } from './orderActions';
import { SplitSheet } from './SplitSheet';
import { LoadFailed, Loading, Page } from './PosBits';
import { ModifierSheet } from './ModifierSheet';
import { ManagerVoid } from './ManagerVoid';
import { OrderCustomer } from './OrderCustomer';
import { PaySheet } from './PaySheet';
import { useSplitInfo } from './useSplitInfo';
import {
  cancelOnlinePayment,
  closeSplitPayment,
  findLiveAttempt,
  finishOnlinePayment,
  readAttempt,
  startOnlinePayment,
} from './onlinePay';
import type { OnlinePay } from './onlinePay';
import { usePosStore } from './posData';
import { latestTicketLines, printTickets, ticketPrinters } from './printing/kitchenPrint';

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
  const netUp = useOnline();
  const [ticketNote, setTicketNote] = useState<{
    kind: 'info' | 'error' | 'success';
    text: string;
  } | null>(null);
  const [cat, setCat] = useState('');
  const [scan, setScan] = useState('');
  const [scanNote, setScanNote] = useState<{ kind: 'info' | 'success'; text: string } | null>(null);
  const scanBox = useRef<HTMLInputElement>(null);
  const [picking, setPicking] = useState<{ item: Item; groups: OrderGroupInput[] } | null>(null);
  const [paying, setPaying] = useState(false);
  // PromptPay / card shares already paid and held on this bill (the bill is locked until it closes or a manager releases them)
  const [heldTotal, setHeldTotal] = useState(0);
  // ...and whether all of it is a DEPOSIT taken before the visit (that does not lock the bill, and "give up" is not for it)
  const [heldDeposit, setHeldDeposit] = useState(false);
  useEffect(() => {
    if (!paying) return;
    let alive = true;
    void (async () => {
      try {
        const r = await ctx.client
          .from('order_partial_payments')
          .select('amount, kind')
          .eq('order_id', orderId)
          .eq('status', 'held');
        if (alive && !r.error && Array.isArray(r.data)) {
          const rows = r.data as { amount: number; kind?: string }[];
          setHeldTotal(rows.reduce((a, x) => a + Number(x.amount), 0));
          setHeldDeposit(rows.length > 0 && rows.every((x) => x.kind === 'deposit'));
        }
      } catch {
        /* offline: the pay sheet then opens as for a bill with nothing held, and the server refuses anything that does not add up */
      }
    })();
    return () => {
      alive = false;
    };
  }, [paying, ctx.client, orderId]);
  const splitInfo = useSplitInfo(ctx, orderId, netUp, paying);
  const [splitting, setSplitting] = useState(false);
  const [mergeInto, setMergeInto] = useState('');
  const { binding } = usePosStore(ctx);
  const shift = useOpenShift(binding?.deviceId ?? null);
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
  const canPay =
    open && (ctx.isOwner || ctx.permissions.includes('payment.take')) && binding !== null;
  const bill = orderBill(order, billConfigFor(config, order.channel));
  const tableName = tables.find((x) => x.id === order.tableId)?.name;
  const takenTables = new Set(openOrders.filter((o) => o.id !== order.id).map((o) => o.tableId));
  const freeTables: PosTable[] = tables.filter(
    (x) => !takenTables.has(x.id) && x.id !== order.tableId,
  );

  const siblings = openOrders.filter(
    (o) => o.id !== order.id && o.tableId !== null && o.tableId === order.tableId,
  );
  const mergeCandidates = openOrders.filter(
    (o) => o.id !== order.id && o.storeId === order.storeId,
  );
  const lineCount = liveLines(order).reduce((a, l) => a + l.quantity, 0);

  /** Print the kitchen / bar tickets for these lines on the shop's ticket printers. Never blocks the order; says what happened. */
  const printLines = async (o: OrderDoc, lines: LineDoc[], quiet: boolean) => {
    if (lines.length === 0) return;
    const printers = await ticketPrinters(ctx.client, o.storeId);
    if (printers.length === 0) {
      if (!quiet) setTicketNote({ kind: 'info', text: t.ticketNoPrinter });
      return;
    }
    const results = await printTickets({
      order: o,
      lines,
      printers,
      tableName: tables.find((x) => x.id === o.tableId)?.name ?? null,
    });
    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0)
      setTicketNote({
        kind: 'error',
        text: failed.map((r) => fmt(t.ticketFailed, { name: r.printer.name })).join(' '),
      });
    else if (results.length > 0 && !quiet)
      setTicketNote({ kind: 'success', text: t.ticketPrinted });
    else setTicketNote(null);
  };
  const printLatest = async (quiet: boolean) => {
    setTicketNote(null);
    await printLines(order, latestTicketLines(order), quiet);
  };
  const sendToKitchen = async () => {
    setError(null);
    setTicketNote(null);
    let sent: LineDoc[] = [];
    const err = await changeOrder(order.id, (o) => {
      const r = sendNew(o, Date.now());
      sent = r.sent;
      return r.order;
    });
    if (err) return setError(err);
    await printLines(order, sent, true);
  };

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

  // A barcode scanner types the code and presses Enter; the same box works for typing a code by hand. Works offline (the cached menu).
  const doScan = async () => {
    const code = scan;
    setScan('');
    setScanNote(null);
    const r = resolveScan(menu, code);
    if (r.kind === 'not_found') setScanNote({ kind: 'info', text: t.scanNotFound });
    else if (r.kind === 'sold_out') setScanNote({ kind: 'info', text: t.scanSoldOut });
    else if (r.kind === 'ambiguous') setScanNote({ kind: 'info', text: t.scanAmbiguous });
    else {
      const item = menu.items.find((i) => i.id === r.itemId);
      if (item) {
        const groups = item.modifier_group_ids
          .map((id) => groupInput(menu, id))
          .filter((g): g is OrderGroupInput => g !== null);
        const selected = r.optionId ? [r.optionId] : [];
        if (validateSelection(groups, selected).length > 0) {
          setPicking({ item, groups }); // other choices are still needed: the person finishes on the sheet
        } else {
          await apply((o) =>
            addLine(o, {
              lineId: crypto.randomUUID(),
              item: itemInput(item),
              groups,
              selected,
              quantity: 1,
              staffId: ctx.staffId,
            }),
          );
          setScanNote({
            kind: 'success',
            text: fmt(t.scanAdded, { name: localizedName(item.name, lang) }),
          });
        }
      }
    }
    scanBox.current?.focus();
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
      <OrderCustomer ctx={ctx} orderId={order.id} open={open} online={netUp} />
      {siblings.length > 0 ? (
        <div className="chips" role="group" aria-label={t.splitSiblings}>
          {siblings.map((o) => (
            <button
              key={o.id}
              type="button"
              className="chip"
              onClick={() => ctx.navigate(`/order/${o.id}`)}
            >
              {o.number}
            </button>
          ))}
        </div>
      ) : null}
      {stale ? <Notice kind="info">{t.orderStale}</Notice> : null}
      {!open ? (
        <Notice kind="info">{t.orderClosed}</Notice>
      ) : !canEdit ? (
        <Notice kind="info">{t.orderReadOnly}</Notice>
      ) : null}
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}

      <div className="order-screen">
        <section className="card admin-card" aria-label={t.orderItems}>
          {canEdit ? (
            <form className="form-row" onSubmit={(e) => e.preventDefault()}>
              <label className="label" htmlFor="order-scan">
                {t.scanLabel}
              </label>
              <input
                id="order-scan"
                ref={scanBox}
                className="field tabular"
                autoComplete="off"
                maxLength={60}
                value={scan}
                onChange={(e) => setScan(e.target.value)}
              />
              <AsyncButton
                type="submit"
                variant="secondary"
                disabled={scan.trim() === ''}
                onClick={doScan}
              >
                {t.scanAdd}
              </AsyncButton>
              {scanNote ? <Notice kind={scanNote.kind}>{scanNote.text}</Notice> : null}
            </form>
          ) : null}
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
                {menuImageUrl(i.id, i.image_v) ? (
                  <img
                    className="item-pic"
                    src={menuImageUrl(i.id, i.image_v)!}
                    alt=""
                    loading="lazy"
                  />
                ) : null}
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
                  mgrVoid={
                    open && !canVoid && canEdit ? { ctx, orderId: order.id, online: netUp } : null
                  }
                  apply={apply}
                  seatsOn={canEdit}
                />
              ))}
          </ul>
          <dl className="preview-list tabular">
            <div>
              <dt>{t.previewSubtotal}</dt>
              <dd>{formatTHB(bill.discountedSubtotal + bill.pointsDiscount, locale)}</dd>
            </div>
            {bill.pointsDiscount > 0 ? (
              <div>
                <dt>{t.previewPoints}</dt>
                <dd>−{formatTHB(bill.pointsDiscount, locale)}</dd>
              </div>
            ) : null}
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
          {!open && order.receipt ? (
            <AsyncButton onClick={() => ctx.navigate(`/receipt/${order.id}`)}>
              {t.payViewReceipt}
            </AsyncButton>
          ) : null}
          {canPay ? (
            <AsyncButton
              disabled={liveLines(order).length === 0 || bill.total === 0}
              onClick={() => setPaying(true)}
            >
              {t.payButton}
            </AsyncButton>
          ) : null}
          {canEdit ? (
            <>
              <AsyncButton variant="secondary" disabled={!hasUnsent(order)} onClick={sendToKitchen}>
                {hasUnsent(order) ? t.orderSend : t.orderSendNothing}
              </AsyncButton>
              {latestTicketLines(order).length > 0 ? (
                <AsyncButton variant="secondary" onClick={() => printLatest(false)}>
                  {t.ticketReprint}
                </AsyncButton>
              ) : null}
              {ticketNote ? <Notice kind={ticketNote.kind}>{ticketNote.text}</Notice> : null}
              {lineCount >= 2 ? (
                <AsyncButton variant="secondary" onClick={() => setSplitting(true)}>
                  {t.splitButton}
                </AsyncButton>
              ) : null}
              {mergeCandidates.length > 0 && lineCount >= 1 ? (
                <div className="form-row">
                  <label className="label" htmlFor="order-merge">
                    {t.mergeTitle}
                  </label>
                  <select
                    id="order-merge"
                    className="field"
                    value={mergeInto}
                    onChange={(e) => setMergeInto(e.target.value)}
                  >
                    <option value="">—</option>
                    {mergeCandidates.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.number}
                        {o.tableId
                          ? ` · ${tables.find((x) => x.id === o.tableId)?.name ?? ''}`
                          : ''}
                      </option>
                    ))}
                  </select>
                  {mergeInto ? <p className="muted">{t.mergeNote}</p> : null}
                  {mergeInto ? (
                    <AsyncButton
                      variant="danger"
                      onClick={async () => {
                        const err = await mergeBills({ sourceId: order.id, targetId: mergeInto });
                        if (err) return setError(err);
                        ctx.navigate(`/order/${mergeInto}`);
                      }}
                    >
                      {t.mergeConfirm}
                    </AsyncButton>
                  ) : null}
                </div>
              ) : null}
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

      {splitting && binding ? (
        <SplitSheet
          order={order}
          onClose={() => setSplitting(false)}
          onSplit={async (picks) => {
            const r = await splitBill({ orderId: order.id, picks, binding, staffId: ctx.staffId });
            if ('error' in r) return r.error;
            setSplitting(false);
            ctx.navigate(`/order/${r.id}`);
            return null;
          }}
        />
      ) : null}
      {paying && binding ? (
        <PaySheet
          shiftBlocked={config.shiftRequired && shift === null}
          onOpenShift={() => ctx.navigate('/shift')}
          total={bill.total}
          rule={config.cashRounding}
          methods={{
            promptpay: ctx.isModuleOn?.('tender.promptpay') ?? true,
            gateway: ctx.isModuleOn?.('tender.gateway') ?? true,
          }}
          online={onlinePay(
            ctx,
            order.id,
            binding,
            billConfigFor(config, order.channel),
            config.defaultLang,
            netUp,
            () => ctx.navigate(`/receipt/${order.id}`),
            {
              rule: config.cashRounding,
              creditBalance: splitInfo.data ? splitInfo.data.balance : null,
            },
          )}
          onClose={() => setPaying(false)}
          splitCredit={
            splitInfo.data ? { name: splitInfo.data.name, balance: splitInfo.data.balance } : null
          }
          held={heldTotal}
          heldDeposit={heldDeposit}
          onRelease={
            !heldDeposit && (ctx.isOwner || ctx.permissions.includes('refund.create'))
              ? async () => {
                  const { error: e } = await ctx.client.rpc('release_partial_payments', {
                    p_order: order.id,
                    p_note: null,
                  });
                  if (e) return e.code === '42501' ? 'err_forbidden' : 'err_pay_failed';
                  setHeldTotal(0);
                  setPaying(false);
                  return null;
                }
              : undefined
          }
          onSplitPay={async (legs, heldNow) => {
            const err = await closeSplitPayment({
              client: ctx.client,
              orderId: order.id,
              binding,
              billConfig: billConfigFor(config, order.channel),
              rule: config.cashRounding,
              legs,
              held: heldNow,
              creditBalance: splitInfo.data ? splitInfo.data.balance : null,
              staffId: ctx.staffId,
              lang: config.defaultLang,
            });
            if (!err) ctx.navigate(`/receipt/${order.id}`);
            return err;
          }}
          onPay={async (tendered) => {
            const err = await payCash({
              orderId: order.id,
              tendered,
              binding,
              billConfig: billConfigFor(config, order.channel),
              roundingRule: config.cashRounding,
              seller: {
                sellerName: config.sellerName,
                sellerTaxId: config.sellerTaxId,
                branchCode: config.branchCode,
                vatRegistered: config.vatRegistered,
              },
              staffId: ctx.staffId,
              staffName: ctx.staffName,
              lang: config.defaultLang,
            });
            if (!err) ctx.navigate(`/receipt/${order.id}`);
            return err;
          }}
        />
      ) : null}
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
  mgrVoid,
  apply,
  seatsOn,
}: {
  line: LineDoc;
  locale: 'th-TH' | 'en-GB';
  canEdit: boolean;
  canVoid: boolean;
  /** Set for people who cannot void on their own: a manager's PIN approves it instead. */
  mgrVoid: { ctx: PageContext; orderId: string; online: boolean } | null;
  apply: (fn: (o: OrderDoc) => OrderDoc) => Promise<void>;
  seatsOn: boolean;
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
      {seatsOn ? (
        <div className="form-row">
          <label className="label" htmlFor={`seat-${line.id}`}>
            {fmt(t.orderSeat, { name })}
          </label>
          <select
            id={`seat-${line.id}`}
            className="field"
            value={line.seat ?? ''}
            onChange={(e) => {
              const v = e.target.value; // read NOW (the select is controlled)
              void apply((o) => setSeat(o, line.id, v === '' ? null : Number(v)));
            }}
          >
            <option value="">{t.orderSeatNone}</option>
            {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
      ) : null}
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
          ) : mgrVoid && !isNew && line.status !== 'void' ? (
            <ManagerVoid
              ctx={mgrVoid.ctx}
              orderId={mgrVoid.orderId}
              lineId={line.id}
              online={mgrVoid.online}
            />
          ) : null}
        </>
      )}
    </li>
  );
}

/** The online payment functions of one bill (PromptPay QR / card reader), wired to the signed-in client. */
function onlinePay(
  ctx: PageContext,
  orderId: string,
  binding: NonNullable<ReturnType<typeof usePosStore>['binding']>,
  billConfig: ReturnType<typeof billConfigFor>,
  lang: 'th' | 'en',
  available: boolean,
  done: () => void,
  split?: { rule: RoundingRule; creditBalance: Satang | null },
): OnlinePay {
  return {
    available,
    hasReader: binding.reader === true,
    start: (tender, step) =>
      startOnlinePayment({
        client: ctx.client,
        orderId,
        tender,
        binding,
        billConfig,
        staffId: ctx.staffId,
        lang,
        split:
          step && split
            ? { ...split, legs: step.legs, step: step.step, held: step.held }
            : undefined,
      }),
    cancel: (attemptId) => cancelOnlinePayment(ctx.client, attemptId),
    status: (attemptId) => readAttempt(ctx.client, attemptId),
    findLive: () => findLiveAttempt(ctx.client, orderId),
    finish: async () => {
      await finishOnlinePayment(ctx.client, orderId);
      done();
    },
  };
}
