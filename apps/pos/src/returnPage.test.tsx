import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetOfflineDb } from '@bestie/offline';
import { ReturnPage } from './ReturnPage';
import { bindTablet, mountEn, pageCtx, posClient } from './testKit';

afterEach(cleanup);
beforeEach(async () => {
  await resetOfflineDb();
  bindTablet();
});

const tables = (over: Record<string, unknown[]> = {}) => ({
  orders: [{ number: 'A001', status: 'paid', customer_id: null }],
  receipts: [{ number: 'A-000001', payable: 70000 }],
  order_lines: [
    {
      id: 'l-tee',
      name: { th: 'เสื้อ', en: 'T-shirt' },
      unit_price: 30000,
      quantity: 2,
      status: 'sent',
    },
    {
      id: 'l-hat',
      name: { th: 'หมวก', en: 'Hat' },
      unit_price: 10000,
      quantity: 1,
      status: 'sent',
    },
  ],
  payments: [{ tender: 'cash', amount: 70000 }],
  order_return_lines: [],
  order_returns: [],
  ...over,
});
const manager = { permissions: ['refund.create', 'order.create'] as never };

describe('<ReturnPage>', () => {
  it('needs the refund permission', () => {
    mountEn(
      <ReturnPage
        ctx={pageCtx(posClient(tables()), { permissions: ['order.create'] })}
        orderId="o1"
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('refund permission');
  });

  it('shows the amount from the same rule as the database and sends only ids and quantities', async () => {
    const c = posClient(tables());
    mountEn(<ReturnPage ctx={pageCtx(c, manager)} orderId="o1" />);
    await screen.findByText('T-shirt');
    await userEvent.clear(screen.getByLabelText('Quantity returned', { selector: '#rq-l-tee' }));
    await userEvent.type(
      screen.getByLabelText('Quantity returned', { selector: '#rq-l-tee' }),
      '1',
    );
    expect(screen.getByText(/Amount paid back/).parentElement?.textContent).toMatch(/฿300/);
    await userEvent.click(screen.getByRole('button', { name: 'Confirm the return' }));
    await waitFor(() => expect(c.rpc).toHaveBeenCalled());
    const [fn, args] = c.rpc.mock.calls[0] as unknown as [string, { p: Record<string, unknown> }];
    expect(fn).toBe('create_return');
    expect(args.p.refund_method).toBe('cash');
    expect(args.p.lines).toEqual([{ order_line_id: 'l-tee', quantity: 1, restock: true }]);
    expect(args.p.device_id).toBe('dev-1');
    expect(JSON.stringify(args)).not.toContain('amount'); // the phone never names a price
  });

  it('offers only the routes the customer paid with', async () => {
    const c = posClient(tables({ payments: [{ tender: 'promptpay', amount: 70000 }] }));
    mountEn(<ReturnPage ctx={pageCtx(c, manager)} orderId="o1" />);
    await screen.findByText('T-shirt');
    await userEvent.type(
      screen.getByLabelText('Quantity returned', { selector: '#rq-l-hat' }),
      '1',
    );
    expect(screen.queryByLabelText(/Cash from the till drawer/)).toBeNull();
    expect(screen.getByLabelText(/PromptPay \/ card \(done by hand in Stripe\)/)).toBeTruthy();
    expect(screen.getByText(/made by hand in Stripe/)).toBeTruthy();
  });

  it('says so when everything has already come back', async () => {
    const c = posClient(
      tables({
        order_return_lines: [
          { order_line_id: 'l-tee', quantity: 2 },
          { order_line_id: 'l-hat', quantity: 1 },
        ],
        order_returns: [{ refund_method: 'cash', amount: 70000 }],
      }),
    );
    mountEn(<ReturnPage ctx={pageCtx(c, manager)} orderId="o1" />);
    expect(await screen.findByText(/already been returned/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Confirm the return' })).toBeNull();
  });

  it('prints a return slip with the shop, the numbers and the signature line — only while printing', async () => {
    const print = vi.fn();
    vi.stubGlobal('print', print);
    const c = posClient(
      tables({
        receipts: [
          {
            number: 'A-000001',
            payable: 70000,
            seller_name: 'Island Shop Co.',
            seller_tax_id: '0105560123456',
            branch_code: '00001',
            pos_id: 'POS-77',
          },
        ],
        order_returns: [
          {
            id: 'r-1',
            number: 'RT-0001',
            refund_method: 'cash',
            amount: 30000,
            reason: 'defective',
            created_at: '2026-11-19T10:00:00Z',
            receipt_id: 'rc-1',
            staff_id: 's-1',
          },
        ],
        order_return_lines: [
          {
            name: { th: 'เสื้อ', en: 'T-shirt' },
            quantity: 1,
            unit_price: 30000,
            order_line_id: 'l-tee',
          },
        ],
        staff: [{ display_name: 'Mali' }],
      }),
    );
    mountEn(<ReturnPage ctx={pageCtx(c, manager)} orderId="o1" />);
    await screen.findByText('Earlier returns of this bill');
    expect(document.getElementById('print-root')).toBeNull();
    await userEvent.click(await screen.findByRole('button', { name: 'Print the return slip' }));
    await waitFor(() => expect(print).toHaveBeenCalled());
    vi.unstubAllGlobals();
  });
});
