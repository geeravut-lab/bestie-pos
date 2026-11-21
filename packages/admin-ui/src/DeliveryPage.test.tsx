import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageContext } from '@bestie/auth';
import { I18nProvider } from '@bestie/i18n';
import { fakeDb } from './fakeDb';
import { DeliveryPage } from './DeliveryPage';

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
  path: '/delivery',
  navigate: () => {},
  client: client as never,
  orgId: 'o1',
  storeId: 's1',
  permissions: ['menu.edit', 'report.view', 'payment.take'],
  isOwner: true,
  isPlatformAdmin: false,
  ...over,
});
const wrap = (ui: React.ReactNode) => render(<I18nProvider initialLang="en">{ui}</I18nProvider>);
const platforms = [
  {
    id: 'p1',
    code: 'lineman',
    name: 'LINE MAN',
    commission_bps: 3000,
    active: true,
    token_hint: 'ab12',
  },
  { id: 'p2', code: 'grab', name: 'Grab', commission_bps: 2500, active: true, token_hint: null },
];
const report = [
  {
    platform_id: 'p1',
    name: 'LINE MAN',
    code: 'lineman',
    commission_bps: 3000,
    bills: 1,
    gross: 31000,
    commission: 9300,
    net: 21700,
    paid_out: 0,
    owed: 21700,
  },
  {
    platform_id: 'p2',
    name: 'Grab',
    code: 'grab',
    commission_bps: 2500,
    bills: 2,
    gross: 20000,
    commission: 5000,
    net: 15000,
    paid_out: 10000,
    owed: 5000,
  },
];
const db = (extra: Record<string, { data?: unknown; error?: { code: string } | null }> = {}) =>
  liveDb(
    { delivery_platforms: platforms },
    { rpc: { delivery_report: { data: report }, ...extra } },
  );

describe('<DeliveryPage>', () => {
  it('lists the platforms with their commission and the end of their token', async () => {
    const d = db();
    wrap(<DeliveryPage ctx={ctx(d.client)} />);
    expect(await screen.findByText('LINE MAN', { selector: 'strong' })).toBeTruthy();
    expect(screen.getByText('30%')).toBeTruthy();
    expect(screen.getByText('The current token ends in ab12')).toBeTruthy();
    expect(screen.getByText('No intake token yet.')).toBeTruthy();
  });

  it('shows the report per platform with totals', async () => {
    const d = db();
    wrap(<DeliveryPage ctx={ctx(d.client)} />);
    const table = await screen.findByRole('table');
    expect(within(table).getByText('฿310')).toBeTruthy();
    expect(within(table).getByText('฿93')).toBeTruthy();
    expect(within(table).getAllByText('฿510').length).toBeGreaterThan(0); // total sales
    expect(within(table).getByText('฿143')).toBeTruthy(); // total kept
    expect(within(table).getByText('฿267')).toBeTruthy(); // total owed
    expect(d.rpcs.find((r) => r.fn === 'delivery_report')!.args).toMatchObject({
      p: { store_id: 's1' },
    });
  });

  it('adds a platform with the commission in basis points', async () => {
    const d = db();
    wrap(<DeliveryPage ctx={ctx(d.client)} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Add a platform' }));
    const form = screen.getByRole('form', { name: 'Add a platform' });
    await userEvent.type(within(form).getByLabelText('Name shown'), 'Robinhood');
    await userEvent.selectOptions(within(form).getByLabelText('Kind'), 'other');
    const pct = within(form).getByLabelText('What the platform keeps (%)');
    await userEvent.clear(pct);
    await userEvent.type(pct, '12.5');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(d.rpcs.some((r) => r.fn === 'save_delivery_platform')).toBe(true));
    expect(d.rpcs.find((r) => r.fn === 'save_delivery_platform')!.args).toEqual({
      p: {
        store_id: 's1',
        id: null,
        code: 'other',
        name: 'Robinhood',
        commission_bps: 1250,
        active: true,
      },
    });
  });

  it('refuses a commission above 50 percent without asking the database', async () => {
    const d = db();
    wrap(<DeliveryPage ctx={ctx(d.client)} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Add a platform' }));
    const form = screen.getByRole('form', { name: 'Add a platform' });
    await userEvent.type(within(form).getByLabelText('Name shown'), 'Greedy');
    const pct = within(form).getByLabelText('What the platform keeps (%)');
    await userEvent.clear(pct);
    await userEvent.type(pct, '60');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Those values do not work/)).toBeTruthy();
    expect(d.rpcs.some((r) => r.fn === 'save_delivery_platform')).toBe(false);
  });

  it('shows a new token once, with the address and a sample', async () => {
    const t = 'f'.repeat(64);
    const d = db({ rotate_delivery_token: { data: t } });
    wrap(<DeliveryPage ctx={ctx(d.client)} />);
    const row = (await screen.findByText('Grab', { selector: 'strong' })).closest('li')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Make a new intake token' }));
    expect(await screen.findByText(/Copy this token now/)).toBeTruthy();
    expect(
      (screen.getByLabelText('Make a new intake token', { selector: 'input' }) as HTMLInputElement)
        .value,
    ).toBe(t);
    expect(screen.getByText(/\/api\/delivery\/intake/)).toBeTruthy();
    expect(screen.getByText(/RICE-001/)).toBeTruthy();
    expect(d.rpcs.find((r) => r.fn === 'rotate_delivery_token')!.args).toEqual({
      p_platform: 'p2',
    });
  });

  it('records money the platform paid out', async () => {
    const d = db();
    wrap(<DeliveryPage ctx={ctx(d.client)} />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Record money the platform paid' }),
    );
    const form = screen.getByRole('form', { name: 'Record money the platform paid' });
    await userEvent.selectOptions(within(form).getByLabelText('Platform'), 'p2');
    await userEvent.type(within(form).getByLabelText('Amount (baht)'), '100');
    await userEvent.click(within(form).getByRole('button', { name: 'Record the payment' }));
    await waitFor(() => expect(d.rpcs.some((r) => r.fn === 'record_delivery_payout')).toBe(true));
    expect(d.rpcs.find((r) => r.fn === 'record_delivery_payout')!.args).toMatchObject({
      p: { platform_id: 'p2', amount: 10000, reference: null },
    });
  });

  it('hides setup from someone without menu.edit and money from someone without report.view', async () => {
    const d = db();
    wrap(<DeliveryPage ctx={ctx(d.client, { isOwner: false, permissions: ['order.create'] })} />);
    await screen.findByText('LINE MAN', { selector: 'strong' });
    expect(screen.queryByRole('button', { name: 'Add a platform' })).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
    expect(d.rpcs.length).toBe(0);
  });

  it('says the module is off', async () => {
    const d = db();
    wrap(<DeliveryPage ctx={ctx(d.client, { isModuleOn: () => false })} />);
    expect(await screen.findByText(/is off in this shop/)).toBeTruthy();
  });
});
