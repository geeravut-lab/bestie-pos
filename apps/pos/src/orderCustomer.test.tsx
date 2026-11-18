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

function client(attached: boolean) {
  const rpc = vi.fn(async (fn: string) => {
    if (fn === 'find_customers') return { data: [ANNA], error: null };
    if (fn === 'points_balance') return { data: 8, error: null };
    return { data: null, error: null };
  });
  const from = vi.fn((table: string) => {
    const c: Record<string, unknown> = {};
    c.select = () => c;
    c.eq = () => c;
    c.maybeSingle = async () =>
      table === 'orders'
        ? { data: { customer_id: attached ? 'c1' : null }, error: null }
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
