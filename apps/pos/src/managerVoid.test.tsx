import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetOfflineDb } from '@bestie/offline';
import { ManagerVoid } from './ManagerVoid';
import { mountEn, pageCtx } from './testKit';

afterEach(cleanup);
beforeEach(async () => {
  await resetOfflineDb();
});

function client(
  result: { data?: unknown; error?: { code: string } | null } = { data: { ok: true } },
) {
  const rpc = vi.fn(async (fn: string) =>
    fn === 'void_approvers'
      ? {
          data: [
            { id: 'm1', name: 'Mali' },
            { id: 'm2', name: 'Owner Oh' },
          ],
          error: null,
        }
      : { data: result.data ?? null, error: result.error ?? null },
  );
  return {
    client: {
      rpc,
      from: vi.fn(),
      auth: { getSession: async () => ({ data: { session: null } }) },
    } as never,
    rpc,
  };
}
const ctx = (c: unknown) => pageCtx(c, { permissions: ['order.create', 'payment.take'] });

describe('<ManagerVoid>', () => {
  it('asks the server to void with the chosen manager, the PIN and the reason — never voids by itself', async () => {
    const { client: c, rpc } = client();
    mountEn(<ManagerVoid ctx={ctx(c)} orderId="o1" lineId="l1" online />);
    await userEvent.click(screen.getByRole('button', { name: 'Void with a manager PIN' }));
    await screen.findByRole('option', { name: 'Mali' });
    await userEvent.type(screen.getByLabelText('The manager’s PIN'), '4321');
    await userEvent.type(screen.getByLabelText('Reason (required)'), 'guest left');
    await userEvent.click(screen.getByRole('button', { name: 'Approve and void' }));
    await waitFor(() =>
      expect(rpc.mock.calls.some((x) => x[0] === 'void_line_with_manager')).toBe(true),
    );
    const call = rpc.mock.calls.find((x) => x[0] === 'void_line_with_manager')!;
    expect((call as unknown as [string, { p: unknown }])[1].p).toEqual({
      line_id: 'l1',
      reason: 'guest left',
      manager_id: 'm1',
      manager_pin: '4321',
    });
  });

  it('keeps the form open and says so when the PIN is not accepted; the PIN field is cleared', async () => {
    const { client: c } = client({ data: { ok: false } });
    mountEn(<ManagerVoid ctx={ctx(c)} orderId="o1" lineId="l1" online />);
    await userEvent.click(screen.getByRole('button', { name: 'Void with a manager PIN' }));
    await screen.findByRole('option', { name: 'Mali' });
    await userEvent.type(screen.getByLabelText('The manager’s PIN'), '0000');
    await userEvent.type(screen.getByLabelText('Reason (required)'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Approve and void' }));
    expect(await screen.findByText(/That PIN was not accepted/)).toBeTruthy();
    expect((screen.getByLabelText('The manager’s PIN') as HTMLInputElement).value).toBe('');
  });

  it('needs a reason and a 4-digit PIN before it will ask', async () => {
    const { client: c, rpc } = client();
    mountEn(<ManagerVoid ctx={ctx(c)} orderId="o1" lineId="l1" online />);
    await userEvent.click(screen.getByRole('button', { name: 'Void with a manager PIN' }));
    await screen.findByRole('option', { name: 'Mali' });
    const go = screen.getByRole('button', { name: 'Approve and void' }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText('The manager’s PIN'), '4321');
    await userEvent.click(go);
    expect(await screen.findByText('Enter a reason first.')).toBeTruthy();
    expect(rpc.mock.calls.some((x) => x[0] === 'void_line_with_manager')).toBe(false);
  });

  it('offline it says a connection is needed', async () => {
    const { client: c } = client();
    mountEn(<ManagerVoid ctx={ctx(c)} orderId="o1" lineId="l1" online={false} />);
    await userEvent.click(screen.getByRole('button', { name: 'Void with a manager PIN' }));
    expect(screen.getByText('A manager PIN needs a connection.')).toBeTruthy();
  });
});
