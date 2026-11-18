import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrderCustomer } from './OrderCustomer';
import { mountEn, pageCtx } from './testKit';

afterEach(cleanup);

const ANNA = {
  id: 'c1',
  name: 'Anna Smith',
  phone: '66812345678',
  member_code: 'AB12CD34',
  balance: 8,
};

function client(
  attached: boolean,
  over: {
    used?: number;
    discount?: number;
    setPoints?: { data?: unknown; error?: { code: string } | null };
  } = {},
) {
  const rpc = vi.fn(async (fn: string) => {
    if (fn === 'find_customers') return { data: [ANNA], error: null };
    if (fn === 'points_balance') return { data: 8, error: null };
    if (fn === 'set_order_points')
      return {
        data: over.setPoints?.data ?? { points_used: 5, cap_points: 105 },
        error: over.setPoints?.error ?? null,
      };
    return { data: null, error: null };
  });
  const from = vi.fn((table: string) => {
    const c: Record<string, unknown> = {};
    c.select = () => c;
    c.eq = () => c;
    c.maybeSingle = async () =>
      table === 'orders'
        ? {
            data: {
              customer_id: attached ? 'c1' : null,
              points_used: over.used ?? 0,
              points_discount: over.discount ?? 0,
            },
            error: null,
          }
        : { data: ANNA, error: null };
    return c;
  });
  return { client: { from, rpc } as never, rpc };
}
const ctx = (c: unknown, permissions = ['order.create', 'customer.view']) =>
  pageCtx(c, { permissions: permissions as never });

describe('<OrderCustomer>', () => {
  it('puts a found member on the bill', async () => {
    const { client: c, rpc } = client(false);
    mountEn(<OrderCustomer ctx={ctx(c)} orderId="o1" open online />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Add a customer to this bill' }),
    );
    await userEvent.type(screen.getByLabelText('Find a member'), 'anna');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Choose Anna Smith' }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith('set_order_customer', { p_order: 'o1', p_customer: 'c1' }),
    );
  });

  it('shows who is on the bill with their points, and lets staff remove them while it is open', async () => {
    const { client: c, rpc } = client(true);
    mountEn(<OrderCustomer ctx={ctx(c)} orderId="o1" open online />);
    expect(await screen.findByText(/Customer: Anna Smith · 8 points/)).toBeTruthy();
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove the customer from this bill' }),
    );
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith('set_order_customer', { p_order: 'o1', p_customer: null }),
    );
  });

  it('a closed bill shows the customer but offers no change', async () => {
    const { client: c } = client(true);
    mountEn(<OrderCustomer ctx={ctx(c)} orderId="o1" open={false} online />);
    expect(await screen.findByText(/Customer: Anna Smith/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Remove the customer/ })).toBeNull();
  });

  it('shows nothing offline or without customer.view', () => {
    const { client: c } = client(false);
    mountEn(<OrderCustomer ctx={ctx(c)} orderId="o1" open online={false} />);
    expect(screen.queryByRole('button', { name: 'Add a customer to this bill' })).toBeNull();
    cleanup();
    mountEn(<OrderCustomer ctx={ctx(c, ['order.create'])} orderId="o1" open online />);
    expect(screen.queryByRole('button', { name: 'Add a customer to this bill' })).toBeNull();
  });
});

describe('<OrderCustomer> Bestie Points as a discount', () => {
  it('asks the server to put N points on the bill and shows how many are available', async () => {
    const { client: c, rpc } = client(true);
    mountEn(<OrderCustomer ctx={ctx(c)} orderId="o1" open online />);
    expect(await screen.findByText(/The customer has 8 points available/)).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Points to use'), '5');
    await userEvent.click(screen.getByRole('button', { name: 'Use points' }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith('set_order_points', { p_order: 'o1', p_wanted: 5 }),
    );
  });

  it('"use as many as allowed" asks for everything the customer has and lets the server cap it', async () => {
    const { client: c, rpc } = client(true, { used: 0 });
    mountEn(<OrderCustomer ctx={ctx(c)} orderId="o1" open online />);
    await userEvent.click(await screen.findByRole('button', { name: 'Use as many as allowed' }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith('set_order_points', { p_order: 'o1', p_wanted: 8 }),
    );
  });

  it('shows the points already on the bill and can take them off', async () => {
    const { client: c, rpc } = client(true, { used: 30, discount: 3000 });
    mountEn(<OrderCustomer ctx={ctx(c)} orderId="o1" open online />);
    expect(await screen.findByText('Using 30 points: ฿30 off')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Do not use points' }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith('set_order_points', { p_order: 'o1', p_wanted: 0 }),
    );
  });

  it("says when the shop's cap limited it, when a payment is waiting, and when points are off", async () => {
    const capped = client(true, { setPoints: { data: { points_used: 2, cap_points: 2 } } });
    mountEn(<OrderCustomer ctx={ctx(capped.client)} orderId="o1" open online />);
    await userEvent.type(await screen.findByLabelText('Points to use'), '9');
    await userEvent.click(screen.getByRole('button', { name: 'Use points' }));
    expect(await screen.findByText('At most 2 points can be used on this bill')).toBeTruthy();
    cleanup();
    const locked = client(true, { setPoints: { error: { code: '55006' } } });
    mountEn(<OrderCustomer ctx={ctx(locked.client)} orderId="o1" open online />);
    await userEvent.type(await screen.findByLabelText('Points to use'), '3');
    await userEvent.click(screen.getByRole('button', { name: 'Use points' }));
    expect(await screen.findByText(/A payment on this bill is waiting/)).toBeTruthy();
    cleanup();
    const off = client(true, { setPoints: { error: { code: '0A000' } } });
    mountEn(<OrderCustomer ctx={ctx(off.client)} orderId="o1" open online />);
    await userEvent.type(await screen.findByLabelText('Points to use'), '3');
    await userEvent.click(screen.getByRole('button', { name: 'Use points' }));
    expect(await screen.findByText('Points are switched off in this shop.')).toBeTruthy();
  });

  it('a non-number is refused before asking the server; a closed bill offers no points', async () => {
    const { client: c, rpc } = client(true);
    mountEn(<OrderCustomer ctx={ctx(c)} orderId="o1" open online />);
    await userEvent.type(await screen.findByLabelText('Points to use'), 'abc');
    await userEvent.click(screen.getByRole('button', { name: 'Use points' }));
    expect(await screen.findByText('Enter the number of points.')).toBeTruthy();
    expect(rpc.mock.calls.some((x) => x[0] === 'set_order_points')).toBe(false);
    cleanup();
    mountEn(<OrderCustomer ctx={ctx(c)} orderId="o1" open={false} online />);
    await screen.findByText(/Customer: Anna Smith/);
    expect(screen.queryByLabelText('Points to use')).toBeNull();
  });
});
