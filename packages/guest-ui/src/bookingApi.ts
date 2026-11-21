import { parseBookingInfo, parseBookingResult, parseCancelResult, parseSlots } from '@bestie/core';
import type { BookingInfo, BookingResult, CancelResult } from '@bestie/core';

export type BookingLoad =
  | { ok: true; info: BookingInfo; lineBasicId: string | null }
  | { ok: false; reason: 'not_found' | 'failed' };

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export async function loadBooking(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BookingLoad> {
  try {
    const res = await fetchImpl(`/api/guest/booking?t=${encodeURIComponent(token)}`);
    if (res.status === 404) return { ok: false, reason: 'not_found' };
    if (!res.ok) return { ok: false, reason: 'failed' };
    const body = obj(await res.json().catch(() => null));
    const info = parseBookingInfo(body.info);
    const basic = typeof body.lineBasicId === 'string' ? body.lineBasicId : null;
    return info ? { ok: true, info, lineBasicId: basic } : { ok: false, reason: 'not_found' };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

/** Free start times ("HH:MM") for a service on a day; `null` = could not load. */
export async function loadSlots(
  token: string,
  q: { service: string; provider: string; date: string },
  fetchImpl: typeof fetch = fetch,
): Promise<string[] | null> {
  try {
    const qs = new URLSearchParams({ t: token, service: q.service, date: q.date });
    if (q.provider) qs.set('provider', q.provider);
    const res = await fetchImpl(`/api/guest/booking?${qs.toString()}`);
    if (!res.ok) return null;
    return parseSlots(obj(await res.json().catch(() => null)).slots);
  } catch {
    return null;
  }
}

export type BookRequest = {
  serviceId: string;
  providerId: string;
  date: string;
  time: string;
  name: string;
  phone: string;
  note: string;
  clientId: string;
};

export async function sendBooking(
  token: string,
  r: BookRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<BookingResult> {
  try {
    const res = await fetchImpl('/api/guest/booking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        t: token,
        op: 'book',
        service_id: r.serviceId,
        provider_id: r.providerId || undefined,
        date: r.date,
        time: r.time,
        name: r.name,
        phone: r.phone,
        note: r.note || undefined,
        client_id: r.clientId,
      }),
    });
    if (res.status === 429) return { ok: false, error: 'too_many' };
    if (!res.ok) return { ok: false, error: res.status === 422 ? 'invalid' : 'failed' };
    return parseBookingResult(obj(await res.json().catch(() => null)).result);
  } catch {
    return { ok: false, error: 'failed' };
  }
}

export async function cancelBooking(
  token: string,
  id: string,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CancelResult> {
  try {
    const res = await fetchImpl('/api/guest/booking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ t: token, op: 'cancel', id, code }),
    });
    if (!res.ok) return { ok: false, error: 'failed' };
    return parseCancelResult(obj(await res.json().catch(() => null)).result);
  } catch {
    return { ok: false, error: 'failed' };
  }
}

export type ContactResult =
  { ok: true } | { ok: false; error: 'bad_email' | 'closed' | 'invalid' | 'failed' };

/** Save (or, with an empty string, remove) the e-mail for the reminder of this booking; the booking code is the proof. */
export async function saveContact(
  token: string,
  id: string,
  code: string,
  email: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ContactResult> {
  try {
    const res = await fetchImpl('/api/guest/booking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ t: token, op: 'contact', id, code, email }),
    });
    if (!res.ok) return { ok: false, error: 'failed' };
    const o = obj(await res.json().catch(() => null));
    if (o.ok === true) return { ok: true };
    return {
      ok: false,
      error:
        o.error === 'bad_email' || o.error === 'closed' || o.error === 'invalid'
          ? o.error
          : 'failed',
    };
  } catch {
    return { ok: false, error: 'failed' };
  }
}
