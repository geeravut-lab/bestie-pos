import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@bestie/i18n';
import { KaraokeBookPage } from './KaraokeBookPage';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const T = 'd'.repeat(32);
const ROOM = '11111111-1111-4111-8111-111111111111';
const BID = '22222222-2222-4222-8222-222222222222';
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
const info = (over: Record<string, unknown> = {}) => ({
  open: true,
  store_name: 'Sing Along',
  settings: { deposit_pct: 30, hold_min: 120, pay_note: 'PromptPay 0812345678' },
  rooms: [{ id: ROOM, name: 'VIP 1', rate_per_hour: 30000, lengths: [60, 120] }],
  ...over,
});
const day = (() => {
  const d = new Date(Date.now() + 2 * 86_400_000);
  return d.toISOString().slice(0, 10);
})();
const mount = () =>
  render(
    <I18nProvider guest initialLang="en">
      <KaraokeBookPage token={T} />
    </I18nProvider>,
  );
const posts = (f: ReturnType<typeof vi.fn>) =>
  f.mock.calls
    .filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST')
    .map((c) => JSON.parse(String((c[1] as RequestInit).body)) as Record<string, unknown>);

function api(opts: { book?: unknown; status?: unknown; info?: unknown } = {}) {
  return vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === 'POST') {
      const b = JSON.parse(String(init.body)) as { op: string };
      if (b.op === 'cancel') return json({ result: { ok: true } });
      return json({
        result: opts.book ?? {
          ok: true,
          id: BID,
          code: 'ABCD1234',
          starts_at: new Date(Date.now() + 2 * 86_400_000).toISOString(),
          minutes: 120,
          room: 'VIP 1',
          price: 60000,
          deposit_due: 18000,
          hold_until: new Date(Date.now() + 3_600_000).toISOString(),
        },
      });
    }
    if (u.includes('&room=')) return json({ slots: ['20:00', '20:30'] });
    if (u.includes('&id='))
      return json({
        status: opts.status ?? {
          ok: true,
          status: 'booked',
          starts_at: 'x',
          minutes: 120,
          room: 'VIP 1',
          deposit_due: 18000,
          deposit_paid: 0,
        },
      });
    return json({ info: opts.info ?? info() });
  });
}

async function fill(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('radio', { name: /VIP 1/ }));
  await user.click(screen.getByRole('button', { name: '120 min' }));
  const date = screen.getByLabelText('3. Choose a day') as HTMLInputElement;
  await user.type(date, day);
  await user.click(await screen.findByRole('button', { name: '20:00' }));
  await user.type(screen.getByLabelText('Name'), 'Anna');
  await user.type(screen.getByLabelText('Phone'), '0811111111');
}

describe('<KaraokeBookPage>', () => {
  it('says closed while the module is off and not found for a wrong link', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ info: { open: false, store_name: 'Sing Along' } })),
    );
    mount();
    expect(await screen.findByText(/not taking online bookings/)).toBeTruthy();
    cleanup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({}, 404)),
    );
    mount();
    expect(await screen.findByText(/booking link was not found/i)).toBeTruthy();
  });

  it('shows the room price and the deposit before the guest books', async () => {
    vi.stubGlobal('fetch', api());
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole('radio', { name: /VIP 1/ }));
    await user.click(screen.getByRole('button', { name: '120 min' }));
    expect(screen.getByText(/Room price for the time you picked: ฿600/)).toBeTruthy();
    expect(screen.getByText(/Deposit ฿180 \(30% of the room price\)/)).toBeTruthy();
  });

  it('books a room and shows the code, the deposit and how to pay it', async () => {
    const f = api();
    vi.stubGlobal('fetch', f);
    const user = userEvent.setup();
    mount();
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Confirm the room' }));
    expect(await screen.findByText('ABCD1234')).toBeTruthy();
    expect(screen.getByText('฿180')).toBeTruthy();
    expect(screen.getByText('PromptPay 0812345678')).toBeTruthy();
    expect(posts(f)[0]).toMatchObject({
      op: 'book',
      room_id: ROOM,
      minutes: 120,
      time: '20:00',
      name: 'Anna',
    });
    expect(localStorage.getItem(`bestie.kbook.${T}`)).toContain(BID);
  });

  it('tells the guest when the shop has received the deposit', async () => {
    vi.stubGlobal(
      'fetch',
      api({
        status: {
          ok: true,
          status: 'booked',
          starts_at: 'x',
          minutes: 120,
          room: 'VIP 1',
          deposit_due: 18000,
          deposit_paid: 18000,
        },
      }),
    );
    const user = userEvent.setup();
    mount();
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Confirm the room' }));
    expect(await screen.findByText(/received your deposit/)).toBeTruthy();
  });

  it('shows a refused time and offers the times again', async () => {
    vi.stubGlobal('fetch', api({ book: { ok: false, error: 'taken' } }));
    const user = userEvent.setup();
    mount();
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Confirm the room' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/just taken/)).toBeTruthy();
  });

  it('cancels with the code', async () => {
    const f = api();
    vi.stubGlobal('fetch', f);
    const user = userEvent.setup();
    mount();
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Confirm the room' }));
    await screen.findByText('ABCD1234');
    await user.click(screen.getByRole('button', { name: 'Cancel this booking' }));
    await waitFor(() =>
      expect(posts(f).some((b) => b.op === 'cancel' && b.code === 'ABCD1234')).toBe(true),
    );
    expect(await screen.findByRole('heading', { name: /cancelled/i })).toBeTruthy();
  });

  it('remembers the booking on the phone after a refresh', async () => {
    localStorage.setItem(
      `bestie.kbook.${T}`,
      JSON.stringify({
        id: BID,
        code: 'ABCD1234',
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
        minutes: 60,
        room: 'VIP 1',
        depositDue: 0,
        holdUntil: null,
      }),
    );
    vi.stubGlobal('fetch', api());
    mount();
    expect(await screen.findByText('ABCD1234')).toBeTruthy();
  });
});
