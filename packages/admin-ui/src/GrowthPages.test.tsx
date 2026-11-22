import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageContext } from '@bestie/auth';
import { I18nProvider } from '@bestie/i18n';
import { fakeDb } from './fakeDb';
import { HubPage } from './HubPage';
import { MarketingLinePanel } from './MarketingLinePanel';
import { MarketingPage } from './MarketingPage';
import { StampsPage } from './StampsPage';
import { ToursPage } from './ToursPage';

afterEach(cleanup);

const mount = (
  ui: (ctx: PageContext) => React.ReactNode,
  tables: Record<string, unknown[]> = {},
  rpc: Record<string, { data?: unknown; error?: { code: string } | null }> = {},
  over: Partial<PageContext> = {},
) => {
  const db = fakeDb(tables, { rpc });
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
  const navigate = vi.fn();
  const ctx = {
    path: '/x',
    navigate,
    client: db.client as never,
    orgId: 'o1',
    storeId: 's1',
    permissions: ['report.view', 'menu.edit', 'payment.take', 'order.create'],
    isOwner: true,
    isPlatformAdmin: false,
    isModuleOn: () => true,
    ...over,
  } as PageContext;
  render(<I18nProvider initialLang="en">{ui(ctx)}</I18nProvider>);
  return { db, navigate };
};

describe('<StampsPage>', () => {
  const tables = {
    stamp_programs: [
      {
        id: 'p1',
        kind: 'stamps',
        name: { th: 'บัตร', en: 'Coffee card' },
        reward_item_id: 'i1',
        stamps_needed: 5,
        min_spend: 5000,
        active: true,
      },
      {
        id: 'p2',
        kind: 'pass',
        name: { th: 'พาส', en: 'Monthly pass' },
        reward_item_id: 'i1',
        pass_price: 30000,
        pass_days: 30,
        active: true,
      },
    ],
    menu_items: [{ id: 'i1', name: { th: 'ลาเต้', en: 'Latte' } }],
  };
  it('lists the cards with their rule, the free item and the 30-day numbers', async () => {
    mount((ctx) => <StampsPage ctx={ctx} />, tables, {
      stamps_report: {
        data: {
          stamps_given: 12,
          rewards_used: 2,
          reward_value: 12000,
          passes_sold: 1,
          passes_active: 1,
        },
      },
    });
    expect(await screen.findByText('Coffee card')).toBeTruthy();
    expect(screen.getByText(/5 stamps = 1 free item/)).toBeTruthy();
    expect(screen.getByText(/30 days · one free item a day/)).toBeTruthy();
    expect(screen.getAllByText(/Latte/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Value given away:/)).toBeTruthy();
    expect(screen.getByText(/฿120/)).toBeTruthy();
  });
  it('saves a stamp card in satang and refuses an incomplete one', async () => {
    const { db } = mount((ctx) => <StampsPage ctx={ctx} />, tables);
    await screen.findByText('Coffee card');
    await userEvent.click(screen.getByRole('button', { name: 'Add a card or pass' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Something is missing or not valid')).toBeTruthy();
    expect(db.rpcs.filter((r) => r.fn === 'save_stamp_program')).toHaveLength(0);
    await userEvent.type(screen.getByLabelText('Name (Thai)'), 'บัตรกาแฟ');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(db.rpcs.some((r) => r.fn === 'save_stamp_program')).toBe(true));
    const a = db.rpcs.find((r) => r.fn === 'save_stamp_program')!.args as {
      p: Record<string, unknown>;
    };
    expect(a.p).toMatchObject({
      store_id: 's1',
      kind: 'stamps',
      stamps_needed: 5,
      min_spend: 0,
      reward_item_id: 'i1',
    });
  });
});

describe('<ToursPage>', () => {
  const start = new Date(Date.now() + 86_400_000).toISOString();
  const tables = {
    tour_slots: [
      {
        id: 't1',
        title: { th: 'ดำน้ำ', en: 'Snorkel' },
        starts_at: start,
        duration_min: 240,
        capacity: 6,
        price: 150000,
        guide_staff_id: 'g1',
        status: 'open',
      },
    ],
    tour_bookings: [
      {
        id: 'b1',
        slot_id: 't1',
        guest_name: 'Anna',
        phone: '0833333333',
        seats: 4,
        status: 'booked',
        deposit: 0,
        order_id: null,
      },
      {
        id: 'b2',
        slot_id: 't1',
        guest_name: 'Cy',
        phone: null,
        seats: 1,
        status: 'cancelled',
        deposit: 0,
        order_id: null,
      },
    ],
    staff: [{ id: 'g1', display_name: 'Pim' }],
    devices: [{ id: 'd1' }],
  };
  it('shows seats taken (a cancelled booking does not count), the guide and the manifest', async () => {
    mount((ctx) => <ToursPage ctx={ctx} />, tables);
    expect(await screen.findByText('Snorkel')).toBeTruthy();
    expect(screen.getByText(/4\/6 seats/)).toBeTruthy();
    expect(screen.getByText(/Pim/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Guest list \(1\)/ }));
    expect(screen.getByText('Anna')).toBeTruthy();
    expect(screen.queryByText('Cy')).toBeNull();
  });
  it('books seats with a request id, checks guests in and says when the tour is full', async () => {
    const { db } = mount((ctx) => <ToursPage ctx={ctx} />, tables, {
      book_tour: { error: { code: '55000' } },
    });
    await screen.findByText('Snorkel');
    await userEvent.click(screen.getByRole('button', { name: /Guest list/ }));
    await userEvent.type(screen.getByLabelText('Guest name'), 'Ben');
    await userEvent.click(screen.getByRole('button', { name: 'Book seats' }));
    expect(await screen.findByText('Not enough seats left')).toBeTruthy();
    const a = db.rpcs.find((r) => r.fn === 'book_tour')!.args as {
      p: { seats: number; client_id: string; guest_name: string };
    };
    expect(a.p).toMatchObject({ seats: 2, guest_name: 'Ben' });
    expect(a.p.client_id).toMatch(/^[0-9a-f-]{36}$/);
    await userEvent.click(screen.getByRole('button', { name: 'Check in' }));
    await waitFor(() => expect(db.rpcs.some((r) => r.fn === 'set_tour_booking_status')).toBe(true));
    expect(db.rpcs.find((r) => r.fn === 'set_tour_booking_status')!.args).toEqual({
      p_id: 'b1',
      p_status: 'checked_in',
    });
  });
  it('opens the bill of a checked-in booking', async () => {
    const t2 = {
      ...tables,
      tour_bookings: [{ ...tables.tour_bookings[0]!, status: 'checked_in' }],
    };
    const { navigate } = mount((ctx) => <ToursPage ctx={ctx} />, t2, {
      tour_to_order: { data: 'order-9' },
    });
    await screen.findByText('Snorkel');
    await userEvent.click(screen.getByRole('button', { name: /Guest list/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Open the bill' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/order/order-9'));
  });
  it('takes a deposit in satang by PromptPay', async () => {
    const { db } = mount((ctx) => <ToursPage ctx={ctx} />, tables);
    await screen.findByText('Snorkel');
    await userEvent.click(screen.getByRole('button', { name: /Guest list/ }));
    const row = screen.getByText('Anna').closest('li')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Take a deposit' }));
    await userEvent.type(screen.getByLabelText('Amount (baht)'), '2000');
    const buttons = screen.getAllByRole('button', { name: 'Take a deposit' });
    await userEvent.click(buttons[buttons.length - 1]!);
    await waitFor(() => expect(db.rpcs.some((r) => r.fn === 'take_tour_deposit')).toBe(true));
    expect(db.rpcs.find((r) => r.fn === 'take_tour_deposit')!.args).toEqual({
      p: { booking_id: 'b1', amount: 200000, method: 'promptpay' },
    });
  });
  it('takes a CASH deposit into the drawer of the chosen till', async () => {
    const t3 = {
      ...tables,
      devices: [
        { id: 'd1', name: 'Front' },
        { id: 'd2', name: 'Pier' },
      ],
    };
    const { db } = mount((ctx) => <ToursPage ctx={ctx} />, t3);
    await screen.findByText('Snorkel');
    await userEvent.click(screen.getByRole('button', { name: /Guest list/ }));
    const row = screen.getByText('Anna').closest('li')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Take a deposit' }));
    await userEvent.selectOptions(screen.getByLabelText('Paid by'), 'cash');
    await userEvent.selectOptions(screen.getByLabelText('Put it in the drawer of'), 'd2');
    await userEvent.type(screen.getByLabelText('Amount (baht)'), '600');
    const buttons = screen.getAllByRole('button', { name: 'Take a deposit' });
    await userEvent.click(buttons[buttons.length - 1]!);
    await waitFor(() => expect(db.rpcs.some((r) => r.fn === 'take_tour_deposit')).toBe(true));
    expect(db.rpcs.find((r) => r.fn === 'take_tour_deposit')!.args).toEqual({
      p: { booking_id: 'b1', amount: 60000, method: 'cash', device_id: 'd2' },
    });
  });
  it('marks an online booking and shows what is due and what was received', async () => {
    const t4 = {
      ...tables,
      tour_bookings: [
        { ...tables.tour_bookings[0]!, source: 'online', deposit: 30000, deposit_due: 90000 },
      ],
    };
    mount((ctx) => <ToursPage ctx={ctx} />, t4);
    await screen.findByText('Snorkel');
    await userEvent.click(screen.getByRole('button', { name: /Guest list/ }));
    const row = screen.getByText('Anna').closest('li')!;
    expect(within(row).getByText('Online')).toBeTruthy();
    expect(within(row).getByText(/Deposit .*300.* of .*900/)).toBeTruthy();
  });
  it('lets a manager keep or refund the deposit of a cancelled booking (cash comes out of a till)', async () => {
    const t5 = {
      ...tables,
      tour_bookings: [{ ...tables.tour_bookings[1]!, deposit: 60000 }],
      tour_deposits: [
        { id: 'dep1', booking_id: 'b2', amount: 60000, method: 'cash', status: 'held' },
      ],
      devices: [{ id: 'd1', name: 'Front' }],
    };
    const { db } = mount((ctx) => <ToursPage ctx={ctx} />, t5);
    const sec = await screen.findByRole('region', { name: /still held/ });
    expect(within(sec).getByText('Cy')).toBeTruthy();
    await userEvent.click(within(sec).getByRole('button', { name: 'Refund the deposit' }));
    await waitFor(() => expect(db.rpcs.some((r) => r.fn === 'resolve_tour_deposit')).toBe(true));
    expect(db.rpcs.find((r) => r.fn === 'resolve_tour_deposit')!.args).toEqual({
      p: { deposit_id: 'dep1', action: 'refund', device_id: 'd1' },
    });
  });
  it('shows the booking link with its rules and replaces it on request', async () => {
    const tok = 'a'.repeat(32);
    const { db } = mount((ctx) => <ToursPage ctx={ctx} />, tables, {
      tour_link: {
        data: {
          token: tok,
          enabled: true,
          settings: {
            deposit_pct: 30,
            hold_min: 120,
            days_ahead: 60,
            notice_min: 120,
            pay_note: '',
          },
        },
      },
      rotate_tour_token: { data: 'b'.repeat(32) },
    });
    const input = (await screen.findByLabelText('The shop booking link')) as HTMLInputElement;
    expect(input.value).toContain(`/tour/${tok}`);
    await userEvent.click(screen.getByRole('button', { name: /Make a new link/ }));
    await waitFor(() => expect(db.rpcs.some((r) => r.fn === 'rotate_tour_token')).toBe(true));
    await waitFor(() =>
      expect((screen.getByLabelText('The shop booking link') as HTMLInputElement).value).toContain(
        'b'.repeat(32),
      ),
    );
  });
});

describe('<MarketingPage>', () => {
  const tables = {
    marketing_campaigns: [
      {
        id: 'c1',
        name: 'Come back',
        kind: 'winback',
        idle_days: 30,
        message: { th: 'คิดถึงนะ', en: 'We miss you' },
        active: true,
      },
    ],
  };
  it('previews how many people would get a campaign', async () => {
    mount((ctx) => <MarketingPage ctx={ctx} />, tables, {
      marketing_preview: { data: { eligible: 3, linked: 8 } },
    });
    expect(await screen.findByText('Come back')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'See how many would receive it' }));
    expect(
      await screen.findByText('3 would receive it (8 members linked and agreed in all)'),
    ).toBeTruthy();
  });
  it('shows the unsubscribe footer in the editor and refuses an empty message', async () => {
    const { db } = mount((ctx) => <MarketingPage ctx={ctx} />, tables);
    await screen.findByText('Come back');
    await userEvent.click(screen.getByRole('button', { name: 'Add a campaign' }));
    expect(screen.getByText(/Reply STOP to unsubscribe/)).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Campaign name'), 'Hello');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('The message must be 1–400 characters')).toBeTruthy();
    expect(db.rpcs.filter((r) => r.fn === 'save_marketing_campaign')).toHaveLength(0);
  });
});

describe('<MarketingLinePanel>', () => {
  it('shows the one-time code and what sending it means', async () => {
    mount(
      (ctx) => <MarketingLinePanel ctx={ctx} customerId="c9" />,
      {},
      { marketing_line_code: { data: { code: 'A1B2C3D4', minutes: 30 } } },
    );
    await userEvent.click(screen.getByRole('button', { name: 'Connect LINE for offers' }));
    expect(await screen.findByText(/A1B2C3D4/)).toBeTruthy();
    expect(screen.getByText(/Sending it means agreeing/)).toBeTruthy();
  });
  it('is hidden when the module is off', () => {
    mount(
      (ctx) => <MarketingLinePanel ctx={ctx} customerId="c9" />,
      {},
      {},
      { isModuleOn: () => false },
    );
    expect(screen.queryByRole('button', { name: 'Connect LINE for offers' })).toBeNull();
  });
});

describe('<HubPage>', () => {
  it('is for the owner only', async () => {
    mount((ctx) => <HubPage ctx={ctx} />, {}, {}, { isOwner: false });
    expect(await screen.findByText('This page is for the owner only.')).toBeTruthy();
  });
  it('shows the key once after it is made, and lists keys without any secret', async () => {
    const key = `bk_${'a'.repeat(48)}`;
    mount(
      (ctx) => <HubPage ctx={ctx} />,
      {
        api_keys: [
          {
            id: 'k1',
            name: 'Books',
            prefix: 'bk_aaaa',
            scopes: ['sales'],
            last_used_at: null,
            revoked_at: null,
          },
        ],
      },
      { create_api_key: { data: { key } }, list_webhook_endpoints: { data: [] } },
    );
    expect(await screen.findByText('Books')).toBeTruthy();
    expect(screen.getByText('Never used')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Key name (for example: accounting)'), 'Dash');
    await userEvent.click(screen.getByRole('button', { name: 'Create a key' }));
    expect(await screen.findByText(key)).toBeTruthy();
  });
  it('refuses a webhook address that is not a public https name', async () => {
    const { db } = mount(
      (ctx) => <HubPage ctx={ctx} />,
      {},
      { list_webhook_endpoints: { data: [] } },
    );
    await screen.findByText('No webhooks yet');
    await userEvent.type(screen.getByLabelText('https address'), 'https://192.168.0.5/hook');
    await userEvent.click(screen.getByRole('button', { name: 'Add a webhook' }));
    expect(await screen.findByText(/That is not valid/)).toBeTruthy();
    expect(db.rpcs.filter((r) => r.fn === 'save_webhook_endpoint')).toHaveLength(0);
  });
  it('shows the signing secret once after a webhook is added', async () => {
    mount(
      (ctx) => <HubPage ctx={ctx} />,
      {},
      {
        list_webhook_endpoints: { data: [] },
        save_webhook_endpoint: { data: { id: 'w1', secret: 'whsec_abc' } },
      },
    );
    await screen.findByText('No webhooks yet');
    await userEvent.type(screen.getByLabelText('https address'), 'https://hooks.example.com/in');
    await userEvent.click(screen.getByRole('button', { name: 'Add a webhook' }));
    expect(await screen.findByText('whsec_abc')).toBeTruthy();
  });
  it('asks the database for the accountant file with the chosen dates', async () => {
    const { db } = mount(
      (ctx) => <HubPage ctx={ctx} />,
      {},
      { list_webhook_endpoints: { data: [] }, accounting_export: { data: [] } },
    );
    await screen.findByText('No webhooks yet');
    const sec = screen.getByRole('region', { name: 'File for the accountant' });
    await userEvent.click(within(sec).getByRole('button', { name: 'Download CSV' }));
    expect(await screen.findByText('No receipts in this period')).toBeTruthy();
    const a = db.rpcs.find((r) => r.fn === 'accounting_export')!.args as {
      p: { org_id: string; from: string; to: string };
    };
    expect(a.p.org_id).toBe('o1');
    expect(a.p.from < a.p.to).toBe(true);
  });
});
