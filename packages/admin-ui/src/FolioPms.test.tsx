import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageContext } from '@bestie/auth';
import { I18nProvider } from '@bestie/i18n';
import { fakeDb } from './fakeDb';
import { FolioPage } from './FolioPage';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const build = (pmsOn = true) => {
  const db = fakeDb(
    {
      folio_rooms: [
        { id: 'r1', store_id: 'resort', name: '101', active: true, sort: 1, night_rate: 150000 },
      ],
      folios: [],
      folio_charges: [],
    },
    { rpc: { folio_check_in: { data: 'f-new' } } },
  );
  Object.assign(db.client as object, {
    auth: { getSession: async () => ({ data: { session: { access_token: 'jwt' } } }) },
    channel: vi.fn(() => {
      const ch: Record<string, unknown> = {};
      ch.on = () => ch;
      ch.subscribe = (cb?: (s: string) => void) => {
        cb?.('SUBSCRIBED');
        return ch;
      };
      return ch;
    }),
    removeChannel: vi.fn(async () => 'ok'),
  });
  const ctx: PageContext = {
    path: '/folio',
    navigate: () => {},
    client: db.client as never,
    orgId: 'o1',
    storeId: 'resort',
    permissions: ['order.create', 'payment.take', 'menu.edit', 'refund.create'],
    isOwner: true,
    isPlatformAdmin: false,
    isModuleOn: (id: string) => (id === 'pms' ? pmsOn : true),
  } as PageContext;
  render(
    <I18nProvider initialLang="en">
      <FolioPage ctx={ctx} />
    </I18nProvider>,
  );
  return db;
};

describe('<FolioPage> PMS import', () => {
  it('has no import button when the PMS module is off', async () => {
    build(false);
    await screen.findByRole('button', { name: 'Check a guest in' }).catch(() => null);
    expect(screen.queryByRole('button', { name: 'Import from the hotel system (PMS)' })).toBeNull();
  });

  it('imports a guest, checks them in and links the reservation', async () => {
    const f = vi.fn(async () =>
      Response.json({
        available: true,
        provider: 'mews',
        guests: [
          {
            reservationId: 'RV9',
            guestName: 'Anna Berg',
            room: '101',
            checkIn: '2026-11-20',
            checkOut: '2026-11-23T05:00:00Z',
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', f);
    const db = build();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Import from the hotel system (PMS)' }),
    );
    expect(f).toHaveBeenCalledWith('/api/pms/in-house?store=resort', {
      headers: { Authorization: 'Bearer jwt' },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Check this guest in' }));
    // the form is filled in from the PMS: guest name, room 101 and the check-out date
    expect((await screen.findByDisplayValue('Anna Berg')) as HTMLInputElement).toBeTruthy();
    expect(screen.getByDisplayValue('2026-11-23')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Check in' }));
    await waitFor(() => expect(db.rpcs.some((c) => c.fn === 'folio_link_pms')).toBe(true));
    expect(db.rpcs.find((c) => c.fn === 'folio_link_pms')!.args).toEqual({
      p_folio: 'f-new',
      p_reservation: 'RV9',
    });
  });

  it('says so when the PMS is not set up', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ available: false })),
    );
    build();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Import from the hotel system (PMS)' }),
    );
    expect(await screen.findByText(/not set up yet/)).toBeTruthy();
  });
});
