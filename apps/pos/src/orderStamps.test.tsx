import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageContext } from '@bestie/auth';
import { I18nProvider } from '@bestie/i18n';
import { OrderStamps } from './OrderStamps';

afterEach(cleanup);

const status = [
  {
    program_id: 'p1',
    kind: 'stamps',
    name: { th: 'บัตร', en: 'Coffee card' },
    reward_item_id: 'i1',
    stamps_needed: 5,
    stamps: 7,
    rewards_ready: 1,
  },
  {
    program_id: 'p2',
    kind: 'pass',
    name: { th: 'พาส', en: 'Monthly pass' },
    reward_item_id: 'i1',
    pass_price: 30000,
    pass_days: 30,
    stamps: 0,
    rewards_ready: 0,
    pass_until: null,
    pass_used_today: null,
  },
];
const mount = (
  customer: string | null,
  rpcs: Record<string, { data?: unknown; error?: { code: string } }> = {},
) => {
  const calls: { fn: string; args: unknown }[] = [];
  const client = {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: { customer_id: customer }, error: null }) }),
      }),
    }),
    rpc: vi.fn(async (fn: string, args: unknown) => {
      calls.push({ fn, args });
      const r = rpcs[fn] ?? (fn === 'stamp_status' ? { data: status } : {});
      return { data: r.data ?? null, error: r.error ?? null };
    }),
  };
  const navigate = vi.fn();
  const ctx = {
    client,
    navigate,
    orgId: 'o1',
    storeId: 's1',
    permissions: [],
    isOwner: true,
  } as unknown as PageContext;
  render(
    <I18nProvider initialLang="en">
      <OrderStamps ctx={ctx} orderId="ord1" storeId="s1" online />
    </I18nProvider>,
  );
  return { calls, navigate };
};

describe('<OrderStamps>', () => {
  it('asks for a member when the bill has none', async () => {
    mount(null);
    expect(await screen.findByText('Put the member on the bill to use stamp cards')).toBeTruthy();
  });
  it('shows how close the card is and uses a reward on this bill', async () => {
    const { calls } = mount('c1', { redeem_stamp_reward: { data: { ok: true } } });
    expect(await screen.findByText('7 stamps · 3 more for a free one')).toBeTruthy();
    expect(screen.getByText('1 reward(s) ready')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Use a reward on this bill' }));
    expect(await screen.findByText('Reward used: a free item is on the bill')).toBeTruthy();
    expect(calls.find((c) => c.fn === 'redeem_stamp_reward')!.args).toEqual({
      p: { order_id: 'ord1', program_id: 'p1' },
    });
  });
  it('tells the cashier to add the free item first when the server refuses', async () => {
    mount('c1', { redeem_stamp_reward: { error: { code: '55000' } } });
    await userEvent.click(await screen.findByRole('button', { name: 'Use a reward on this bill' }));
    expect(await screen.findByText('Add the free item to the bill first')).toBeTruthy();
  });
  it('sells a pass as its own bill and opens it', async () => {
    const { calls, navigate } = mount('c1', { sell_stamp_pass: { data: 'bill-7' } });
    await userEvent.click(await screen.findByRole('button', { name: /Sell the pass/ }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/order/bill-7'));
    expect(calls.find((c) => c.fn === 'sell_stamp_pass')!.args).toMatchObject({
      p: { store_id: 's1', program_id: 'p2', customer_id: 'c1' },
    });
  });
});
