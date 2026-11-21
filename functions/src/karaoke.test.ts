import { describe, expect, it, vi } from 'vitest';
import { decodeTitle, guestKaraokeResponse, searchSongs, videoTitle } from './karaoke-handler.js';

const env = {
  SUPABASE_URL: 'https://db.test',
  SUPABASE_SERVICE_ROLE_KEY: 'srv',
  YOUTUBE_API_KEY: 'yt-key',
};
const T = 'b'.repeat(32);
const ID = 'dQw4w9WgXcQ';
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
const ip = () => `7.7.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const get = (qs: string) =>
  new Request(`https://x.test/api/guest/karaoke?${qs}`, { headers: { 'x-forwarded-for': ip() } });
const post = (body: unknown) =>
  new Request('https://x.test/api/guest/karaoke', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'x-forwarded-for': ip() },
  });
const room = (over: Record<string, unknown> = {}) => ({
  shop: 'S',
  room: 'VIP 1',
  songs_enabled: true,
  running: true,
  elapsed_seconds: 5,
  queue: [],
  ...over,
});

/** A fake network: the database answers by function name, YouTube by host. */
const net = (opts: { room?: unknown; add?: unknown; oembed?: number; search?: unknown } = {}) =>
  vi.fn(async (input: unknown) => {
    const u = String(input);
    if (u.includes('/rpc/guest_karaoke_room')) return json('room' in opts ? opts.room : room());
    if (u.includes('/rpc/guest_karaoke_request'))
      return json(opts.add ?? { ok: true, id: 'song-1' });
    if (u.includes('/rpc/guest_karaoke_remove')) return json(true);
    if (u.includes('youtube.com/oembed'))
      return opts.oembed === 404 ? json({}, 404) : json({ title: 'Real &amp; True Title' });
    if (u.includes('googleapis.com/youtube'))
      return json(
        opts.search ?? {
          items: [
            {
              id: { videoId: ID },
              snippet: { title: 'Song &quot;A&quot; karaoke', channelTitle: 'Ch' },
            },
            { id: {}, snippet: { title: 'no id' } },
          ],
        },
      );
    return json({}, 500);
  });

describe('GET the room page', () => {
  it('returns the room, 422 for a bad token and 404 for an unknown room', async () => {
    const r = await guestKaraokeResponse(get(`t=${T}`), env, { fetchImpl: net() as never });
    expect(((await r.json()) as { room: { room: string } }).room.room).toBe('VIP 1');
    expect((await guestKaraokeResponse(get('t=zz'), env)).status).toBe(422);
    const none = await guestKaraokeResponse(get(`t=${T}`), env, {
      fetchImpl: net({ room: null }) as never,
    });
    expect(none.status).toBe(404);
  });
});

describe('search', () => {
  it('finds real songs, decodes the title and adds the word karaoke', async () => {
    const f = net();
    const r = await guestKaraokeResponse(get(`t=${T}&q=${encodeURIComponent('Let it be')}`), env, {
      fetchImpl: f as never,
    });
    const body = (await r.json()) as {
      available: boolean;
      songs: { videoId: string; title: string }[];
    };
    expect(body.available).toBe(true);
    expect(body.songs).toEqual([{ videoId: ID, title: 'Song "A" karaoke', channel: 'Ch' }]);
    const yt = String(f.mock.calls.map((c) => String(c[0])).find((u) => u.includes('googleapis')));
    expect(yt).toContain('Let+it+be+karaoke');
    expect(yt).toContain('videoEmbeddable=true');
  });
  it('is unavailable without a key, for a room not in use, or with the songs module off — and spends no quota then', async () => {
    const f = net();
    const noKey = await guestKaraokeResponse(
      get(`t=${T}&q=hello`),
      { ...env, YOUTUBE_API_KEY: '' },
      { fetchImpl: f as never },
    );
    expect(((await noKey.json()) as { reason: string }).reason).toBe('no_key');
    for (const over of [{ running: false }, { songs_enabled: false }]) {
      const g = net({ room: room(over) });
      const r = await guestKaraokeResponse(get(`t=${T}&q=hello`), env, { fetchImpl: g as never });
      expect(((await r.json()) as { available: boolean }).available).toBe(false);
      expect(g.mock.calls.some((c) => String(c[0]).includes('googleapis'))).toBe(false);
    }
  });
  it('reports a spent YouTube quota and caches repeated searches', async () => {
    const quota = vi.fn(async () =>
      json({ error: { errors: [{ reason: 'quotaExceeded' }] } }, 403),
    );
    expect(await searchSongs(quota as never, 'k', 'quota words')).toEqual({
      ok: false,
      reason: 'quota',
    });
    const ok = net();
    await searchSongs(ok as never, 'k', 'cached words');
    await searchSongs(ok as never, 'k', 'Cached Words');
    expect(ok.mock.calls.length).toBe(1);
  });
  it('ignores a one-letter query', async () => {
    const f = net();
    const r = await guestKaraokeResponse(get(`t=${T}&q=a`), env, { fetchImpl: f as never });
    expect(((await r.json()) as { songs: unknown[] }).songs).toEqual([]);
    expect(f.mock.calls.some((c) => String(c[0]).includes('googleapis'))).toBe(false);
  });
});

describe('adding a song', () => {
  it('takes a pasted link, uses YouTube’s own title and passes the rules to the database', async () => {
    const f = net();
    const r = await guestKaraokeResponse(
      post({
        t: T,
        link: `https://youtu.be/${ID}`,
        client_id: '11111111-1111-1111-1111-111111111111',
        title: 'FAKE TITLE FROM THE PHONE',
      }),
      env,
      { fetchImpl: f as never },
    );
    expect(((await r.json()) as { ok: boolean; title: string }).title).toBe('Real & True Title');
    const call = f.mock.calls.find((c) =>
      String(c[0]).includes('guest_karaoke_request'),
    ) as unknown[];
    const sent = JSON.parse(String((call[1] as RequestInit).body)) as {
      p: { video_id: string; title: string };
    };
    expect(sent.p).toMatchObject({ video_id: ID, title: 'Real & True Title' });
  });
  it('refuses text that is not a video and a video YouTube does not know', async () => {
    const bad = await guestKaraokeResponse(post({ t: T, link: 'hello there' }), env, {
      fetchImpl: net() as never,
    });
    expect(((await bad.json()) as { error: string }).error).toBe('invalid');
    const gone = await guestKaraokeResponse(post({ t: T, link: ID }), env, {
      fetchImpl: net({ oembed: 404 }) as never,
    });
    expect(((await gone.json()) as { error: string }).error).toBe('invalid');
  });
  it('passes the database’s refusal on', async () => {
    for (const error of ['full', 'repeat', 'not_in_use', 'rate']) {
      const r = await guestKaraokeResponse(post({ t: T, link: ID }), env, {
        fetchImpl: net({ add: { ok: false, error } }) as never,
      });
      expect(((await r.json()) as { error: string }).error).toBe(error);
    }
  });
  it('takes a waiting song off', async () => {
    const r = await guestKaraokeResponse(
      post({ t: T, remove: '11111111-1111-1111-1111-111111111111' }),
      env,
      { fetchImpl: net() as never },
    );
    expect(((await r.json()) as { ok: boolean }).ok).toBe(true);
    expect((await guestKaraokeResponse(post({ t: T, remove: 'x' }), env)).status).toBe(422);
  });
});

describe('helpers', () => {
  it('decodes YouTube’s escaped titles', () => {
    expect(decodeTitle('Tom &amp; Jerry &#39;s  &quot;hit&quot;')).toBe('Tom & Jerry \'s "hit"');
  });
  it('asks oEmbed for the title and gives null on a failure', async () => {
    expect(await videoTitle(net() as never, ID)).toBe('Real & True Title');
    expect(await videoTitle(net({ oembed: 404 }) as never, ID)).toBeNull();
    expect(
      await videoTitle(
        (async () => {
          throw new Error('x');
        }) as never,
        ID,
      ),
    ).toBeNull();
  });
});
