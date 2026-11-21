import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageContext } from '@bestie/auth';
import { I18nProvider } from '@bestie/i18n';
import { fakeDb } from './fakeDb';
import { KaraokePlayerPage } from './KaraokePlayerPage';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as unknown as { YT?: unknown }).YT;
});

const ROOM = '11111111-2222-3333-4444-555555555555';
const ctx = (client: unknown): PageContext => ({
  path: `/karaoke/player/${ROOM}`,
  navigate: () => {},
  client: client as never,
  orgId: 'o1',
  storeId: 's1',
  permissions: ['order.create'],
  isOwner: false,
  isPlatformAdmin: false,
});
const song = (id: string, status: string, video = 'dQw4w9WgXcQ') => ({
  id,
  room_id: ROOM,
  video_id: video,
  title: `Song ${id}`,
  status,
  source: 'guest',
});

type Events = {
  onStateChange?: (e: { data: number }) => void;
  onError?: (e: { data: number }) => void;
};
/** A stand-in for YouTube's IFrame API that records what the page asks of it. */
const fakeYt = () => {
  const loaded: string[] = [];
  let events: Events = {};
  class Player {
    constructor(_el: unknown, opts: { events?: Events }) {
      events = opts.events ?? {};
    }
    loadVideoById(id: string) {
      loaded.push(id);
    }
    playVideo() {}
    destroy() {}
  }
  (window as unknown as { YT: unknown }).YT = { Player };
  return { loaded, events: () => events };
};
const liveDb = (tables: Record<string, unknown[]>) => {
  const db = fakeDb(tables);
  Object.assign(db.client as object, {
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
  return db;
};
const wrap = (db: ReturnType<typeof fakeDb>) =>
  render(
    <I18nProvider initialLang="en">
      <KaraokePlayerPage ctx={ctx(db.client)} roomId={ROOM} />
    </I18nProvider>,
  );
const rooms = [
  {
    id: ROOM,
    name: 'VIP 1',
    rate_per_hour: 30000,
    min_minutes: 60,
    step_minutes: 15,
    active: true,
    sort: 1,
  },
];

describe('<KaraokePlayerPage>', () => {
  it('waits for a tap, then shows the video the database says is playing', async () => {
    const yt = fakeYt();
    const db = liveDb({
      karaoke_rooms: rooms,
      karaoke_sessions: [{ id: 's' }],
      karaoke_songs: [song('a', 'playing', 'AAAAAAAAAAA'), song('b', 'queued')],
    });
    wrap(db);
    expect(await screen.findByRole('heading', { name: 'Player for room VIP 1' })).toBeTruthy();
    expect(yt.loaded).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Start playing' }));
    await waitFor(() => expect(yt.loaded).toEqual(['AAAAAAAAAAA']));
    expect(screen.getByText('Song b')).toBeTruthy();
  });

  it('starts the first waiting song when nothing is playing', async () => {
    fakeYt();
    const db = liveDb({
      karaoke_rooms: rooms,
      karaoke_sessions: [{ id: 's' }],
      karaoke_songs: [song('a', 'queued')],
    });
    wrap(db);
    await userEvent.click(await screen.findByRole('button', { name: 'Start playing' }));
    await waitFor(() => expect(db.rpcs.some((r) => r.fn === 'karaoke_song_set')).toBe(true));
    expect(db.rpcs.find((r) => r.fn === 'karaoke_song_set')!.args).toEqual({
      p_song: 'a',
      p_status: 'playing',
    });
  });

  it('marks the song done when the video ends and removes one that cannot be embedded', async () => {
    const yt = fakeYt();
    const db = liveDb({
      karaoke_rooms: rooms,
      karaoke_sessions: [{ id: 's' }],
      karaoke_songs: [song('a', 'playing')],
    });
    wrap(db);
    await userEvent.click(await screen.findByRole('button', { name: 'Start playing' }));
    await waitFor(() => expect(yt.loaded.length).toBe(1));
    yt.events().onStateChange?.({ data: 0 });
    await waitFor(() => expect(db.rpcs.some((r) => r.fn === 'karaoke_song_set')).toBe(true));
    expect(db.rpcs.find((r) => r.fn === 'karaoke_song_set')!.args).toEqual({
      p_song: 'a',
      p_status: 'done',
    });
    yt.events().onStateChange?.({ data: 1 }); // playing: nothing happens
    expect(db.rpcs.filter((r) => r.fn === 'karaoke_song_set').length).toBe(1);
    yt.events().onError?.({ data: 150 });
    await waitFor(() => expect(db.rpcs.filter((r) => r.fn === 'karaoke_song_set').length).toBe(2));
    expect(db.rpcs.filter((r) => r.fn === 'karaoke_song_set')[1]!.args).toEqual({
      p_song: 'a',
      p_status: 'removed',
    });
    expect(await screen.findByText(/cannot be played outside YouTube/)).toBeTruthy();
  });

  it('plays nothing while the room has no running timer', async () => {
    const yt = fakeYt();
    const db = liveDb({
      karaoke_rooms: rooms,
      karaoke_sessions: [],
      karaoke_songs: [song('a', 'queued')],
    });
    wrap(db);
    await userEvent.click(await screen.findByRole('button', { name: 'Start playing' }));
    expect(await screen.findByText(/timer for this room has not started/)).toBeTruthy();
    expect(yt.loaded).toEqual([]);
    expect(db.rpcs.length).toBe(0);
  });
});
