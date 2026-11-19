import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@bestie/i18n';
import { BookingPage } from './BookingPage';

const TOKEN = 'a'.repeat(32);
const SVC = '11111111-1111-4111-8111-111111111111';
const PRO = '22222222-2222-4222-8222-222222222222';
const INFO = {
  open: true,
  store_name: 'Salon Breeze',
  settings: { open: '09:00', close: '20:00', step_min: 30, lead_min: 120, max_days: 30 },
  services: [{ id: SVC, name: { th: 'นวด', en: 'Massage' }, duration_min: 60, price: 100000 }],
  providers: [
    { id: PRO, name: 'Nok' },
    { id: '33333333-3333-4333-8333-333333333333', name: 'Mai' },
  ],
};
const WHEN = new Date(Date.now() + 3 * 86_400_000).toISOString();

type Calls = { url: string; body?: Record<string, unknown> }[];
let calls: Calls;
const route = (
  o: {
    info?: unknown;
    infoStatus?: number;
    slots?: string[];
    book?: unknown;
    cancel?: unknown;
  } = {},
) =>
  vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    calls.push({
      url: u,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    });
    if (init?.method === 'POST') {
      const op = (JSON.parse(String(init.body)) as { op: string }).op;
      return new Response(
        JSON.stringify({
          result:
            op === 'book' ? (o.book ?? { ok: false, error: 'taken' }) : (o.cancel ?? { ok: true }),
        }),
      );
    }
    if (u.includes('&service='))
      return new Response(JSON.stringify({ slots: o.slots ?? ['10:00', '10:30'] }));
    return new Response(JSON.stringify({ info: o.info ?? INFO }), { status: o.infoStatus ?? 200 });
  });

beforeEach(() => {
  calls = [];
  try {
    localStorage.clear();
  } catch {
    /* none */
  }
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const mount = () =>
  render(
    <I18nProvider initialLang="en">
      <BookingPage token={TOKEN} />
    </I18nProvider>,
  );
const fill = async () => {
  await userEvent.click(await screen.findByRole('button', { name: /Massage/ }));
  fireEvent.change(screen.getByLabelText('3. Choose a day'), { target: { value: '2099-01-02' } });
  await userEvent.click(await screen.findByRole('button', { name: '10:30' }));
  await userEvent.type(screen.getByLabelText('Name'), 'Anna');
  await userEvent.type(screen.getByLabelText('Phone'), '081-111-1111');
};

describe('<BookingPage>', () => {
  it('a wrong link says so', async () => {
    vi.stubGlobal('fetch', route({ infoStatus: 404 }));
    mount();
    expect(await screen.findByText(/booking link was not found/)).toBeTruthy();
  });

  it('a shop that is not taking bookings says so', async () => {
    vi.stubGlobal('fetch', route({ info: { open: false, store_name: 'Salon Breeze' } }));
    mount();
    expect(await screen.findByText(/not taking online bookings/)).toBeTruthy();
  });

  it('walks through the steps and books with the choices, not prices', async () => {
    vi.stubGlobal(
      'fetch',
      route({ book: { ok: true, id: 'a1', code: 'ABCD1234', starts_at: WHEN, provider: 'Nok' } }),
    );
    mount();
    expect(await screen.findByText('Salon Breeze')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Massage · 60 min · ฿1,000/ })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Nok' }));
    await fill();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm booking' }));
    expect(await screen.findByText('You are booked')).toBeTruthy();
    expect(screen.getByText('ABCD1234')).toBeTruthy();
    const post = calls.find((c) => c.body?.op === 'book')!.body!;
    expect(post).toMatchObject({
      t: TOKEN,
      service_id: SVC,
      provider_id: PRO,
      date: '2099-01-02',
      time: '10:30',
      name: 'Anna',
      phone: '081-111-1111',
    });
    expect(Object.keys(post)).not.toContain('price');
    expect(typeof post.client_id).toBe('string');
  });

  it('"anyone" sends no stylist; the list of times is asked for with the service and day', async () => {
    vi.stubGlobal('fetch', route({ book: { ok: false, error: 'taken' } }));
    mount();
    await fill();
    const slotCall = calls.find((c) => c.url.includes('&service='))!;
    expect(slotCall.url).toContain(`service=${SVC}`);
    expect(slotCall.url).toContain('date=2099-01-02');
    expect(slotCall.url).not.toContain('provider=');
  });

  it('a time that was just taken says so, clears the time and asks for fresh times', async () => {
    vi.stubGlobal('fetch', route({ book: { ok: false, error: 'taken' } }));
    mount();
    await fill();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm booking' }));
    expect(await screen.findByText(/just taken/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '10:30' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(calls.filter((c) => c.url.includes('&service=')).length).toBeGreaterThanOrEqual(2);
  });

  it('cannot be confirmed until every needed field is filled', async () => {
    vi.stubGlobal('fetch', route());
    mount();
    await screen.findByText('Salon Breeze');
    expect(
      (screen.getByRole('button', { name: 'Confirm booking' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('a day with no free time says so', async () => {
    vi.stubGlobal('fetch', route({ slots: [] }));
    mount();
    await userEvent.click(await screen.findByRole('button', { name: /Massage/ }));
    fireEvent.change(screen.getByLabelText('3. Choose a day'), { target: { value: '2099-01-02' } });
    expect(await screen.findByText(/No free times that day/)).toBeTruthy();
  });

  it('after booking the guest can cancel with the code, and the saved booking is forgotten', async () => {
    vi.stubGlobal(
      'fetch',
      route({ book: { ok: true, id: 'a1', code: 'ABCD1234', starts_at: WHEN, provider: null } }),
    );
    mount();
    await fill();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm booking' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel this booking' }));
    expect(await screen.findByText('Booking cancelled.')).toBeTruthy();
    expect(calls.at(-1)!.body).toEqual({ t: TOKEN, op: 'cancel', id: 'a1', code: 'ABCD1234' });
    expect(localStorage.getItem(`bestie.booking.${TOKEN}`)).toBeNull();
  });

  it('a refused cancel tells the guest to contact the shop', async () => {
    vi.stubGlobal(
      'fetch',
      route({
        book: { ok: true, id: 'a1', code: 'ABCD1234', starts_at: WHEN, provider: null },
        cancel: { ok: false, error: 'closed' },
      }),
    );
    mount();
    await fill();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm booking' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel this booking' }));
    expect(await screen.findByText(/no longer be cancelled/)).toBeTruthy();
  });

  it('coming back to the page shows the upcoming booking again', async () => {
    localStorage.setItem(
      `bestie.booking.${TOKEN}`,
      JSON.stringify({ id: 'a1', code: 'ZZZZ9999', startsAt: WHEN, provider: 'Nok' }),
    );
    vi.stubGlobal('fetch', route());
    mount();
    expect(await screen.findByText('ZZZZ9999')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Book again' })).toBeTruthy());
  });
});
