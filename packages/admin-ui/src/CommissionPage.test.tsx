import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageContext } from '@bestie/auth';
import { I18nProvider } from '@bestie/i18n';
import { CommissionPage } from './CommissionPage';
import { fakeDb } from './fakeDb';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const REPORT = {
  range: { from: '2026-11-01', to: '2026-11-30' },
  rows: [
    {
      staff_id: 'st1',
      name: 'Nok',
      store_id: 's1',
      service_sales: 100000,
      product_sales: 20000,
      service_bps: 2000,
      product_bps: 500,
      commission: 21000,
    },
    {
      staff_id: 'st2',
      name: 'Mai',
      store_id: 's1',
      service_sales: 50000,
      product_sales: 0,
      service_bps: 1000,
      product_bps: 0,
      commission: 5000,
    },
  ],
};
const tables = () => ({
  stores: [{ id: 's1', name: 'Salon' }],
  staff: [
    { id: 'st1', display_name: 'Nok' },
    { id: 'st2', display_name: 'Mai' },
  ],
  commission_rates: [
    { staff_id: null, service_bps: 1000, product_bps: 500 },
    { staff_id: 'st1', service_bps: 2000, product_bps: 500 },
  ],
  staff_tips: [
    { id: 't1', staff_id: 'st1', amount: 5000, method: 'cash', status: 'owed', created_at: 'x' },
    {
      id: 't2',
      staff_id: 'st1',
      amount: 3000,
      method: 'promptpay',
      status: 'owed',
      created_at: 'x',
    },
  ],
  devices: [{ id: 'd1', name: 'Counter' }],
});
const ctx = (client: unknown, over: Partial<PageContext> = {}): PageContext => ({
  path: '/commission',
  navigate: () => {},
  client: client as never,
  orgId: 'o1',
  storeId: 's1',
  permissions: ['report.view', 'staff.manage', 'refund.create'],
  isOwner: false,
  isPlatformAdmin: false,
  isModuleOn: () => true,
  ...over,
});
const db = (over = {}) =>
  fakeDb(tables(), { rpc: { commission_report: { data: REPORT } }, ...over });
const mount = (c: PageContext) =>
  render(
    <I18nProvider initialLang="en">
      <CommissionPage ctx={c} />
    </I18nProvider>,
  );

describe('<CommissionPage>', () => {
  it('says so when the module is off, and refuses people without report.view', async () => {
    mount(ctx(db().client, { isModuleOn: () => false }));
    expect(await screen.findByText(/commission module is off/)).toBeTruthy();
    cleanup();
    mount(ctx(db().client, { permissions: [] }));
    expect(await screen.findByText(/permission/i)).toBeTruthy();
  });

  it('lists each person with sales, rates and commission, and the total', async () => {
    mount(ctx(db().client));
    const nok = (await screen.findByText('Nok', { selector: 'td' })).closest('tr')!;
    expect(within(nok).getByText('฿1,000')).toBeTruthy();
    expect(within(nok).getByText('฿200')).toBeTruthy();
    expect(within(nok).getByText('20% / 5%')).toBeTruthy();
    expect(within(nok).getByText('฿210')).toBeTruthy();
    const foot = screen.getByText('Total').closest('tr')!;
    expect(within(foot).getByText('฿260')).toBeTruthy(); // 210 + 50
  });

  it('asks the database for the chosen period and shop', async () => {
    const d = db();
    mount(ctx(d.client));
    await screen.findByText('Nok', { selector: 'td' });
    const call = d.rpcs.find((c) => c.fn === 'commission_report')!;
    expect(call.args).toMatchObject({ p: { org_id: 'o1', store_id: 's1' } });
    expect((call.args as { p: { from: string; to: string } }).p.from).toMatch(/^\d{4}-\d{2}-01$/); // this month
  });

  it('exports a CSV and writes the export into the audit trail', async () => {
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:x'),
      revokeObjectURL: vi.fn(),
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const d = db();
    mount(ctx(d.client));
    await screen.findByText('Nok', { selector: 'td' });
    await userEvent.click(screen.getByRole('button', { name: 'Download CSV' }));
    await waitFor(() => expect(d.rpcs.some((c) => c.fn === 'write_audit')).toBe(true));
    expect(click).toHaveBeenCalled();
    expect(d.rpcs.find((c) => c.fn === 'write_audit')!.args).toMatchObject({
      p_action: 'export.report',
      p_entity: 'commission_report',
    });
    vi.unstubAllGlobals();
  });

  it('shows the rates and sets one: percent in, basis points out', async () => {
    const d = db();
    mount(ctx(d.client));
    expect(await screen.findByText(/Shop default/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Set a rate' }));
    await userEvent.selectOptions(screen.getByLabelText('Applies to'), 'st2');
    const svc = screen.getByLabelText('Services (%)');
    await userEvent.clear(svc);
    await userEvent.type(svc, '12.5');
    const prod = screen.getByLabelText('Products (%)');
    await userEvent.clear(prod);
    await userEvent.type(prod, '7');
    await userEvent.click(screen.getByRole('button', { name: 'Save the rate' }));
    await waitFor(() => expect(d.rpcs.some((c) => c.fn === 'set_commission_rate')).toBe(true));
    expect(d.rpcs.find((c) => c.fn === 'set_commission_rate')!.args).toEqual({
      p: { store_id: 's1', staff_id: 'st2', service_bps: 1250, product_bps: 700 },
    });
  });

  it('refuses a rate above 100 % before anything is sent', async () => {
    const d = db();
    mount(ctx(d.client));
    await userEvent.click(await screen.findByRole('button', { name: 'Set a rate' }));
    const svc = screen.getByLabelText('Services (%)');
    await userEvent.clear(svc);
    await userEvent.type(svc, '101');
    await userEvent.click(screen.getByRole('button', { name: 'Save the rate' }));
    expect(await screen.findByText(/0 to 100/)).toBeTruthy();
    expect(d.rpcs.some((c) => c.fn === 'set_commission_rate')).toBe(false);
  });

  it('tips owed per person; paying out needs the till and goes through the database function', async () => {
    const d = db();
    mount(ctx(d.client));
    const row = (await screen.findByText('฿80 owed', { exact: false })).closest('li')!;
    expect(within(row).getByText(/Nok/)).toBeTruthy();
    await userEvent.click(within(row).getByRole('button', { name: 'Pay out ฿80' }));
    expect(await screen.findByText(/Some of the information is not valid/)).toBeTruthy(); // no till picked
    expect(d.rpcs.some((c) => c.fn === 'pay_out_tips')).toBe(false);
    await userEvent.selectOptions(screen.getByLabelText('Paid in cash out of the drawer of'), 'd1');
    await userEvent.click(within(row).getByRole('button', { name: 'Pay out ฿80' }));
    await waitFor(() => expect(d.rpcs.some((c) => c.fn === 'pay_out_tips')).toBe(true));
    expect(d.rpcs.find((c) => c.fn === 'pay_out_tips')!.args).toEqual({
      p: { store_id: 's1', staff_id: 'st1', device_id: 'd1' },
    });
  });

  it('without staff.manage there are no rate controls; without refund.create no pay-out', async () => {
    mount(ctx(db().client, { permissions: ['report.view'] }));
    await screen.findByText('Nok', { selector: 'td' });
    expect(screen.queryByRole('button', { name: 'Set a rate' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Pay out/ })).toBeNull();
    expect(screen.getByText(/฿80 owed/)).toBeTruthy(); // still visible
  });
});
