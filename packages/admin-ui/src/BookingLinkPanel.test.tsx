import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageContext } from '@bestie/auth';
import { I18nProvider } from '@bestie/i18n';
import { BookingLinkPanel } from './BookingLinkPanel';
import { fakeDb } from './fakeDb';

afterEach(cleanup);
const TOKEN = 'b'.repeat(32);
const tables = (token: string | null = TOKEN) => ({
  stores: [{ booking_token: token, booking_settings: { open: '10:00', close: '18:00' } }],
});
const ctx = (client: unknown, over: Partial<PageContext> = {}): PageContext => ({
  path: '/resources',
  navigate: () => {},
  client: client as never,
  orgId: 'o1',
  storeId: 's1',
  permissions: ['menu.edit'],
  isOwner: false,
  isPlatformAdmin: false,
  isModuleOn: () => true,
  ...over,
});
const mount = (c: PageContext) =>
  render(
    <I18nProvider initialLang="en">
      <BookingLinkPanel ctx={c} storeId="s1" />
    </I18nProvider>,
  );

describe('<BookingLinkPanel>', () => {
  it('shows the link and the saved hours (defaults filled in)', async () => {
    mount(ctx(fakeDb(tables()).client));
    const link = (await screen.findByLabelText('The shop booking link')) as HTMLInputElement;
    expect(link.value.endsWith(`/book/${TOKEN}`)).toBe(true);
    expect((screen.getByLabelText('Bookings start from (time)') as HTMLInputElement).value).toBe(
      '10:00',
    );
    expect((screen.getByLabelText('Shortest notice (minutes)') as HTMLInputElement).value).toBe(
      '120',
    );
  });

  it('shows a QR of the link for guests to scan and prints the poster with the shop name', async () => {
    const print = vi.fn();
    vi.stubGlobal('print', print);
    mount(ctx(fakeDb({ stores: [{ name: 'Lotus Spa', booking_token: TOKEN }] }).client));
    await screen.findByLabelText('The shop booking link');
    expect(screen.getByRole('img', { name: 'Scan to book online' })).toBeTruthy();
    expect(document.getElementById('print-root')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Print the QR poster' }));
    await waitFor(() => expect(print).toHaveBeenCalled());
    vi.unstubAllGlobals();
  });

  it('says the module is off when it is', async () => {
    mount(ctx(fakeDb(tables()).client, { isModuleOn: () => false }));
    expect(await screen.findByText(/Online booking by guests" is off/)).toBeTruthy();
  });

  it('saves the hours through the database function and says so', async () => {
    const db = fakeDb(tables(), { rpc: { save_booking_settings: { data: { token: TOKEN } } } });
    mount(ctx(db.client));
    fireEvent.change(
      await screen.findByLabelText('Bookings close (the service must end by then)'),
      {
        target: { value: '19:30' },
      },
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save booking settings' }));
    await waitFor(() => expect(db.rpcs).toHaveLength(1));
    expect(db.rpcs[0]).toEqual({
      fn: 'save_booking_settings',
      args: {
        p_store: 's1',
        p: {
          open: '10:00',
          close: '19:30',
          step_min: 30,
          lead_min: 120,
          max_days: 30,
          rotate: false,
        },
      },
    });
    expect(await screen.findByText('Saved')).toBeTruthy();
  });

  it('does not call the database with hours that cannot work', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client));
    fireEvent.change(
      await screen.findByLabelText('Bookings close (the service must end by then)'),
      {
        target: { value: '09:00' },
      },
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save booking settings' }));
    expect(await screen.findByText(/opening must be before closing/)).toBeTruthy();
    expect(db.rpcs).toHaveLength(0);
  });

  it('a new link replaces the one shown', async () => {
    const NEW = 'c'.repeat(32);
    const db = fakeDb(tables(), { rpc: { save_booking_settings: { data: { token: NEW } } } });
    mount(ctx(db.client));
    await userEvent.click(await screen.findByRole('button', { name: /Make a new link/ }));
    await waitFor(() =>
      expect(
        (screen.getByLabelText('The shop booking link') as HTMLInputElement).value.endsWith(NEW),
      ).toBe(true),
    );
    expect((db.rpcs[0]!.args as { p: { rotate: boolean } }).p.rotate).toBe(true);
  });

  it('a shop with no link yet shows none; saving makes the first one', async () => {
    const db = fakeDb(tables(null), { rpc: { save_booking_settings: { data: { token: TOKEN } } } });
    mount(ctx(db.client));
    await screen.findByRole('button', { name: 'Save booking settings' });
    expect(screen.queryByLabelText('The shop booking link')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Save booking settings' }));
    expect(await screen.findByLabelText('The shop booking link')).toBeTruthy();
  });

  it('someone without menu.edit sees the link but no settings form', async () => {
    mount(ctx(fakeDb(tables()).client, { permissions: [] }));
    await screen.findByLabelText('The shop booking link');
    expect(screen.queryByRole('button', { name: 'Save booking settings' })).toBeNull();
  });
});
