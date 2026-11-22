// Vercel Function for the karaoke room page on a guest's phone (no account; the room's QR token is the only key):
//   GET  /api/guest/karaoke?t=<token>              → { room }                     the room, its clock and the song queue
//   GET  /api/guest/karaoke?t=<token>&q=<words>    → { available, songs }         search real songs (YouTube Data API, needs YOUTUBE_API_KEY)
//   POST /api/guest/karaoke { t, link, client_id } → { ok, id?, error?, title? }  add a song by pasted link / search result (its video id)
//   POST /api/guest/karaoke { t, remove }          → { ok }                       take a waiting song off
// A song is only ever a REAL YouTube video: its id is checked against YouTube's oEmbed answer, and the title shown is YouTube's, not the phone's.
// Queue rules (room in use, 3 waiting, no repeat, rate) are the database's (`karaoke_add_song`).
import { readServerEnv } from './env.js';
import { clientKey, jsonObject, rpc } from './guest-extras-handler.js';
import { createRateLimiter } from './line.js';
import {
  asAddError,
  parseKaraokeRoomView,
  parseSongHits,
  parseYoutubeId,
} from '../../packages/core/src/karaoke.js';
import type { SongHit } from '../../packages/core/src/karaoke.js';

type Env = Record<string, string | undefined>;
const HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: HEADERS });
const TOKEN = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type KaraokeDeps = { fetchImpl?: typeof fetch };
const allowRead = createRateLimiter(120, 60_000);
const allowSearch = createRateLimiter(15, 60_000);
const allowSearchRoom = createRateLimiter(40, 10 * 60_000);
const allowWrite = createRateLimiter(20, 60_000);

const SEARCH_CACHE = new Map<string, { at: number; songs: SongHit[] }>();
const CACHE_MS = 10 * 60_000;

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
};
/** YouTube returns HTML-escaped titles in search results. */
export const decodeTitle = (s: string): string =>
  s
    .replace(/&(?:amp|lt|gt|quot|apos|#39);/g, (m) => ENTITIES[m] ?? m)
    .replace(/\s+/g, ' ')
    .trim();

/** The title YouTube itself gives a video (oEmbed needs no key); null when the video does not exist or may not be embedded. */
export async function videoTitle(f: typeof fetch, videoId: string): Promise<string | null> {
  try {
    const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`;
    const res = await f(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const o: unknown = await res.json().catch(() => null);
    const t = o && typeof o === 'object' ? (o as { title?: unknown }).title : null;
    return typeof t === 'string' && t.trim() ? decodeTitle(t).slice(0, 150) : null;
  } catch {
    return null;
  }
}

/** Search real songs; the word "karaoke" is added so the results are sing-along versions. */
export async function searchSongs(
  f: typeof fetch,
  key: string,
  words: string,
): Promise<{ ok: true; songs: SongHit[] } | { ok: false; reason: 'quota' | 'failed' }> {
  const cacheKey = words.toLowerCase();
  const hit = SEARCH_CACHE.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) return { ok: true, songs: hit.songs };
  const u = new URL('https://www.googleapis.com/youtube/v3/search');
  u.searchParams.set('part', 'snippet');
  u.searchParams.set('type', 'video');
  u.searchParams.set('videoCategoryId', '10');
  u.searchParams.set('videoEmbeddable', 'true');
  u.searchParams.set('safeSearch', 'moderate');
  u.searchParams.set('maxResults', '8');
  u.searchParams.set('q', /karaoke/i.test(words) ? words : `${words} karaoke`);
  u.searchParams.set('key', key);
  try {
    const res = await f(u.toString(), { signal: AbortSignal.timeout(6000) });
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const reason = JSON.stringify(data ?? '').includes('quotaExceeded') ? 'quota' : 'failed';
      return { ok: false, reason };
    }
    const items = (data as { items?: unknown })?.items;
    const raw = Array.isArray(items)
      ? items.map((x) => {
          const o = x as {
            id?: { videoId?: unknown };
            snippet?: { title?: unknown; channelTitle?: unknown };
          };
          return {
            videoId: o.id?.videoId,
            title: decodeTitle(String(o.snippet?.title ?? '')),
            channel: decodeTitle(String(o.snippet?.channelTitle ?? '')),
          };
        })
      : [];
    const songs = parseSongHits(raw);
    if (SEARCH_CACHE.size > 200) SEARCH_CACHE.clear();
    SEARCH_CACHE.set(cacheKey, { at: Date.now(), songs });
    return { ok: true, songs };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

export async function guestKaraokeResponse(
  request: Request,
  env: Env = process.env,
  deps: KaraokeDeps = {},
): Promise<Response> {
  const f = deps.fetchImpl ?? fetch;
  const ip = clientKey(request);
  try {
    const { supabaseUrl, serviceRoleKey } = readServerEnv(env);
    if (request.method === 'GET') {
      if (!allowRead(`karaoke:${ip}`)) return reply({ error: 'rate_limited' }, 429);
      const sp = new URL(request.url).searchParams;
      const t = sp.get('t') ?? '';
      if (!TOKEN.test(t)) return reply({ error: 'invalid' }, 422);
      const r = await rpc(f, supabaseUrl, serviceRoleKey, 'guest_karaoke_room', { p_token: t });
      if (!r.ok) return reply({ error: 'server_error' }, 502);
      const room = parseKaraokeRoomView(r.data);
      if (!room) return reply({ error: 'not_found' }, 404);
      const q = sp.get('q');
      if (q === null) return reply({ room: r.data });
      // a search costs YouTube quota: only for a room that is in use, with the songs module on, and at a modest rate
      const words = q.replace(/\s+/g, ' ').trim().slice(0, 80);
      if (words.length < 2) return reply({ available: true, songs: [] });
      if (!room.songsEnabled || !room.running)
        return reply({ available: false, reason: 'off', songs: [] });
      if (!allowSearch(`karaoke-s:${ip}`) || !allowSearchRoom(`karaoke-s:${t}`))
        return reply({ error: 'rate_limited' }, 429);
      const key = env.YOUTUBE_API_KEY?.trim();
      if (!key) return reply({ available: false, reason: 'no_key', songs: [] });
      const found = await searchSongs(f, key, words);
      if (!found.ok) return reply({ available: false, reason: found.reason, songs: [] });
      return reply({ available: true, songs: found.songs });
    }
    if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
    const b = await jsonObject(request, 2000);
    if (!b || typeof b.t !== 'string' || !TOKEN.test(b.t)) return reply({ error: 'invalid' }, 422);
    if (!allowWrite(`karaoke-w:${ip}`)) return reply({ error: 'rate_limited' }, 429);
    if (typeof b.remove === 'string') {
      if (!UUID.test(b.remove)) return reply({ ok: false, error: 'invalid' }, 422);
      const r = await rpc(f, supabaseUrl, serviceRoleKey, 'guest_karaoke_remove', {
        p_token: b.t,
        p_song: b.remove,
      });
      return r.ok ? reply({ ok: r.data === true }) : reply({ error: 'server_error' }, 502);
    }
    const videoId = parseYoutubeId(typeof b.link === 'string' ? b.link : '');
    if (!videoId) return reply({ ok: false, error: 'invalid' });
    const title = await videoTitle(f, videoId);
    if (!title) return reply({ ok: false, error: 'invalid' });
    const clientId = typeof b.client_id === 'string' && UUID.test(b.client_id) ? b.client_id : null;
    const r = await rpc(f, supabaseUrl, serviceRoleKey, 'guest_karaoke_request', {
      p_token: b.t,
      p: { video_id: videoId, title, client_id: clientId },
    });
    if (!r.ok) return reply({ error: 'server_error' }, 502);
    const o = (r.data && typeof r.data === 'object' ? r.data : {}) as Record<string, unknown>;
    if (o.ok === true) return reply({ ok: true, id: o.id, title });
    return reply({ ok: false, error: asAddError(o.error) ?? 'unavailable' });
  } catch {
    return reply({ error: 'server_error' }, 502);
  }
}
