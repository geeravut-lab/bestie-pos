import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@bestie/i18n';
import type { PageContext } from '@bestie/auth';
import { ReportsPage } from './ReportsPage';

afterEach(cleanup);

const REPORT = {
  range: { from: '2026-11-16', to: '2026-11-17' },
  totals: {
    bills: 4,
    subtotal: 53500,
    service_charge: 0,
    vat: 3501,
    rounding: 0,
    payable: 53500,
    average: 13375,
  },
  by_day: [
    { date: '2026-11-16', bills: 2, payable: 39000 },
    { date: '2026-11-17', bills: 2, payable: 14500 },
  ],
  by_hour: [{ hour: 10, bills: 2, payable: 30000 }],
  by_tender: [{ tender: 'cash', amount: 30000, bills: 2 }],
  by_item: [{ name_th: 'Pad Thai TH', name_en: 'Pad Thai', quantity: 3, revenue: 27000 }],
  by_staff: [{ staff_id: null, name: '', bills: 1, payable: 5500 }],
  by_store: [
    { store_id: 's1', name: 'Acme', bills: 3, payable: 48000 },
    { store_id: 's2', name: 'Beach', bills: 1, payable: 5500 },
  ],
};

function fakeClient(report: unknown = REPORT, reportError: { code: string } | null = null) {
  const rpc = vi.fn(async (name: string, _args?: unknown) =>
    name === 'sales_report'
      ? { data: reportError ? null : report, error: reportError }
      : name === 'credit_liability'
        ? {
            data: [
              { name: 'Acme Co', outstanding: 84000, customers: 3 },
              { name: 'Idle Co', outstanding: 0, customers: 0 },
            ],
            error: null,
          }
        : { data: null, error: null },
  );
  const from = vi.fn(() => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'is']) chain[m] = () => chain;
    chain.order = async () => ({
      data: [
        { id: 's1', name: 'Acme' },
        { id: 's2', name: 'Beach' },
      ],
      error: null,
    });
    return chain;
  });
  return { client: { from, rpc } as never, rpc };
}

const ctx = (client: unknown, over: Partial<PageContext> = {}): PageContext => ({
  path: '/reports',
  navigate: () => {},
  client: client as never,
  orgId: 'org-1',
  storeId: null,
  permissions: ['report.view'],
  isOwner: false,
  isPlatformAdmin: false,
  ...over,
});

const mount = (c: PageContext) =>
  render(
    <I18nProvider initialLang="en">
      <ReportsPage ctx={c} />
    </I18nProvider>,
  );

describe('<ReportsPage>', () => {
  it('shows totals, days and shops from the server', async () => {
    const { client, rpc } = fakeClient();
    mount(ctx(client));
    expect(await screen.findByText('฿535')).toBeTruthy();
    expect(screen.getByText('฿133.75')).toBeTruthy();
    expect(screen.getByText('2026-11-16')).toBeTruthy();
    expect(screen.getAllByText('Beach')).toHaveLength(2); // the picker and the by-shop table
    const args = rpc.mock.calls.find((c) => c[0] === 'sales_report')![1] as {
      p: { org_id: string; store_id: string | null };
    };
    expect(args.p.org_id).toBe('org-1');
    expect(args.p.store_id).toBeNull(); // all shops
  });

  it('highlights the period button whose figures are on screen, and drops it when the dates are typed', async () => {
    const { client, rpc } = fakeClient();
    mount(ctx(client));
    await screen.findByText('฿535');
    const pressed = (name: string) =>
      screen.getByRole('button', { name }).getAttribute('aria-pressed');
    expect(pressed('Today')).toBe('true'); // the page opens on today
    expect(pressed('Last 7 days')).toBe('false');
    await userEvent.click(screen.getByRole('button', { name: 'Last 7 days' }));
    await waitFor(() => expect(pressed('Last 7 days')).toBe('true'));
    expect(pressed('Today')).toBe('false'); // exactly one is lit
    await userEvent.click(screen.getByRole('button', { name: 'This month' }));
    await waitFor(() => expect(pressed('This month')).toBe('true'));
    expect(pressed('Last 7 days')).toBe('false');
    // typing a date by hand: the figures no longer belong to any quick button
    const from = screen.getAllByDisplayValue(/^\d{4}-\d{2}-\d{2}$/)[0] as HTMLInputElement;
    fireEvent.change(from, { target: { value: '2026-01-05' } });
    await waitFor(() => expect(pressed('This month')).toBe('false'));
    for (const n of ['Today', 'Yesterday', 'Last 7 days', 'Last 30 days', 'This month'])
      expect(pressed(n)).toBe('false');
    expect(rpc.mock.calls.filter((c) => c[0] === 'sales_report').length).toBeGreaterThan(2);
  });

  it('asks for one shop when picked, and switches tabs', async () => {
    const { client, rpc } = fakeClient();
    mount(ctx(client));
    await screen.findByText('฿535');
    await userEvent.selectOptions(await screen.findByLabelText('Shop'), 's2');
    await waitFor(() => {
      const last = rpc.mock.calls.filter((c) => c[0] === 'sales_report').at(-1)![1] as {
        p: { store_id: string | null };
      };
      expect(last.p.store_id).toBe('s2');
    });
    await userEvent.click(screen.getByRole('tab', { name: 'By payment' }));
    expect(await screen.findByText('Cash')).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'By staff' }));
    expect(await screen.findByText('Not recorded')).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'By item' }));
    expect(await screen.findByText('Pad Thai TH')).toBeTruthy();
  });

  it('shows unspent Credit per company (only companies that owe something)', async () => {
    const { client } = fakeClient();
    mount(ctx(client));
    const box = await screen.findByRole('region', { name: /Unspent Credit/ });
    expect(within(box).getByText('Acme Co')).toBeTruthy();
    expect(within(box).getByText('฿840')).toBeTruthy();
    expect(within(box).queryByText('Idle Co')).toBeNull();
  });

  it('exports CSV and writes the audit event', async () => {
    const { client, rpc } = fakeClient();
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    mount(ctx(client));
    await screen.findByText('฿535');
    await userEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => {
      const audit = rpc.mock.calls.find((c) => c[0] === 'write_audit');
      expect(audit).toBeTruthy();
      expect((audit![1] as { p_action: string }).p_action).toBe('export.report');
    });
  });

  it('refuses people without report.view and never asks the server', () => {
    const { client, rpc } = fakeClient();
    mount(ctx(client, { permissions: [] }));
    expect(screen.getByText('This account may not view reports.')).toBeTruthy();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('says so when nothing was sold, and shows an error with retry', async () => {
    const empty = { ...REPORT, totals: { ...REPORT.totals, bills: 0 } };
    const { client } = fakeClient(empty);
    mount(ctx(client));
    expect(await screen.findByText('No paid bills in this period.')).toBeTruthy();
    cleanup();
    const bad = fakeClient(null, { code: '42501' });
    mount(ctx(bad.client));
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});
