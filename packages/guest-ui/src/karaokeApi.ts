import { asAddError, parseKaraokeRoomView, parseSongHits } from '@bestie/core';
import type { KaraokeAddError, KaraokeRoomView, SongHit } from '@bestie/core';

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export type RoomLoad =
  { ok: true; room: KaraokeRoomView } | { ok: false; reason: 'not_found' | 'failed' };

export async function loadKaraokeRoom(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RoomLoad> {
  try {
    const res = await fetchImpl(`/api/guest/karaoke?t=${encodeURIComponent(token)}`);
    if (res.status === 404) return { ok: false, reason: 'not_found' };
    if (!res.ok) return { ok: false, reason: 'failed' };
    const room = parseKaraokeRoomView(obj(await res.json().catch(() => null)).room);
    return room ? { ok: true, room } : { ok: false, reason: 'not_found' };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

export type SearchResult =
  | { ok: true; songs: SongHit[] }
  | { ok: false; reason: 'off' | 'no_key' | 'quota' | 'rate' | 'failed' };

export async function searchKaraokeSongs(
  token: string,
  words: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SearchResult> {
  try {
    const res = await fetchImpl(
      `/api/guest/karaoke?t=${encodeURIComponent(token)}&q=${encodeURIComponent(words)}`,
    );
    if (res.status === 429) return { ok: false, reason: 'rate' };
    if (!res.ok) return { ok: false, reason: 'failed' };
    const o = obj(await res.json().catch(() => null));
    if (o.available === true) return { ok: true, songs: parseSongHits(o.songs) };
    const r = String(o.reason ?? '');
    return { ok: false, reason: r === 'off' || r === 'no_key' || r === 'quota' ? r : 'failed' };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

export type AddResult =
  { ok: true; title: string } | { ok: false; error: KaraokeAddError | 'rate_limited' | 'failed' };

/** Queue a song by its YouTube link (or video id). The server checks the video is real and takes YouTube's own title. */
export async function addKaraokeSong(
  token: string,
  link: string,
  clientId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AddResult> {
  try {
    const res = await fetchImpl('/api/guest/karaoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ t: token, link, client_id: clientId }),
    });
    if (res.status === 429) return { ok: false, error: 'rate_limited' };
    const o = obj(await res.json().catch(() => null));
    if (o.ok === true) return { ok: true, title: typeof o.title === 'string' ? o.title : '' };
    return { ok: false, error: asAddError(o.error) ?? 'failed' };
  } catch {
    return { ok: false, error: 'failed' };
  }
}

export async function removeKaraokeSong(
  token: string,
  songId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl('/api/guest/karaoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ t: token, remove: songId }),
    });
    return res.ok && obj(await res.json().catch(() => null)).ok === true;
  } catch {
    return false;
  }
}
