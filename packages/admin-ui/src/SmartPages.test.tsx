import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageContext } from '@bestie/auth';
import { I18nProvider } from '@bestie/i18n';
import { BriefPage } from './BriefPage';
import { CasesPage } from './CasesPage';
import { fakeDb } from './fakeDb';
import { ReconcilePage } from './ReconcilePage';
import { StockSmartPage } from './StockSmartPage';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
type Rpc = Record<string, { data?: unknown; error?: { code: string } | null }>;
const mount = (
  ui: (c: PageContext) => React.ReactNode,
  tables: Record<string, unknown[]> = {},
  rpc: Rpc = {},
  perms = ['report.view', 'menu.edit', 'order.create', 'stock.manage'],
  owner = true,
) => {
  const db = fakeDb(tables, { rpc });
  Object.assign(db.client as object, {
    auth: { getSession: async () => ({ data: { session: { access_token: 'jwt' } } }) },
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
  const ctx = {
    path: '/x',
    navigate: () => {},
    client: db.client as never,
    orgId: 'o1',
    storeId: 's1',
    permissions: perms,
    isOwner: owner,
    isPlatformAdmin: false,
  } as PageContext;
  render(<I18nProvider initialLang="en">{ui(ctx)}</I18nProvider>);
  return db;
};
const fc = (over: Record<string, unknown> = {}) => ({
  item_id: 'm',
  name: { th: 'นม', en: 'Milk' },
  unit: 'ml',
  quantity: 850,
  low_at: 0,
  avg_daily: 300,
  days_left: 2.8,
  on_order: 0,
  forecast: 2700,
  suggested: 1850,
  supplier_id: 'sup1',
  supplier_name: 'Dairy Co',
  last_cost: 6000,
  ...over,
});

describe('<StockSmartPage>', () => {
  it('shows what to order and makes one draft purchase order per supplier', async () => {
    const db = mount(
      (c) => <StockSmartPage ctx={c} />,
      { stock_items: [{ id: 'm', name: { th: 'นม', en: 'Milk' }, unit: 'ml' }], stock_batches: [] },
      {
        stock_forecast: {
          data: [
            fc(),
            fc({
              item_id: 'e',
              name: { th: 'ไข่', en: 'Eggs' },
              supplier_id: null,
              supplier_name: null,
              suggested: 40,
            }),
          ],
        },
        waste_report: { data: { total: 0, by_reason: [], by_item: [] } },
        save_purchase_order: { data: 'po1' },
      },
    );
    expect(await screen.findByText('1850')).toBeTruthy();
    await userEvent.click(
      screen.getByRole('button', { name: 'Make draft purchase orders from these suggestions' }),
    );
    await waitFor(() =>
      expect(db.rpcs.filter((c) => c.fn === 'save_purchase_order').length).toBe(1),
    );
    const args = db.rpcs.find((c) => c.fn === 'save_purchase_order')!.args as {
      p: { supplier_id: string; lines: { quantity: number; cost_per_1000: number }[] };
    };
    expect(args.p.supplier_id).toBe('sup1');
    expect(args.p.lines).toEqual([{ item_id: 'm', quantity: 1850, cost_per_1000: 6000 }]);
    expect(await screen.findByText(/1 draft purchase orders made/)).toBeTruthy();
    expect(screen.getByText(/No supplier used before .*: Eggs/)).toBeTruthy();
  });

  it('shows waste by reason and lots with the days left', async () => {
    mount(
      (c) => <StockSmartPage ctx={c} />,
      {
        stock_items: [{ id: 'm', name: { th: 'นม', en: 'Milk' }, unit: 'ml' }],
        stock_batches: [
          { id: 'b1', item_id: 'm', qty: 500, expires_on: '2099-01-01', code: 'L-1' },
        ],
      },
      {
        stock_forecast: { data: [] },
        waste_report: {
          data: {
            total: 1200,
            by_reason: [
              { reason: 'expired', cost: 800, qty: 1 },
              { reason: 'other', cost: 400, qty: 1 },
            ],
            by_item: [
              { item_id: 'm', name: { th: 'นม', en: 'Milk' }, unit: 'ml', qty: 150, cost: 1200 },
            ],
          },
        },
      },
    );
    await userEvent.click(await screen.findByRole('tab', { name: 'Waste' }));
    expect(await screen.findByText('Expired:', { exact: false })).toBeTruthy();
    expect(screen.getAllByText('฿12').length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('tab', { name: 'Lots and expiry' }));
    expect(await screen.findByText(/L-1/)).toBeTruthy();
  });

  it('a person with no stock permission is turned away', () => {
    mount((c) => <StockSmartPage ctx={c} />, {}, {}, ['order.create'], false);
    expect(screen.getByText('This page needs permission to see stock.')).toBeTruthy();
  });
});

describe('<CasesPage>', () => {
  const tables = {
    service_cases: [
      {
        id: 'c1',
        source: 'feedback',
        summary: '1/5 · food · cold soup',
        status: 'open',
        sla_min: 15,
        created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      },
    ],
    staff: [{ id: 'st1', display_name: 'Nok' }],
  };
  it('takes a case, and closes it only with a note', async () => {
    const db = mount((c) => <CasesPage ctx={c} />, tables, {
      case_kpi: {
        data: {
          cases: 3,
          answered: 2,
          avg_first_response_sec: 180,
          avg_resolution_sec: 1800,
          confirmed: 1,
          late: 1,
        },
      },
    });
    expect(await screen.findByText('1/5 · food · cold soup')).toBeTruthy();
    expect(screen.getByText(/10 minutes left to answer/)).toBeTruthy();
    expect(screen.getByText(/Average time to answer 3 min/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Take it' }));
    await waitFor(() => expect(db.rpcs.some((c) => c.fn === 'case_ack')).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: 'Close the case' }));
    await userEvent.type(screen.getByLabelText('What was done'), 'new soup');
    await userEvent.click(screen.getByLabelText('The guest confirmed it is fixed'));
    await userEvent.click(screen.getAllByRole('button', { name: 'Close the case' }).at(-1)!);
    await waitFor(() => expect(db.rpcs.some((c) => c.fn === 'case_resolve')).toBe(true));
    expect(db.rpcs.find((c) => c.fn === 'case_resolve')!.args).toEqual({
      p_id: 'c1',
      p_note: 'new soup',
      p_confirmed: true,
    });
  });
  it('opens a case by hand', async () => {
    const db = mount((c) => <CasesPage ctx={c} />, { service_cases: [], staff: [] });
    await userEvent.click(await screen.findByRole('button', { name: 'Open a case' }));
    await userEvent.type(screen.getByLabelText('What happened'), 'Table 4 waits');
    await userEvent.click(screen.getAllByRole('button', { name: 'Open a case' }).at(-1)!);
    await waitFor(() => expect(db.rpcs.some((c) => c.fn === 'open_case')).toBe(true));
    expect(db.rpcs.find((c) => c.fn === 'open_case')!.args).toEqual({
      p: { store_id: 's1', summary: 'Table 4 waits', sla_min: 15 },
    });
  });
});

describe('<BriefPage>', () => {
  const ctx = {
    insights: [
      {
        id: 'i1',
        kind: 'low_stock',
        severity: 'act',
        status: 'new',
        evidence: {
          items: [
            {
              name: { th: 'นม', en: 'Milk' },
              unit: 'ml',
              quantity: 850,
              days_left: 2.8,
              suggested: 1850,
            },
          ],
        },
        action: { type: 'draft_po' },
        created_at: 'x',
      },
      { id: 'i2', kind: 'sales_drop', severity: 'watch', status: 'dismissed', evidence: {} },
    ],
  };
  it('shows the finding with its evidence and approves it', async () => {
    const db = mount(
      (c) => <BriefPage ctx={c} />,
      {},
      {
        brief_context: { data: ctx },
        decide_insight: { data: { status: 'approved', purchase_orders: ['po1'] } },
      },
    );
    expect(await screen.findByText('Milk: 850 ml left, about 2.8 days; order 1850')).toBeTruthy();
    await userEvent.click(
      screen.getByRole('button', { name: 'Approve (make draft purchase orders)' }),
    );
    await waitFor(() => expect(db.rpcs.some((c) => c.fn === 'decide_insight')).toBe(true));
    expect(db.rpcs.find((c) => c.fn === 'decide_insight')!.args).toEqual({
      p_id: 'i1',
      p_decision: 'approved',
    });
    expect(await screen.findByText('1 draft purchase orders made')).toBeTruthy();
  });
  it('asks the server for the AI summary and shows numbers it could not verify', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ available: true, summary: 'Milk is low.', unverified: ['777'], facts: '' }),
      ),
    );
    mount((c) => <BriefPage ctx={c} />, {}, { brief_context: { data: ctx } });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Explain this morning with AI' }),
    );
    expect(await screen.findByText('Milk is low.')).toBeTruthy();
    expect(screen.getByText(/not in the evidence: 777/)).toBeTruthy();
  });
  it('explains that the module is off', async () => {
    mount((c) => <BriefPage ctx={c} />, {}, { brief_context: { error: { code: '42501' } } });
    expect(await screen.findByText(/Switch on the module/)).toBeTruthy();
  });
});

describe('<ReconcilePage>', () => {
  it('runs the check and lists every kind of difference, disputes and refunds', async () => {
    const f = vi.fn(async () =>
      Response.json({
        available: true,
        provider: 'stripe',
        result: {
          matched: 4,
          providerTotal: 50000,
          bestieTotal: 49000,
          needsReview: [],
          missingInBestie: [{ providerRef: 'pi_9', amount: 300, currency: 'thb', createdMs: 0 }],
          missingAtProvider: [],
          amountDiffers: [
            {
              bestie: { providerRef: 'pi_2', orderNumber: 'A002', amount: 5000 },
              provider: { providerRef: 'pi_2', amount: 4000 },
            },
          ],
        },
        disputes: [
          {
            dispute_ref: 'dp_1',
            payment_ref: 'pi_1',
            amount: 10000,
            reason: 'fraudulent',
            status: 'needs_response',
          },
        ],
        refunds: [{ refund_ref: 're_1', amount: 5000, order_number: 'A001' }],
      }),
    );
    vi.stubGlobal('fetch', f);
    mount((c) => <ReconcilePage ctx={c} />);
    await userEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(await screen.findByText('4 payments match', { exact: false })).toBeTruthy();
    expect(screen.getByText('pi_9')).toBeTruthy();
    expect(screen.getByText(/Bestie ฿50 · Provider ฿40/)).toBeTruthy();
    expect(screen.getByText(/฿100 · fraudulent · status needs_response/)).toBeTruthy();
    expect(screen.getByText('re_1')).toBeTruthy();
    expect((f.mock.calls as unknown as [string][])[0]![0]).toMatch(
      /^\/api\/payments\/reconcile\?store=s1&from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/,
    );
  });
  it('says so when everything matches, and when the provider cannot list payments', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          available: true,
          provider: 'stripe',
          result: {
            matched: 2,
            providerTotal: 1,
            bestieTotal: 1,
            needsReview: [],
            missingInBestie: [],
            missingAtProvider: [],
            amountDiffers: [],
          },
          disputes: [],
          refunds: [],
        }),
      ),
    );
    mount((c) => <ReconcilePage ctx={c} />);
    await userEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(await screen.findByText('Every payment matches.')).toBeTruthy();
    cleanup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ available: false, disputes: [], refunds: [] })),
    );
    mount((c) => <ReconcilePage ctx={c} />);
    await userEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(await screen.findByText(/cannot list payments to compare/)).toBeTruthy();
  });
});
