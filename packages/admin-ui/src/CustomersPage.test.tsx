import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@bestie/i18n';
import type { PageContext } from '@bestie/auth';
import { CustomersPage } from './CustomersPage';

afterEach(cleanup);

const ANNA = {
  id: 'c1',
  name: 'Anna Smith',
  phone: '66812345678',
  member_code: 'AB12CD34',
  balance: 8,
};

function fakeClient(
  opts: {
    found?: unknown[];
    create?: { data?: unknown; error?: { code: string } | null };
    adjust?: { error?: { code: string } | null };
    history?: unknown[];
    credit?: boolean;
    creditRows?: unknown[];
    topup?: { error?: { code: string } | null };
  } = {},
) {
  const rpc = vi.fn(async (fn: string, _args?: unknown) => {
    if (fn === 'find_customers') return { data: opts.found ?? [ANNA], error: null };
    if (fn === 'create_customer') return opts.create ?? { data: ANNA, error: null };
    if (fn === 'points_balance') return { data: 8, error: null };
    if (fn === 'adjust_points') return { data: 58, error: opts.adjust?.error ?? null };
    if (fn === 'credit_balance') return { data: 84000, error: null };
    if (fn === 'topup_credit')
      return { data: { balance: 184000 }, error: opts.topup?.error ?? null };
    if (fn === 'adjust_credit') return { data: 90000, error: null };
    return { data: null, error: null };
  });
  const from = vi.fn((table: string) => {
    const c: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order']) c[m] = () => c;
    c.maybeSingle = async () => ({
      data: {
        id: 's1',
        legal_entity_id: 'e1',
        module_overrides: opts.credit ? { 'tender.credit': true } : {},
      },
      error: null,
    });
    c.limit = async () =>
      table === 'credit_ledger'
        ? {
            data: opts.creditRows ?? [
              {
                id: 'k1',
                kind: 'topup',
                amount: 100000,
                reason: null,
                created_at: '2026-11-18T03:00:00Z',
              },
            ],
            error: null,
          }
        : {
            data: opts.history ?? [
              {
                id: 'h1',
                kind: 'earn',
                points: 8,
                reason: null,
                order_id: 'o1',
                created_at: '2026-11-18T03:00:00Z',
              },
            ],
            error: null,
          };
    return c;
  });
  return { client: { rpc, from } as never, rpc };
}

const ctx = (client: unknown, over: Partial<PageContext> = {}): PageContext => ({
  path: '/customers',
  navigate: () => {},
  client: client as never,
  orgId: 'o1',
  storeId: null,
  homeStoreId: 's1',
  permissions: ['customer.view'],
  isOwner: false,
  isPlatformAdmin: false,
  ...over,
});
const mount = (c: PageContext) =>
  render(
    <I18nProvider initialLang="en">
      <CustomersPage ctx={c} />
    </I18nProvider>,
  );

describe('<CustomersPage>', () => {
  it('finds a member by phone, shows the balance and the history', async () => {
    const { client, rpc } = fakeClient();
    mount(ctx(client));
    await userEvent.type(screen.getByLabelText('Find a member'), '5678');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Choose Anna Smith' }));
    expect(rpc).toHaveBeenCalledWith('find_customers', { p_org: 'o1', p_query: '5678' });
    const detail = await screen.findByRole('region', { name: 'Anna Smith' });
    expect(within(detail).getByText('Member code AB12CD34 · 66812345678')).toBeTruthy();
    expect(await within(detail).findByText('Earned from a bill')).toBeTruthy();
    expect(within(detail).getByText('+8')).toBeTruthy();
  });

  it('does not ask the server for a search that is too short', async () => {
    const { client, rpc } = fakeClient();
    mount(ctx(client));
    await userEvent.type(screen.getByLabelText('Find a member'), 'a');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('No member found')).toBeTruthy();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('adds a member (phone as digits) and opens them', async () => {
    const { client, rpc } = fakeClient();
    mount(ctx(client));
    await userEvent.click(screen.getByRole('button', { name: 'Add a new member' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Anna Smith');
    await userEvent.type(screen.getByLabelText('Phone (optional)'), '+66 81-234-5678');
    await userEvent.click(screen.getByRole('button', { name: 'Add member' }));
    await screen.findByRole('region', { name: 'Anna Smith' });
    expect(rpc).toHaveBeenCalledWith('create_customer', {
      p: { org_id: 'o1', name: 'Anna Smith', phone: '66812345678', consent: false },
    });
  });

  it('a phone that is already a member points to the existing member', async () => {
    const { client } = fakeClient({ create: { error: { code: '23505' } } });
    mount(ctx(client));
    await userEvent.click(screen.getByRole('button', { name: 'Add a new member' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Anna');
    await userEvent.type(screen.getByLabelText('Phone (optional)'), '0812345678');
    await userEvent.click(screen.getByRole('button', { name: 'Add member' }));
    expect(await screen.findByText(/already a member/)).toBeTruthy();
  });

  it('only a manager (credit.adjust) sees the correction form, and it needs a reason', async () => {
    const plain = fakeClient();
    mount(ctx(plain.client));
    await userEvent.type(screen.getByLabelText('Find a member'), 'anna');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Choose Anna Smith' }));
    await screen.findByRole('region', { name: 'Anna Smith' });
    expect(screen.queryByText('Correct points (manager)')).toBeNull();
    cleanup();

    const mgr = fakeClient();
    mount(ctx(mgr.client, { permissions: ['customer.view', 'credit.adjust'] }));
    await userEvent.type(screen.getByLabelText('Find a member'), 'anna');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Choose Anna Smith' }));
    await screen.findByText('Correct points (manager)');
    await userEvent.type(screen.getByLabelText('Points (negative = deduct)'), '50');
    await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
    expect(await screen.findByText(/Enter a non-zero number of points and a reason/)).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Reason (required)'), 'late order');
    await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
    await waitFor(() =>
      expect(mgr.rpc).toHaveBeenCalledWith('adjust_points', {
        p_customer: 'c1',
        p_points: 50,
        p_reason: 'late order',
      }),
    );
    expect(await screen.findByText('Points corrected.')).toBeTruthy();
  });

  it('refuses accounts without customer.view', () => {
    const { client, rpc } = fakeClient();
    mount(ctx(client, { permissions: [] }));
    expect(screen.getByText('This account may not view members.')).toBeTruthy();
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('<CustomersPage> Bestie Credit', () => {
  const open = async (
    c: ReturnType<typeof fakeClient>,
    perms: string[] = ['customer.view', 'payment.take'],
  ) => {
    mount(ctx(c.client, { permissions: perms as never }));
    await userEvent.type(screen.getByLabelText('Find a member'), 'anna');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Choose Anna Smith' }));
  };

  it('is hidden while the shop has not switched Credit on', async () => {
    await open(fakeClient({ credit: false }));
    await screen.findByRole('region', { name: 'Anna Smith' });
    expect(screen.queryByRole('region', { name: 'Bestie Credit (prepaid)' })).toBeNull();
  });

  it('shows the balance and history, and takes a cash top-up with a client-made id', async () => {
    const c = fakeClient({ credit: true });
    await open(c);
    const panel = await screen.findByRole('region', { name: 'Bestie Credit (prepaid)' });
    expect(within(panel).getByText('฿840')).toBeTruthy();
    expect(within(panel).getByText('Cash top-up')).toBeTruthy();
    await userEvent.type(within(panel).getByLabelText('Cash received (THB)'), '500');
    await userEvent.click(within(panel).getByRole('button', { name: 'Take cash and add Credit' }));
    await waitFor(() => expect(c.rpc.mock.calls.some((x) => x[0] === 'topup_credit')).toBe(true));
    const call = c.rpc.mock.calls.find((x) => x[0] === 'topup_credit')!;
    const p = (call[1] as { p: Record<string, unknown> }).p;
    expect(p).toMatchObject({ customer_id: 'c1', store_id: 's1', amount: 50000, funding: 'cash' });
    expect(String(p.id)).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByText('Credit added.')).toBeTruthy();
  });

  it('refuses a top-up outside 100–50,000 THB before asking the server', async () => {
    const c = fakeClient({ credit: true });
    await open(c);
    const panel = await screen.findByRole('region', { name: 'Bestie Credit (prepaid)' });
    await userEvent.type(within(panel).getByLabelText('Cash received (THB)'), '50');
    await userEvent.click(within(panel).getByRole('button', { name: 'Take cash and add Credit' }));
    expect(await screen.findByText('A top-up is between 100 and 50,000 THB.')).toBeTruthy();
    expect(c.rpc.mock.calls.some((x) => x[0] === 'topup_credit')).toBe(false);
  });

  it('only a manager sees the Credit correction form and it needs a reason', async () => {
    const c = fakeClient({ credit: true });
    await open(c, ['customer.view', 'payment.take', 'credit.adjust']);
    const panel = await screen.findByRole('region', { name: 'Bestie Credit (prepaid)' });
    await userEvent.type(within(panel).getByLabelText('Amount (THB, negative = deduct)'), '-20');
    await userEvent.click(within(panel).getByRole('button', { name: 'Save Credit correction' }));
    expect(await screen.findByText(/Enter a non-zero amount and a reason/)).toBeTruthy();
    await userEvent.type(within(panel).getByLabelText('Reason (required)'), 'wrong top-up');
    await userEvent.click(within(panel).getByRole('button', { name: 'Save Credit correction' }));
    await waitFor(() =>
      expect(c.rpc).toHaveBeenCalledWith('adjust_credit', {
        p_customer: 'c1',
        p_store: 's1',
        p_amount: -2000,
        p_reason: 'wrong top-up',
      }),
    );
  });
});
