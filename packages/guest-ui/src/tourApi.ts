import { parseTourBookResult, parseTourOnlineInfo, parseTourStatus } from '@bestie/core';
import type { TourBookResult, TourOnlineInfo, TourStatus } from '@bestie/core';

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const API = '/api/guest/tour';

export type TourLoad =
  { ok: true; info: TourOnlineInfo } | { ok: false; reason: 'not_found' | 'failed' };

export async function loadTourPage(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TourLoad> {
  try {
    const res = await fetchImpl(`${API}?t=${encodeURIComponent(token)}`);
    if (res.status === 404) return { ok: false, reason: 'not_found' };
    if (!res.ok) return { ok: false, reason: 'failed' };
    const info = parseTourOnlineInfo(obj(await res.json().catch(() => null)).info);
    return info ? { ok: true, info } : { ok: false, reason: 'not_found' };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

export type TourBookRequest = {
  slotId: string;
  seats: number;
  name: string;
  phone: string;
  clientId: string;
};
export type TourBookOutcome = TourBookResult;

export async function sendTourBooking(
  token: string,
  r: TourBookRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<TourBookOutcome> {
  try {
    const res = await fetchImpl(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        t: token,
        op: 'book',
        slot_id: r.slotId,
        seats: r.seats,
        name: r.name,
        phone: r.phone,
        client_id: r.clientId,
      }),
    });
    if (res.status === 429) return { ok: false, error: 'too_many' };
    if (!res.ok) return { ok: false, error: res.status === 422 ? 'invalid' : 'failed' };
    return parseTourBookResult(obj(await res.json().catch(() => null)).result);
  } catch {
    return { ok: false, error: 'failed' };
  }
}

export async function cancelTourBooking(
  token: string,
  id: string,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetchImpl(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ t: token, op: 'cancel', id, code }),
    });
    if (!res.ok) return { ok: false, error: 'failed' };
    const r = obj(obj(await res.json().catch(() => null)).result);
    return r.ok === true ? { ok: true } : { ok: false, error: String(r.error ?? 'failed') };
  } catch {
    return { ok: false, error: 'failed' };
  }
}

export async function loadTourStatus(
  token: string,
  id: string,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TourStatus | 'failed'> {
  try {
    const qs = new URLSearchParams({ t: token, id, code });
    const res = await fetchImpl(`${API}?${qs.toString()}`);
    if (!res.ok) return 'failed';
    return parseTourStatus(obj(await res.json().catch(() => null)).status);
  } catch {
    return 'failed';
  }
}
