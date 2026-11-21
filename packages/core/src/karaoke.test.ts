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
