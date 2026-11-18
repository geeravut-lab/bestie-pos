import { render } from '@testing-library/react';
import { vi } from 'vitest';
import type { ReactNode } from 'react';
import { I18nProvider } from '@bestie/i18n';
import type { PageContext } from '@bestie/auth';
import { setDeviceBinding } from '@bestie/offline';

/** Test double of the Supabase client for the till screens: tables in, nothing leaves the process. */
export function posClient(tables: Record<string, unknown[]>) {
  const from = (table: string) => {
    const c: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'is', 'or', 'in', 'order', 'limit']) c[m] = () => c;
    const rows = tables[table] ?? [];
    c.maybeSingle = async () => ({ data: rows[0] ?? null, error: null });
    c.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve({ data: rows, error: null }).then(res, rej);
    return c;
  };
  const channel = () => {
    const ch = { on: () => ch, subscribe: () => ch };
    return ch;
  };
  return {
    from,
    channel,
    removeChannel: vi.fn(),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  };
}

export const STORE = 'store-1';
export const ORG = 'org-1';

export function bindTablet() {
  setDeviceBinding({
    deviceId: 'dev-1',
    storeId: STORE,
    orgId: ORG,
    name: 'Counter',
    code: 'A',
    role: 'cashier',
    station: null,
    posId: null,
  });
}

export const baseTables = () => ({
  stores: [
    {
      name: 'Acme',
      vat_registered: true,
      vat_bps: 700,
      service_charge_bps: 1000,
      price_mode: 'inclusive',
      bill_options: {},
    },
  ],
  dining_tables: [
    { id: 't1', name: 'T1', zone: 'Terrace', seats: 4, sort: 10, created_at: '1' },
    { id: 't2', name: 'T2', zone: 'Terrace', seats: 2, sort: 20, created_at: '2' },
    { id: 't3', name: 'Bar 1', zone: '', seats: 1, sort: 30, created_at: '3' },
  ],
  menu_categories: [
    { id: 'c1', name: { th: 'จานเดียว', en: 'One dish' }, sort: 10, active: true, created_at: '1' },
  ],
  menu_items: [
    {
      id: 'i1',
      category_id: 'c1',
      name: { th: 'ผัดไทย', en: 'Pad Thai' },
      prices: { base: 8000 },
      station: 'kitchen',
      modifier_group_ids: [],
      available: true,
      sort: 10,
      created_at: '1',
    },
    {
      id: 'i2',
      category_id: 'c1',
      name: { th: 'ข้าวผัด', en: 'Fried rice' },
      prices: { base: 6000 },
      station: 'kitchen',
      modifier_group_ids: ['g1'],
      available: true,
      sort: 20,
      created_at: '2',
    },
    {
      id: 'i3',
      category_id: 'c1',
      name: { th: 'ต้มยำ', en: 'Tom yum' },
      prices: { base: 9000 },
      station: 'kitchen',
      modifier_group_ids: [],
      available: false,
      sort: 30,
      created_at: '3',
    },
  ],
  modifier_groups: [
    {
      id: 'g1',
      name: { th: 'ไข่', en: 'Egg' },
      min_select: 1,
      max_select: 1,
      sort: 10,
      created_at: '1',
    },
  ],
  modifier_options: [
    {
      id: 'o1',
      group_id: 'g1',
      name: { th: 'ไข่ดาว', en: 'Fried egg' },
      price_delta: 1000,
      channel_delta: {},
      active: true,
      sort: 10,
      created_at: '1',
    },
    {
      id: 'o2',
      group_id: 'g1',
      name: { th: 'ไม่ใส่ไข่', en: 'No egg' },
      price_delta: 0,
      channel_delta: {},
      active: true,
      sort: 20,
      created_at: '2',
    },
  ],
  orders: [],
  order_lines: [],
});

export const pageCtx = (client: unknown, over: Partial<PageContext> = {}): PageContext => ({
  path: '/tables',
  navigate: vi.fn(),
  client: client as never,
  orgId: ORG,
  storeId: STORE,
  homeStoreId: STORE,
  staffId: 'staff-1',
  permissions: ['order.create', 'payment.take'],
  isOwner: false,
  isPlatformAdmin: false,
  ...over,
});

export const mountEn = (ui: ReactNode) =>
  render(<I18nProvider initialLang="en">{ui}</I18nProvider>);
