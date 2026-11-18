import { useEffect, useMemo } from 'react';
import { parseBillOptions } from '@bestie/core';
import type { BillConfig, Channel } from '@bestie/core';
import { loadMenu, useRemote } from '@bestie/admin-ui';
import type { Menu } from '@bestie/admin-ui';
import { useLiveSync } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { cachedRead, pullOrders, useDeviceBinding, useOnline } from '@bestie/offline';
import type { DeviceBinding } from '@bestie/offline';

export type PosTable = { id: string; name: string; zone: string; seats: number; sort: number };
export type PosConfig = {
  name: string;
  vatBps: number;
  serviceChargeBps: number;
  priceMode: 'inclusive' | 'exclusive';
  billOptions: ReturnType<typeof parseBillOptions>;
};
export type PosData = { menu: Menu; tables: PosTable[]; config: PosConfig; stale: boolean };

type Row = Record<string, unknown>;
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

async function loadTables(client: PageContext['client'], storeId: string): Promise<PosTable[]> {
  const r = await client
    .from('dining_tables')
    .select('id, name, zone, seats, sort, created_at')
    .eq('store_id', storeId)
    .eq('active', true)
    .is('deleted_at', null)
    .order('created_at');
  if (r.error) throw new Error('tables');
  return ((r.data ?? []) as unknown as Row[])
    .map((t) => ({
      id: String(t.id),
      name: String(t.name ?? ''),
      zone: String(t.zone ?? ''),
      seats: num(t.seats, 2),
      sort: num(t.sort),
    }))
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

async function loadConfig(client: PageContext['client'], storeId: string): Promise<PosConfig> {
  const r = await client
    .from('stores')
    .select('name, vat_registered, vat_bps, service_charge_bps, price_mode, bill_options')
    .eq('id', storeId)
    .maybeSingle();
  if (r.error || !r.data) throw new Error('store');
  const s = r.data as unknown as Row;
  return {
    name: String(s.name ?? ''),
    vatBps: s.vat_registered === true ? num(s.vat_bps) : 0,
    serviceChargeBps: num(s.service_charge_bps),
    priceMode: s.price_mode === 'exclusive' ? 'exclusive' : 'inclusive',
    billOptions: parseBillOptions(s.bill_options),
  };
}

/** Network first with the last saved copy as the fallback: the till opens and sells with no signal. */
export async function loadPosData(
  client: PageContext['client'],
  storeId: string,
): Promise<PosData> {
  const [menu, tables, config] = await Promise.all([
    cachedRead(`menu:${storeId}`, () => loadMenu(client, storeId)),
    cachedRead(`tables:${storeId}`, () => loadTables(client, storeId)),
    cachedRead(`storecfg:${storeId}`, () => loadConfig(client, storeId)),
  ]);
  return {
    menu: menu.data,
    tables: tables.data,
    config: config.data,
    stale: menu.stale || tables.stale || config.stale,
  };
}

/** The shop this screen works for, and the tablet it runs on (null = not set up as a till). */
export function usePosStore(ctx: PageContext): {
  storeId: string | null;
  binding: DeviceBinding | null;
} {
  const binding = useDeviceBinding();
  return { storeId: binding?.storeId ?? ctx.homeStoreId ?? ctx.storeId ?? null, binding };
}

/** Service charge belongs to sit-down service; a takeaway / delivery / QR-pickup bill is not charged it. */
export const billConfigFor = (c: PosConfig, channel: Channel): BillConfig => ({
  priceMode: c.priceMode,
  vatBps: c.vatBps,
  serviceChargeBps: channel === 'dine-in' ? c.serviceChargeBps : 0,
  options: c.billOptions,
});

/**
 * Menu / tables / shop settings for the till, kept fresh by the live channel, plus the pull of the shop's orders
 * (on open, on every ping, when the network returns, and every 30 s) into this tablet's working copy.
 */
export function usePosData(ctx: PageContext, storeId: string | null) {
  const online = useOnline();
  const remote = useRemote(
    () => (storeId ? loadPosData(ctx.client, storeId) : Promise.resolve(null)),
    `${ctx.orgId}:${storeId ?? ''}`,
  );
  const pull = useMemo(
    () => async () => {
      if (!storeId || globalThis.navigator?.onLine === false) return;
      try {
        await pullOrders(ctx.client, storeId);
      } catch (e) {
        console.error('[pos] order pull failed', e instanceof Error ? e.message : 'unknown');
      }
    },
    [ctx.client, storeId],
  );
  const refresh = remote.reload;
  useLiveSync(ctx.client, storeId ? [`store:${storeId}`] : [], async () => {
    refresh();
    await pull();
  });
  useEffect(() => {
    void pull();
    if (!storeId) return;
    const i = setInterval(() => void pull(), 30_000);
    return () => clearInterval(i);
  }, [pull, storeId, online]);
  return remote;
}
