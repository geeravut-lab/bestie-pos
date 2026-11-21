import {
  parseKaraokeBookResult,
  parseKaraokeBookStatus,
  parseKaraokeBookingInfo,
  parseKaraokeCancelResult,
  parseSlots,
} from '@bestie/core';
import type {
  KaraokeBookError,
  KaraokeBookResult,
  KaraokeBookStatus,
  KaraokeBookingInfo,
} from '@bestie/core';

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const API = '/api/guest/karaoke-booking';

export type KaraokeBookLoad =
  { ok: true; info: KaraokeBookingInfo } | { ok: false; reason: 'not_found' | 'failed' };

export async function loadKaraokeBooking(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<KaraokeBookLoad> {
  try {
    const res = await fetchImpl(`${API}?t=${encodeURIComponent(token)}`);
    if (res.status === 404) return { ok: false, reason: 'not_found' };
    if (!res.ok) return { ok: false, reason: 'failed' };
    const info = parseKaraokeBookingInfo(obj(await res.json().catch(() => null)).info);
    return info ? { ok: true, info } : { ok: false, reason: 'not_found' };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

/** Free start times ("HH:MM") for a room, a day and a length; `null` = could not load. */
export async function loadKaraokeSlots(
  token: string,
  q: { room: string; date: string; minutes: number },
  fetchImpl: typeof fetch = fetch,
): Promise<string[] | null> {
  try {
    const qs = new URLSearchParams({
      t: token,
      room: q.room,
      date: q.date,
      minutes: String(q.minutes),
    });
    const res = await fetchImpl(`${API}?${qs.toString()}`);
    if (!res.ok) return null;
    return parseSlots(obj(await res.json().catch(() => null)).slots);
  } catch {
    return null;
  }
}

export type KaraokeBookRequest = {
  roomId: string;
  date: string;
  time: string;
  minutes: number;
  name: string;
  phone: string;
  guests: number | null;
  note: string;
  clientId: string;
};
export type KaraokeBookOutcome = KaraokeBookResult | { ok: false; error: 'failed' };

export async function sendKaraokeBooking(
  token: string,
  r: KaraokeBookRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<KaraokeBookOutcome> {
  try {
    const res = await fetchImpl(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        t: token,
        op: 'book',
        room_id: r.roomId,
        date: r.date,
        time: r.time,
        minutes: r.minutes,
        name: r.name,
        phone: r.phone,
        guests: r.guests ?? undefined,
        note: r.note || undefined,
        client_id: r.clientId,
      }),
    });
    if (res.status === 429) return { ok: false, error: 'too_many' };
    if (!res.ok) return { ok: false, error: res.status === 422 ? 'invalid' : 'failed' };
    return parseKaraokeBookResult(obj(await res.json().catch(() => null)).result);
  } catch {
    return { ok: false, error: 'failed' };
  }
}

export async function cancelKaraokeBooking(
  token: string,
  id: string,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; error: KaraokeBookError | 'failed' }> {
  try {
    const res = await fetchImpl(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ t: token, op: 'cancel', id, code }),
    });
    if (!res.ok) return { ok: false, error: 'failed' };
    return parseKaraokeCancelResult(obj(await res.json().catch(() => null)).result);
  } catch {
    return { ok: false, error: 'failed' };
  }
}

export async function loadKaraokeBookStatus(
  token: string,
  id: string,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<KaraokeBookStatus | { ok: false; error: 'failed' }> {
  try {
    const qs = new URLSearchParams({ t: token, id, code });
    const res = await fetchImpl(`${API}?${qs.toString()}`);
    if (!res.ok) return { ok: false, error: 'failed' };
    return parseKaraokeBookStatus(obj(await res.json().catch(() => null)).status);
  } catch {
    return { ok: false, error: 'failed' };
  }
}
