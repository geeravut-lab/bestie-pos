import { OrderError, newOrder } from '@bestie/core';
import type { Channel, OrderDoc } from '@bestie/core';
import type { ErrorKey } from '@bestie/i18n';
import { getOrder, nextOrderNumber, saveOrder } from '@bestie/offline';
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
