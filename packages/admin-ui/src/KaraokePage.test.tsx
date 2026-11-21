import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageContext } from '@bestie/auth';
import { I18nProvider } from '@bestie/i18n';
import { fakeDb } from './fakeDb';
import { KaraokePage } from './KaraokePage';

afterEach(cleanup);

const ctx = (
  client: unknown,
  over: Partial<PageContext> = {},
  nav: (p: string) => void = () => {},
): PageContext => ({
  path: '/karaoke',
  navigate: nav,
  client: client as never,
  orgId: 'o1',
  storeId: 's1',
  permissions: ['order.create', 'menu.edit'],
  isOwner: true,
  isPlatformAdmin: false,
  ...over,
});
/** The fake client plus a Realtime stand-in (subscribing reports SUBSCRIBED; nothing is pushed). */
const liveDb = (...args: Parameters<typeof fakeDb>) => {
  const db = fakeDb(...args);
  const channel = vi.fn(() => {
    const ch: Record<string, unknown> = {};
    ch.on = () => ch;
    ch.subscribe = (cb?: (s: string) => void) => {
      cb?.('SUBSCRIBED');
      return ch;
    };
    return ch;
  });
  Object.assign(db.client as object, { channel, removeChannel: vi.fn(async () => 'ok') });
  return db;
};
const wrap = (ui: React.ReactNode) => render(<I18nProvider initialLang="en">{ui}</I18nProvider>);
const room = (id: string, name: string) => ({
  id,
  name,
  rate_per_hour: 30000,
  min_minutes: 60,
  step_minutes: 15,
  active: true,
  sort: 1,
});
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

describe('<KaraokePage>', () => {
  it('starts a free room with the number of guests', async () => {
    const db = liveDb({ karaoke_rooms: [room('r1', 'VIP 1')], devices: [{ id: 'd1' }] });
    wrap(<KaraokePage ctx={ctx(db.client)} />);
    expect(await screen.findByText('VIP 1')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Guests (optional)'), '4');
    await userEvent.click(screen.getByRole('button', { name: 'Start the timer' }));
    await waitFor(() => expect(db.rpcs.some((r) => r.fn === 'karaoke_start')).toBe(true));
    expect(db.rpcs.find((r) => r.fn === 'karaoke_start')!.args).toEqual({
      p_room: 'r1',
      p_guests: 4,
    });
  });

  it('shows the running clock with the estimate and stops through the database', async () => {
    const db = liveDb({
      karaoke_rooms: [room('r1', 'VIP 1')],
      karaoke_sessions: [
        {
          id: 's9',
          room_id: 'r1',
          started_at: ago(70),
          ended_at: null,
          guests: 3,
          rate_per_hour: 30000,
          min_minutes: 60,
          step_minutes: 15,
          billed_minutes: null,
          amount: null,
          order_id: null,
        },
      ],
    });
    wrap(<KaraokePage ctx={ctx(db.client)} />);
    expect(await screen.findByText(/1:10:0\d/)).toBeTruthy();
    // 70 minutes at 300 baht an hour, rounded up to 75 minutes = 375 baht
    expect(screen.getByText(/Billed 75 minutes/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Stop and bill' }));
    await waitFor(() => expect(db.rpcs.some((r) => r.fn === 'karaoke_stop')).toBe(true));
    expect(db.rpcs.find((r) => r.fn === 'karaoke_stop')!.args).toEqual({ p_session: 's9' });
  });

  it('opens the bill of a stopped room on the till', async () => {
    const nav: string[] = [];
    const db = liveDb(
      {
        karaoke_rooms: [room('r1', 'VIP 1')],
        devices: [{ id: 'd1' }],
        karaoke_sessions: [
          {
            id: 's9',
            room_id: 'r1',
            started_at: ago(80),
            ended_at: ago(5),
            guests: null,
            rate_per_hour: 30000,
            min_minutes: 60,
            step_minutes: 15,
            billed_minutes: 75,
            amount: 37500,
            order_id: null,
          },
        ],
      },
      { rpc: { karaoke_to_order: { data: 'order-7' } } },
    );
    wrap(<KaraokePage ctx={ctx(db.client, {}, (p) => nav.push(p))} />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Open the bill to take payment' }),
    );
    await waitFor(() => expect(nav).toEqual(['/order/order-7']));
    expect(db.rpcs.find((r) => r.fn === 'karaoke_to_order')!.args).toEqual({
      p_session: 's9',
      p_device: 'd1',
    });
  });

  it('moves songs along and links to the video', async () => {
    const db = liveDb({
      karaoke_rooms: [room('r1', 'VIP 1')],
      karaoke_songs: [
        {
          id: 'g1',
          room_id: 'r1',
          video_id: 'dQw4w9WgXcQ',
          title: 'Song one',
          status: 'queued',
          source: 'guest',
        },
      ],
    });
    wrap(<KaraokePage ctx={ctx(db.client)} />);
    const link = await screen.findByRole('link', { name: 'Open on YouTube' });
    expect(link.getAttribute('href')).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(link.getAttribute('rel')).toContain('noopener');
    await userEvent.click(screen.getByRole('button', { name: 'Play this song' }));
    await waitFor(() => expect(db.rpcs.some((r) => r.fn === 'karaoke_song_set')).toBe(true));
    expect(db.rpcs.find((r) => r.fn === 'karaoke_song_set')!.args).toEqual({
      p_song: 'g1',
      p_status: 'playing',
    });
  });

  it('saves a new room with the price in satang', async () => {
    const db = liveDb({ karaoke_rooms: [] });
    wrap(<KaraokePage ctx={ctx(db.client)} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Add a room' }));
    const form = screen.getByRole('form', { name: 'Edit the room' });
    await userEvent.type(within(form).getByLabelText('Room name'), 'Party room');
    await userEvent.type(within(form).getByLabelText('Price per hour (baht)'), '450');
    await userEvent.click(within(form).getByRole('button', { name: 'Save the room' }));
    await waitFor(() => expect(db.rpcs.some((r) => r.fn === 'save_karaoke_room')).toBe(true));
    expect(db.rpcs.find((r) => r.fn === 'save_karaoke_room')!.args).toMatchObject({
      p: {
        store_id: 's1',
        id: null,
        name: 'Party room',
        rate_per_hour: 45000,
        min_minutes: 60,
        step_minutes: 15,
      },
    });
  });

  it('hides start and stop from a person who may not take orders', async () => {
    const db = liveDb({ karaoke_rooms: [room('r1', 'VIP 1')] });
    wrap(<KaraokePage ctx={ctx(db.client, { permissions: [], isOwner: false })} />);
    await screen.findByText('VIP 1');
    expect(screen.queryByRole('button', { name: 'Start the timer' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add a room' })).toBeNull();
  });
});
