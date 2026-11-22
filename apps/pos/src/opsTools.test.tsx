import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageContext } from '@bestie/auth';
import { I18nProvider } from '@bestie/i18n';
import { CustomerDisplayPage, DISPLAY_CHANNEL, postDisplay } from './customerDisplay';
import { OrderDiscount } from './OrderDiscount';
import { ReceiptSend } from './ReceiptSend';

vi.mock('@bestie/offline', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  flush: vi.fn(async () => {}),
  outboxCounts: vi.fn(async () => ({ pending: 0, dead: 0 })),
  pullOrderNow: vi.fn(async () => {}),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mkCtx = (rpcs: Record<string, { data?: unknown; error?: { code: string } }> = {}) => {
  const calls: { fn: string; args: unknown }[] = [];
  const client = {
    rpc: vi.fn(async (fn: string, args: unknown) => {
      calls.push({ fn, args });
      const r = rpcs[fn] ?? {};
      return { data: r.data ?? null, error: r.error ?? null };
    }),
    auth: { getSession: vi.fn(async () => ({ data: { session: { access_token: 'tok' } } })) },
  };
  return {
    ctx: {
      client,
      navigate: vi.fn(),
      orgId: 'o1',
      permissions: [],
      isOwner: true,
    } as unknown as PageContext,
    calls,
  };
};
const wrap = (ui: React.ReactElement) => render(<I18nProvider initialLang="en">{ui}</I18nProvider>);

describe('<OrderDiscount>', () => {
  const rpcs = { discount_approvers: { data: [{ id: 'm1', name: 'Manager' }] } };
  const open = async (r: Record<string, { data?: unknown; error?: { code: string } }>) => {
    const k = mkCtx({ ...rpcs, ...r });
    wrap(<OrderDiscount ctx={k.ctx} orderId="ord1" storeId="s1" online />);
    await userEvent.click(screen.getByRole('button', { name: 'Manager discount' }));
    await screen.findByRole('option', { name: 'Manager' });
    return k;
  };
  it('needs a reason and a valid number before it asks the server', async () => {
    const { calls } = await open({});
    await userEvent.type(screen.getByLabelText('Percent off', { selector: 'input' }), '10');
    await userEvent.type(screen.getByLabelText('The manager’s PIN'), '4321');
    await userEvent.click(screen.getByRole('button', { name: 'Approve the discount' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(calls.some((c) => c.fn === 'discount_with_manager')).toBe(false);
  });
  it('sends percent as basis points with the approver and PIN, then shows what was taken off', async () => {
    const { calls } = await open({ discount_with_manager: { data: { ok: true, applied: 1000 } } });
    await userEvent.type(screen.getByLabelText('Percent off', { selector: 'input' }), '10');
    await userEvent.type(screen.getByLabelText('The manager’s PIN'), '4321');
    await userEvent.type(screen.getByLabelText('Reason (required)'), 'regular guest');
    await userEvent.click(screen.getByRole('button', { name: 'Approve the discount' }));
    expect(await screen.findByText(/Discounted/)).toBeTruthy();
    expect(calls.find((c) => c.fn === 'discount_with_manager')!.args).toEqual({
      p: {
        order_id: 'ord1',
        kind: 'percent',
        value: 1000,
        reason: 'regular guest',
        manager_id: 'm1',
        manager_pin: '4321',
      },
    });
  });
  it('a wrong PIN is told plainly and nothing changes', async () => {
    await open({ discount_with_manager: { data: { ok: false } } });
    await userEvent.type(screen.getByLabelText('Percent off', { selector: 'input' }), '10');
    await userEvent.type(screen.getByLabelText('The manager’s PIN'), '0000');
    await userEvent.type(screen.getByLabelText('Reason (required)'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Approve the discount' }));
    expect(await screen.findByText(/was not accepted/)).toBeTruthy();
  });
  it('says so when offline', async () => {
    const k = mkCtx();
    wrap(<OrderDiscount ctx={k.ctx} orderId="o" storeId="s1" online={false} />);
    await userEvent.click(screen.getByRole('button', { name: 'Manager discount' }));
    expect(screen.getByText(/need to be online/)).toBeTruthy();
  });
});

describe('<ReceiptSend>', () => {
  const data = {
    receipt: { number: 'A+000007', seller_name: 'Acme' },
    lines: [],
    payments: [],
    member_line: true,
  };
  it("sends by e-mail through the server with the person's token", async () => {
    const f = vi.fn(async () => Response.json({ ok: true, outcome: 'sent' }));
    vi.stubGlobal('fetch', f);
    const { ctx } = mkCtx({ receipt_send_data: { data } });
    wrap(<ReceiptSend ctx={ctx} orderId="ord1" lang="en" online />);
    const send = await screen.findByRole('button', { name: 'Send by e-mail' });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("Customer's e-mail"), 'buyer@example.com');
    await userEvent.click(send);
    expect(await screen.findByText('The receipt was sent by e-mail')).toBeTruthy();
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/receipt/send');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(JSON.parse(String(init.body))).toEqual({
      order_id: 'ord1',
      via: 'email',
      lang: 'en',
      email: 'buyer@example.com',
    });
  });
  it('offers LINE only for a member who linked it, and explains a refusal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: false, outcome: 'no_channel' })),
    );
    const { ctx } = mkCtx({ receipt_send_data: { data } });
    wrap(<ReceiptSend ctx={ctx} orderId="ord1" lang="th" online />);
    await userEvent.click(await screen.findByRole('button', { name: "Send on the member's LINE" }));
    expect(
      await screen.findByText('This member has not linked LINE, or has typed STOP'),
    ).toBeTruthy();
    cleanup();
    const k2 = mkCtx({ receipt_send_data: { data: { ...data, member_line: false } } });
    wrap(<ReceiptSend ctx={k2.ctx} orderId="ord1" lang="th" online />);
    await screen.findByRole('button', { name: 'Send by e-mail' });
    expect(screen.queryByRole('button', { name: "Send on the member's LINE" })).toBeNull();
  });
  it('shows nothing before the bill is paid (no receipt) and a hint when offline', async () => {
    const { ctx } = mkCtx({ receipt_send_data: { data: null } });
    const { container } = wrap(<ReceiptSend ctx={ctx} orderId="ord1" lang="th" online />);
    await waitFor(() => expect(container.querySelector('section')).toBeNull());
    cleanup();
    wrap(<ReceiptSend ctx={ctx} orderId="ord1" lang="th" online={false} />);
    expect(screen.getByText(/need to be online/)).toBeTruthy();
  });
});

describe('customer display', () => {
  it('draws the bill the till posts, the thank-you, and goes back to the welcome', async () => {
    wrap(<CustomerDisplayPage />);
    expect(screen.getByText('Welcome')).toBeTruthy();
    postDisplay({
      kind: 'bill',
      number: 'A001',
      lines: [{ name: { th: 'ผัดไทย', en: 'Pad Thai' }, qty: 2, amount: 10000 }],
      total: 10700,
      pointsDiscount: 0,
    });
    expect(await screen.findByText(/2 × Pad Thai/)).toBeTruthy();
    expect(screen.getByText(/107/)).toBeTruthy();
    act(() => postDisplay({ kind: 'thanks', number: 'A001', total: 10700 }));
    expect(await screen.findByText('Thank you')).toBeTruthy();
    act(() => postDisplay({ kind: 'idle' }));
    expect(await screen.findByText('Welcome')).toBeTruthy();
  });
  it('ignores a message that is not for it', async () => {
    wrap(<CustomerDisplayPage />);
    const ch = new BroadcastChannel(DISPLAY_CHANNEL);
    ch.postMessage({ kind: 'script', html: '<b>x</b>' });
    ch.close();
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByText('Welcome')).toBeTruthy();
  });
});
