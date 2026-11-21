import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { MODULE_BY_ID } from './modules/registry';
import {
  formatClock,
  isVideoId,
  karaokeAmount,
  karaokeBilledMinutes,
  karaokeLink,
  karaokeSettle,
  karaokeTokenFromPath,
  parseKaraokeRoomView,
  parseKaraokeRooms,
  parseSongHits,
  parseYoutubeId,
} from './karaoke';
import type { StaffSong } from './karaoke';

const TOKEN = 'a'.repeat(32);

describe('room time and amount', () => {
  it('rounds up to a step and never goes below the shortest time', () => {
    expect(karaokeBilledMinutes(0, 60, 15)).toBe(60);
    expect(karaokeBilledMinutes(3600, 60, 15)).toBe(60);
    expect(karaokeBilledMinutes(3601, 60, 15)).toBe(75);
    expect(karaokeBilledMinutes(1, 0, 15)).toBe(15);
    expect(karaokeBilledMinutes(0, 0, 15)).toBe(0);
    expect(karaokeBilledMinutes(4200, 30, 30)).toBe(90);
    expect(karaokeBilledMinutes(-5, 30, 15)).toBe(30);
  });
  it('prices in whole satang, half up', () => {
    expect(karaokeAmount(30000, 75)).toBe(37500);
    expect(karaokeAmount(10000, 20)).toBe(3333);
    expect(karaokeAmount(10001, 1)).toBe(167);
    expect(karaokeAmount(0, 60)).toBe(0);
  });
  it('settles a room the same way the database does (70 min at 300 baht an hour)', () => {
    expect(karaokeSettle(70 * 60, { ratePerHour: 30000, minMinutes: 60, stepMinutes: 15 })).toEqual(
      {
        billedMinutes: 75,
        amount: 37500,
      },
    );
  });
  it('matches the database cases of migration 70 (same numbers as the SQL test)', () => {
    const sql = readFileSync(
      new URL('../../../supabase/tests/karaoke.test.sql', import.meta.url),
      'utf8',
    );
    for (const c of [
      'karaoke_billed_minutes(3601, 60, 15) = 75',
      'karaoke_amount(30000, 75) = 37500',
    ])
      expect(sql).toContain(c);
  });
  it('shows a clock', () => {
    expect(formatClock(0)).toBe('0:00:00');
    expect(formatClock(425)).toBe('0:07:05');
    expect(formatClock(3 * 3600 + 61)).toBe('3:01:01');
    expect(formatClock(-4)).toBe('0:00:00');
  });
});

describe('modules and addresses', () => {
  it('registers rooms (basic) and songs (pro) for the karaoke profile', () => {
    expect(MODULE_BY_ID['karaoke.rooms'].defaultProfiles).toEqual(['karaoke']);
    expect(MODULE_BY_ID['karaoke.rooms'].plan).toBe('basic');
    expect(MODULE_BY_ID['karaoke.songs'].dependsOn).toEqual(['karaoke.rooms']);
    expect(MODULE_BY_ID['karaoke.songs'].plan).toBe('pro');
  });
  it('reads the room token from /r/<token>', () => {
    expect(karaokeTokenFromPath(`/r/${TOKEN}`)).toBe(TOKEN);
    expect(karaokeTokenFromPath(`/r/${TOKEN}/`)).toBe(TOKEN);
    expect(karaokeTokenFromPath('/r/short')).toBeNull();
    expect(karaokeTokenFromPath(`/t/${TOKEN}`)).toBeNull();
    expect(karaokeLink('https://x.example/', TOKEN)).toBe(`https://x.example/r/${TOKEN}`);
  });
});

describe('YouTube links', () => {
  const ID = 'dQw4w9WgXcQ';
  it('finds the id in every common link shape', () => {
    for (const t of [
      ID,
      `https://www.youtube.com/watch?v=${ID}`,
      `https://youtube.com/watch?v=${ID}&t=42s`,
      `https://m.youtube.com/watch?v=${ID}`,
      `https://music.youtube.com/watch?v=${ID}&list=x`,
      `https://youtu.be/${ID}?si=abc`,
      `https://www.youtube.com/shorts/${ID}`,
      `https://www.youtube.com/embed/${ID}`,
      `youtube.com/watch?v=${ID}`,
      `  ${ID}  `,
    ])
      expect(parseYoutubeId(t)).toBe(ID);
  });
  it('refuses everything that is not a video', () => {
    for (const t of [
      '',
      'hello world',
      'https://example.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com/watch?v=short',
      'https://www.youtube.com/@channel',
      'https://evil.example/youtu.be/dQw4w9WgXcQ',
      'javascript:alert(1)',
    ])
      expect(parseYoutubeId(t)).toBeNull();
    expect(isVideoId('dQw4w9WgXcQ')).toBe(true);
    expect(isVideoId('dQw4w9WgXc')).toBe(false);
  });
  it('drops search hits without a real video id', () => {
    expect(
      parseSongHits([
        { videoId: 'dQw4w9WgXcQ', title: ' Song ', channel: 'C' },
        { videoId: 'bad', title: 'x' },
        { videoId: 'AAAAAAAAAAA', title: '' },
        7,
      ]),
    ).toEqual([{ videoId: 'dQw4w9WgXcQ', title: 'Song', channel: 'C' }]);
    expect(parseSongHits(null)).toEqual([]);
  });
});

describe('what the pages read', () => {
  it('reads the guest room view and keeps only real songs', () => {
    const v = parseKaraokeRoomView({
      shop: 'Sing',
      room: 'VIP 1',
      songs_enabled: true,
      running: true,
      elapsed_seconds: 90,
      queue: [
        { id: 'a', video_id: 'dQw4w9WgXcQ', title: 'One', status: 'playing' },
        { id: 'b', video_id: 'nope', title: 'Bad', status: 'queued' },
        { id: 'c', video_id: 'AAAAAAAAAAA', title: 'Done', status: 'done' },
      ],
    });
    expect(v?.queue.map((q) => q.id)).toEqual(['a']);
    expect(v?.elapsedSeconds).toBe(90);
    expect(parseKaraokeRoomView({})).toBeNull();
  });
  it('reads rooms in their order', () => {
    const r = parseKaraokeRooms([
      { id: '2', name: 'B', rate_per_hour: 100, min_minutes: 30, step_minutes: 15, sort: 2 },
      { id: '1', name: 'A', rate_per_hour: 200, min_minutes: 60, step_minutes: 30, sort: 1 },
      { name: 'no id' },
    ]);
    expect(r.map((x) => x.id)).toEqual(['1', '2']);
    expect(r[0]?.stepMinutes).toBe(30);
  });
});

describe('the in-room player', () => {
  const song = (id: string, status: 'queued' | 'playing' | 'done'): StaffSong => ({
    id,
    roomId: 'r',
    videoId: 'dQw4w9WgXcQ',
    title: id,
    status,
    source: 'guest',
  });
  it('plays what the database says is playing, else starts the first waiting song, else idles', async () => {
    const { pickPlayerStep } = await import('./karaoke');
    expect(pickPlayerStep([song('a', 'queued'), song('b', 'playing')])).toMatchObject({
      kind: 'play',
      song: { id: 'b' },
    });
    expect(pickPlayerStep([song('a', 'queued'), song('b', 'queued')])).toMatchObject({
      kind: 'start',
      song: { id: 'a' },
    });
    expect(pickPlayerStep([song('a', 'done')])).toEqual({ kind: 'idle' });
    expect(pickPlayerStep([])).toEqual({ kind: 'idle' });
  });
  it('reads the room id from the player address', async () => {
    const { karaokePlayerRoomFromPath } = await import('./karaoke');
    const id = '11111111-2222-3333-4444-555555555555';
    expect(karaokePlayerRoomFromPath(`/karaoke/player/${id}`)).toBe(id);
    expect(karaokePlayerRoomFromPath('/karaoke/player/nope')).toBeNull();
    expect(karaokePlayerRoomFromPath(`/karaoke/${id}`)).toBeNull();
  });
});

describe('packages, pause and reservations', () => {
  it('bills the package plus the overage, like the database', async () => {
    const m = await import('./karaoke');
    expect(m.karaokeOverageMinutes(3600, 60, 15)).toBe(0);
    expect(m.karaokeOverageMinutes(3601, 60, 15)).toBe(15);
    expect(m.karaokeOverageMinutes(4501, 60, 15)).toBe(30);
    expect(
      m.karaokeSettle(100 * 60, {
        ratePerHour: 30000,
        minMinutes: 60,
        stepMinutes: 15,
        includedMinutes: 90,
        packageTotal: 37000,
      }),
    ).toEqual({ billedMinutes: 105, amount: 44500 });
    expect(
      m.karaokeSettle(20 * 60, {
        ratePerHour: 30000,
        minMinutes: 60,
        stepMinutes: 15,
        includedMinutes: 60,
        packageTotal: 25000,
      }),
    ).toEqual({ billedMinutes: 60, amount: 25000 });
    expect(
      m.karaokeSettle(70 * 60, { ratePerHour: 30000, minMinutes: 60, stepMinutes: 15 }),
    ).toEqual({ billedMinutes: 75, amount: 37500 });
  });
  it('counts the clock without the paused time', async () => {
    const m = await import('./karaoke');
    const base = {
      id: 's',
      roomId: 'r',
      startedAt: '2026-01-01T10:00:00Z',
      endedAt: null,
      guests: null,
      ratePerHour: 1,
      minMinutes: 0,
      stepMinutes: 15,
      billedMinutes: null,
      amount: null,
      orderId: null,
      pausedAt: null,
      pausedSeconds: 600,
      includedMinutes: 0,
      packageTotal: 0,
      packageName: null,
      bookingId: null,
    };
    const now = Date.parse('2026-01-01T11:00:00Z');
    expect(m.sessionElapsedSeconds(base, now)).toBe(3000);
    expect(m.sessionElapsedSeconds({ ...base, pausedAt: '2026-01-01T10:30:00Z' }, now)).toBe(1200);
    expect(m.sessionElapsedSeconds({ ...base, endedAt: '2026-01-01T10:20:00Z' }, now)).toBe(600);
  });
  it('finds a clash between reservations of one room and ignores cancelled ones', async () => {
    const m = await import('./karaoke');
    const b = (id: string, room: string, s: string, e: string, status: string) => ({
      id,
      room_id: room,
      guest_name: 'x',
      starts_at: s,
      ends_at: e,
      status,
    });
    const list = m.parseKaraokeBookings([
      b('1', 'r', '2026-01-01T10:00:00Z', '2026-01-01T11:00:00Z', 'booked'),
      b('2', 'r', '2026-01-01T12:00:00Z', '2026-01-01T13:00:00Z', 'cancelled'),
      b('3', 'q', '2026-01-01T10:00:00Z', '2026-01-01T11:00:00Z', 'booked'),
    ]);
    const t = (s: string) => Date.parse(s);
    expect(
      m.bookingClash(list, 'r', t('2026-01-01T10:30:00Z'), t('2026-01-01T11:30:00Z'))?.id,
    ).toBe('1');
    expect(
      m.bookingClash(list, 'r', t('2026-01-01T11:00:00Z'), t('2026-01-01T12:00:00Z')),
    ).toBeNull();
    expect(
      m.bookingClash(list, 'r', t('2026-01-01T12:30:00Z'), t('2026-01-01T12:45:00Z')),
    ).toBeNull();
  });
  it('reads packages in order and drops broken rows', async () => {
    const m = await import('./karaoke');
    const r = m.parseKaraokePackages([
      { id: 'b', name: '2h', minutes: 120, price: 1, sort: 2 },
      { id: 'a', name: '1h', minutes: 60, price: 1, sort: 1 },
      { id: 'c', name: 'bad', minutes: 0 },
    ]);
    expect(r.map((x) => x.id)).toEqual(['a', 'b']);
  });
});
