import {
  OrderError,
  buildCashReceipt,
  mergeOrders,
  setLinesStatus,
  statusPayload,
  movePayload,
  orderToRow,
  splitOrder,
  closeOrder,
  hasUnsent,
  newOrder,
  orderBill,
  payBlockers,
  sendNew,
} from '@bestie/core';
import type {
  BillConfig,
  Channel,
  KitchenStatus,
  Lang,
  OrderDoc,
  RoundingRule,
  SplitPick,
} from '@bestie/core';
import type { ErrorKey } from '@bestie/i18n';
import {
  getOrder,
  listShopOrders,
  nextOrderNumber,
  nextReceiptNumber,
  payOrder,
  saveOrder,
  saveOrders,
} from '@bestie/offline';
import type { DeviceBinding } from '@bestie/offline';

/** Open a new order on this tablet: numbered A001…, saved locally first, queued for the server. Returns its id. */
export async function openOrder(p: {
  binding: DeviceBinding;
  staffId?: string;
  channel: Channel;
  tableId?: string | null;
}): Promise<string> {
  const now = Date.now();
  const doc = newOrder({
    id: crypto.randomUUID(),
    orgId: p.binding.orgId,
    storeId: p.binding.storeId,
    number: await nextOrderNumber(p.binding.storeId, p.binding.code, now),
    channel: p.channel,
    tableId: p.tableId ?? null,
    openedBy: p.staffId ?? null,
    deviceId: p.binding.deviceId,
    now,
  });
  await saveOrder(null, doc, () => now);
  return doc.id;
}

let chain: Promise<unknown> = Promise.resolve();

/**
 * Change an order. Always starts from the CURRENT saved copy (not what the screen last rendered) and runs one change at a
 * time, so two quick taps can never overwrite each other. Returns an error key, or null when it worked.
 */
export function changeOrder(id: string, fn: (o: OrderDoc) => OrderDoc): Promise<ErrorKey | null> {
  const run = async (): Promise<ErrorKey | null> => {
    try {
      const fresh = await getOrder(id);
      if (!fresh) return 'err_order_failed';
      await saveOrder(fresh, fn(fresh));
      return null;
    } catch (e) {
      if (e instanceof OrderError)
        return e.code === 'closed'
          ? 'err_order_closed'
          : e.code === 'selection'
            ? 'err_order_selection'
            : 'err_order_failed';
      console.error('[pos] order change failed', e instanceof Error ? e.message : 'unknown');
      return 'err_order_failed';
    }
  };
  const next = chain.then(run, run);
  chain = next;
  return next;
}

/**
 * Take CASH for a bill: anything new is sent to the kitchen / bar first, the receipt is numbered from this device's series,
 * and the paid bill + the one server call that closes it are saved on the tablet in a single step (works with no signal).
 * Runs in the same one-at-a-time lane as every other change to an order.
 */
export function payCash(p: {
  orderId: string;
  tendered: number;
  binding: DeviceBinding;
  billConfig: BillConfig;
  roundingRule: RoundingRule;
  seller: {
    sellerName: string;
    sellerTaxId: string | null;
    branchCode: string;
    vatRegistered: boolean;
  };
  staffId?: string;
  staffName?: string;
  lang: Lang;
}): Promise<ErrorKey | null> {
  const run = async (): Promise<ErrorKey | null> => {
    try {
      const fresh = await getOrder(p.orderId);
      if (!fresh) return 'err_order_failed';
      if (payBlockers(fresh).some((b) => b !== 'unsent'))
        return fresh.status === 'paid' ? 'err_order_closed' : 'err_pay_failed';
      const now = Date.now();
      const sent = hasUnsent(fresh) ? sendNew(fresh, now).order : fresh;
      const receipt = buildCashReceipt({
        order: sent,
        bill: orderBill(sent, p.billConfig),
        billConfig: p.billConfig,
        roundingRule: p.roundingRule,
        tendered: p.tendered,
        number: await nextReceiptNumber(p.binding.deviceId, p.binding.code),
        paymentId: crypto.randomUUID(),
        seller: { ...p.seller, posId: p.binding.posId, staffName: p.staffName ?? null },
        lang: p.lang,
        now,
      });
      await payOrder(fresh, closeOrder(sent, receipt), receipt, {
        deviceId: p.binding.deviceId,
        deviceCode: p.binding.code,
        staffId: p.staffId ?? null,
      });
      return null;
    } catch (e) {
      if (e instanceof OrderError)
        return e.code === 'closed' ? 'err_order_closed' : 'err_order_failed';
      console.error('[pos] payment failed', e instanceof Error ? e.message : 'unknown');
      return 'err_pay_failed';
    }
  };
  const next = chain.then(run, run);
  chain = next;
  return next;
}

/**
 * Split picked lines (or part of a line's quantity) off a bill into a NEW bill on the same table. The new bill's number comes
 * from this device's series; the server moves the lines itself (`move_order_lines`), so only the new bill's header and that one
 * call are queued. Returns the new bill's id, or an error key.
 */
export function splitBill(p: {
  orderId: string;
  picks: SplitPick[];
  binding: DeviceBinding;
  staffId?: string;
}): Promise<{ id: string } | { error: ErrorKey }> {
  const run = async (): Promise<{ id: string } | { error: ErrorKey }> => {
    try {
      const fresh = await getOrder(p.orderId);
      if (!fresh) return { error: 'err_order_failed' };
      const now = Date.now();
      const r = splitOrder(fresh, p.picks, {
        newOrderId: crypto.randomUUID(),
        newNumber: await nextOrderNumber(p.binding.storeId, p.binding.code, now),
        newLineId: () => crypto.randomUUID(),
        openedBy: p.staffId ?? null,
        deviceId: p.binding.deviceId,
        now,
      });
      await saveOrders(
        [r.source, r.target],
        [
          { kind: 'insert', table: 'orders', values: orderToRow({ ...r.target, lines: [] }) },
          {
            kind: 'rpc',
            fn: 'move_order_lines',
            args: movePayload(fresh.id, r.target.id, r.moves),
          },
        ],
        () => now,
      );
      return { id: r.target.id };
    } catch (e) {
      if (e instanceof OrderError)
        return { error: e.code === 'closed' ? 'err_order_closed' : 'err_split_failed' };
      console.error('[pos] split failed', e instanceof Error ? e.message : 'unknown');
      return { error: 'err_split_failed' };
    }
  };
  const next = chain.then(run, run);
  chain = next;
  return next;
}

/** Move every line of one bill into another and close the empty one. */
export function mergeBills(p: { sourceId: string; targetId: string }): Promise<ErrorKey | null> {
  const run = async (): Promise<ErrorKey | null> => {
    try {
      const [source, target] = await Promise.all([getOrder(p.sourceId), getOrder(p.targetId)]);
      if (!source || !target) return 'err_order_failed';
      const r = mergeOrders(source, target);
      await saveOrders(
        [r.source, r.target],
        [
          {
            kind: 'rpc',
            fn: 'move_order_lines',
            args: movePayload(source.id, target.id, r.moves, true),
          },
        ],
      );
      return null;
    } catch (e) {
      if (e instanceof OrderError)
        return e.code === 'closed' ? 'err_order_closed' : 'err_split_failed';
      console.error('[pos] merge failed', e instanceof Error ? e.message : 'unknown');
      return 'err_split_failed';
    }
  };
  const next = chain.then(run, run);
  chain = next;
  return next;
}

/**
 * Move lines through the kitchen (sent → ready → served, or the one-step undo). The tablet's copy changes at once and ONE
 * `set_lines_status` call is queued, so a bump works with no signal and is applied in order when the network returns.
 */
export function bumpLines(p: {
  storeId: string;
  lineIds: readonly string[];
  status: KitchenStatus;
  sinceDate: string;
}): Promise<ErrorKey | null> {
  const run = async (): Promise<ErrorKey | null> => {
    try {
      const orders = await listShopOrders(p.storeId, p.sinceDate);
      const changed = setLinesStatus(orders, p.lineIds, p.status);
      if (changed.length === 0) return null; // nothing could move (already there, cancelled, never sent)
      await saveOrders(changed, [
        { kind: 'rpc', fn: 'set_lines_status', args: statusPayload(p.lineIds, p.status) },
      ]);
      return null;
    } catch (e) {
      console.error('[pos] bump failed', e instanceof Error ? e.message : 'unknown');
      return 'err_kds_failed';
    }
  };
  const next = chain.then(run, run);
  chain = next;
  return next;
}
