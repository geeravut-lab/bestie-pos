import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageContext } from '@bestie/auth';
import { I18nProvider } from '@bestie/i18n';
import { fakeDb } from './fakeDb';
import { HqPage } from './HqPage';

afterEach(cleanup);
const liveDb = (...args: Parameters<typeof fakeDb>) => {
  const db = fakeDb(...args);
  Object.assign(db.client as object, {
    channel: vi.fn(() => {
      const ch: Record<string, unknown> = {};
      ch.on = () => ch;
      ch.subscribe = (cb?: (s: string) => void) => {
        cb?.('SUBSCRIBED');
        return ch;
      };
      return ch;
    }),
    removeChannel: vi.fn(async () => 'ok'),
  });
  return db;
};
const ctx = (client: unknown, over: Partial<PageContext> = {}): PageContext => ({
  path: '/hq',
  navigate: () => {},
  client: client as never,
  orgId: 'o1',
  storeId: 's1',
  permissions: ['report.view'],
  isOwner: true,
  isPlatformAdmin: false,
  ...over,
});
const wrap = (ui: React.ReactNode) => render(<I18nProvider initialLang="en">{ui}</I18nProvider>);
const rep = (stores: { id: string; bills: number; payable: number }[]) => ({
  totals: {
    bills: stores.reduce((n, s) => n + s.bills, 0),
    payable: stores.reduce((n, s) => n + s.payable, 0),
    average: 20000,
  },
  by_store: stores.map((s) => ({ store_id: s.id, name: s.id, ...s })),
  by_tender: [{ tender: 'cash', amount: 300000, bills: 10 }],
  by_item: [{ name_th: 'ผัดไทย', name_en: 'Pad Thai', quantity: 7, revenue: 70000 }],
});
const shops = [
  { id: 'a', name: 'Cafe' },
  { id: 'b', name: 'Spa' },
];
function mount(over: Partial<PageContext> = {}) {
  let n = 0;
  const db = liveDb({ stores: shops });
  // the first sales_report call is this period, the second the period before
  (db.client as { rpc: unknown }).rpc = vi.fn(async (fn: string, args: unknown) => {
    (db.rpcs as { fn: string; args: unknown }[]).push({ fn, args });
    n += 1;
    return {
      data:
        n % 2 === 1
          ? rep([
              { id: 'a', bills: 10, payable: 300000 },
              { id: 'b', bills: 0, payable: 0 },
            ])
          : rep([{ id: 'a', bills: 6, payable: 200000 }]),
      error: null,
    };
  });
  wrap(<HqPage ctx={ctx(db.client, over)} />);
  return db;
}

describe('<HqPage>', () => {
  it('shows every shop with its sales, change and share, and the totals', async () => {
    mount();
    const table = await screen.findByRole('table');
    const cafe = within(table).getByText('Cafe').closest('tr')!;
    expect(within(cafe).getByText('฿3,000')).toBeTruthy();
    expect(within(cafe).getByText('+50%')).toBeTruthy();
    expect(within(cafe).getByText('100%')).toBeTruthy();
    const spa = within(table).getByText('Spa').closest('tr')!;
    expect(within(spa).getAllByText('฿0').length).toBeGreaterThan(0);
    expect(screen.getByText('Best shop: Cafe')).toBeTruthy();
    expect(screen.getByText(/No sales yet in this period: Spa/)).toBeTruthy();
    expect(screen.getByText(/Pad Thai × 7/)).toBeTruthy();
  });
  it('asks for this period and the one before, and changes both when the period changes', async () => {
    const db = mount();
    await screen.findByRole('table');
    expect(db.rpcs.filter((r) => r.fn === 'sales_report')).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'Last 7 days' }));
    await waitFor(() => expect(db.rpcs.filter((r) => r.fn === 'sales_report').length).toBe(4));
    const [a, b] = db.rpcs.filter((r) => r.fn === 'sales_report').slice(2) as {
      args: { p: { from: string; to: string; store_id: null } };
    }[];
    expect(a!.args.p.store_id).toBeNull();
    expect(Date.parse(b!.args.p.to)).toBeLessThan(Date.parse(a!.args.p.from));
  });
  it('is closed to someone without report.view', () => {
    const db = liveDb({ stores: shops });
    wrap(<HqPage ctx={ctx(db.client, { isOwner: false, permissions: ['order.create'] })} />);
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(db.rpcs).toHaveLength(0);
  });
});
