import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@bestie/i18n';
import { TourBookPage } from './TourBookPage';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const T = 'e'.repeat(32);
const SLOT = '11111111-1111-4111-8111-111111111111';
const BID = '22222222-2222-4222-8222-222222222222';
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
const startsAt = new Date(Date.now() + 3 * 86_400_000).toISOString();
const info = (over: Record<string, unknown> = {}) => ({
  open: true,
  store_name: 'Island Tours',
  settings: { deposit_pct: 30, hold_min: 120, pay_note: 'PromptPay 0812345678' },
  slots: [
    {
      id: SLOT,
      title: { th: 'ดำน้ำ', en: 'Snorkel' },
      starts_at: startsAt,
      duration_min: 240,
      price: 150000,
      seats_left: 4,
      deposit_per_seat: 45000,
    },
  ],
  ...over,
});
const mount = () =>
  render(
    <I18nProvider guest initialLang="en">
      <TourBookPage token={T} />
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
          deposit_due: 90000,
          hold_until: new Date(Date.now() + 3_600_000).toISOString(),
        },
      });
    }
    if (u.includes('&id='))
      return json({
        status: opts.status ?? {
          status: 'booked',
          seats: 2,
          deposit_due: 90000,
          deposit_received: 0,
          starts_at: startsAt,
          title: { th: 'ดำน้ำ', en: 'Snorkel' },
        },
      });
    return json({ info: opts.info ?? info() });
  });
}

async function fill(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('radio', { name: /Snorkel/ }));
  const seats = screen.getByLabelText('Seats');
  await user.clear(seats);
  await user.type(seats, '2');
  await user.type(screen.getByLabelText('Name'), 'Anna');
  await user.type(screen.getByLabelText('Phone'), '0811111111');
}

describe('<TourBookPage>', () => {
  it('says closed while the module is off and not found for a wrong link', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ info: { open: false, store_name: 'Island Tours' } })),
    );
    const { unmount } = mount();
    expect(await screen.findByText(/closed|not taking/i)).toBeTruthy();
    unmount();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: 'not_found' }, 404)),
    );
    mount();
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('shows the tours with seats left and the price of the chosen seats with the deposit', async () => {
    vi.stubGlobal('fetch', api());
    const user = userEvent.setup();
    mount();
    await fill(user);
    expect(screen.getByText(/4 seats left/)).toBeTruthy();
    expect(screen.getByText(/Total ฿3,000/)).toBeTruthy();
    expect(screen.getByText(/Deposit .*900.*30%/)).toBeTruthy();
  });

  it('books with closed fields only, then shows the cancel code and the deposit to pay', async () => {
    const f = api();
    vi.stubGlobal('fetch', f);
    const user = userEvent.setup();
    mount();
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Confirm the tour booking' }));
    expect(await screen.findByText('ABCD1234')).toBeTruthy();
    expect(screen.getAllByText(/฿900/).length).toBeGreaterThan(0);
    expect(screen.getByText('PromptPay 0812345678')).toBeTruthy();
    const p = posts(f);
    expect(p).toHaveLength(1);
    expect(Object.keys(p[0]!).sort()).toEqual(
      ['client_id', 'name', 'op', 'phone', 'seats', 'slot_id', 't'].sort(),
    );
    expect(p[0]).toMatchObject({ slot_id: SLOT, seats: 2, name: 'Anna' });
  });

  it('a full tour is explained, and a saved booking survives a reload and can be cancelled', async () => {
    vi.stubGlobal('fetch', api({ book: { ok: false, error: 'full' } }));
    const user = userEvent.setup();
    const first = mount();
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Confirm the tour booking' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    first.unmount();

    const f = api();
    vi.stubGlobal('fetch', f);
    const u2 = userEvent.setup();
    const m = mount();
    await fill(u2);
    await u2.click(screen.getByRole('button', { name: 'Confirm the tour booking' }));
    await screen.findByText('ABCD1234');
    m.unmount();
    mount(); // reload: the booking is read back from the phone
    expect(await screen.findByText('ABCD1234')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /^Cancel/ }));
    await waitFor(() => expect(posts(f).some((b) => b.op === 'cancel')).toBe(true));
  });

  it('offers a reminder: the LINE code and an e-mail saved with the booking code', async () => {
    const f = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const b = JSON.parse(String(init.body)) as { op: string };
        if (b.op === 'contact') return json({ ok: true, error: null });
        return json({
          result: { ok: true, id: BID, code: 'ABCD1234', deposit_due: 0, hold_until: null },
        });
      }
      if (String(url).includes('&id=')) return json({ status: null });
      return json({ info: info(), lineBasicId: '@bestie' });
    });
    vi.stubGlobal('fetch', f);
    const user = userEvent.setup();
    mount();
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Confirm the tour booking' }));
    expect(await screen.findByText(/send your booking code ABCD1234/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Add the shop/ }).getAttribute('href')).toContain(
      '@bestie',
    );
    await user.type(screen.getByLabelText('Or by e-mail'), 'anna@example.com');
    await user.click(screen.getByRole('button', { name: 'Save the e-mail' }));
    expect(await screen.findByText(/e-mail you a reminder before the trip/)).toBeTruthy();
    const c = posts(f).find((x) => x.op === 'contact')!;
    expect(c).toMatchObject({ id: BID, code: 'ABCD1234', email: 'anna@example.com' });
  });
  it('tells the guest once the shop has received the deposit', async () => {
    vi.stubGlobal(
      'fetch',
      api({
        status: {
          status: 'booked',
          seats: 2,
          deposit_due: 90000,
          deposit_received: 90000,
          starts_at: startsAt,
          title: { th: 'ดำน้ำ', en: 'Snorkel' },
        },
      }),
    );
    const user = userEvent.setup();
    mount();
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Confirm the tour booking' }));
    expect(await screen.findByText(/received your deposit/)).toBeTruthy();
  });
});
