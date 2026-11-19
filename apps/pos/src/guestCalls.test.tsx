import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GuestCalls } from './GuestCalls';
import { mountEn, pageCtx } from './testKit';

afterEach(cleanup);

function client(rows: unknown[]) {
  const rpc = vi.fn(async () => ({ data: null, error: null }));
  const from = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq']) chain[m] = () => chain;
    chain.order = async () => ({ data: rows, error: null });
    return chain;
  };
  return {
    rpc,
    client: {
      from,
      rpc,
      channel: () => ({
        on() {
          return this;
        },
        subscribe() {
          return this;
        },
      }),
      removeChannel: async () => 'ok',
    },
  };
}

describe('<GuestCalls>', () => {
  it('shows nothing when no guest is calling', async () => {
    const c = client([]);
    mountEn(<GuestCalls ctx={pageCtx(c.client as never)} storeId="s1" />);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText('Guests calling the staff')).toBeNull();
  });
  it('lists open calls with the table and the reason, and "Got it" answers through the database', async () => {
    const c = client([
      {
        id: 'a',
        reason: 'bill',
        created_at: '2026-11-19T05:00:00Z',
        dining_tables: { name: 'T5' },
      },
      {
        id: 'b',
        reason: 'help',
        created_at: '2026-11-19T04:59:00Z',
        dining_tables: [{ name: 'T2' }],
      },
    ]);
    mountEn(<GuestCalls ctx={pageCtx(c.client as never)} storeId="s1" />);
    expect(await screen.findByText(/Asks for the bill · Table T5/)).toBeTruthy();
    expect(screen.getByText(/Needs help · Table T2/)).toBeTruthy();
    await userEvent.click(screen.getAllByRole('button', { name: 'Got it' })[0]!);
    await waitFor(() => expect(c.rpc).toHaveBeenCalledWith('answer_guest_call', { p_id: 'a' }));
  });
});
