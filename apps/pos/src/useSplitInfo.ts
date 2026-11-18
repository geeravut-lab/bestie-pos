import { useRemote } from '@bestie/admin-ui';
import type { PageContext } from '@bestie/auth';
import { getDeviceBinding } from '@bestie/offline';

export type SplitInfo = { name: string; balance: number } | null;

/**
 * Who is on this bill and how much Bestie Credit they have in THIS shop's company. null when nobody is on the bill, the
 * shop has not switched Credit on, or there is no connection (then only cash can be split).
 */
export function useSplitInfo(ctx: PageContext, orderId: string, online: boolean, enabled: boolean) {
  return useRemote(async (): Promise<SplitInfo> => {
    if (!online || !enabled) return null;
    const storeId = getDeviceBinding()?.storeId ?? ctx.homeStoreId ?? ctx.storeId;
    if (!storeId) return null;
    const [o, s] = await Promise.all([
      ctx.client.from('orders').select('customer_id').eq('id', orderId).maybeSingle(),
      ctx.client
        .from('stores')
        .select('legal_entity_id, module_overrides')
        .eq('id', storeId)
        .maybeSingle(),
    ]);
    const cid = (o.data as { customer_id?: string | null } | null)?.customer_id;
    const store = s.data as {
      legal_entity_id: string;
      module_overrides: Record<string, unknown>;
    } | null;
    // registry: tender.credit is off for every profile; only the owner's explicit switch turns it on
    if (!cid || !store || store.module_overrides?.['tender.credit'] !== true) return null;
    const [c, bal] = await Promise.all([
      ctx.client.from('customers').select('name').eq('id', cid).maybeSingle(),
      ctx.client.rpc('credit_balance', { p_customer: cid, p_entity: store.legal_entity_id }),
    ]);
    const name = (c.data as { name?: string } | null)?.name;
    return name ? { name, balance: Number(bal.data ?? 0) } : null;
  }, `${orderId}:${online}:${enabled}`);
}
