import {
  parseBookingInfo,
  parseBookingResult,
  parseCancelResult,
  parseHairStyles,
  parseSlots,
} from '@bestie/core';
import type {
  BookingInfo,
  BookingResult,
  CancelResult,
  HairAnswers,
  HairStyle,
} from '@bestie/core';

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

/** The shop's hair-style catalogue (empty when the shop has none, or on any failure). */
export async function loadStyles(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HairStyle[]> {
  try {
    const res = await fetchImpl(`/api/guest/booking?t=${encodeURIComponent(token)}&op=styles`);
    if (!res.ok) return [];
    return parseHairStyles(obj(await res.json().catch(() => null)).styles);
  } catch {
    return [];
  }
}

export type HairSend = {
  styleId: string;
  answers: HairAnswers;
  /** Only with the guest's consent tick. */
  photo?: { consent: true; mime: string; data: string };
  removePhoto?: boolean;
};
export type HairResult =
  | { ok: true; photo: boolean }
  | {
      ok: false;
      error: 'consent_needed' | 'photo_too_early' | 'bad_photo' | 'closed' | 'invalid' | 'failed';
    };

/** Send the guest's answers, chosen style and (optionally) photo for ONE booking; the booking code is the proof. */
export async function sendHair(
  token: string,
  id: string,
  code: string,
  r: HairSend,
  fetchImpl: typeof fetch = fetch,
): Promise<HairResult> {
  try {
    const res = await fetchImpl('/api/guest/booking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        t: token,
        op: 'hair',
        id,
        code,
        request: {
          style_id: r.styleId || undefined,
          answers: r.answers,
          photo: r.photo,
          remove_photo: r.removePhoto || undefined,
        },
      }),
    });
    if (!res.ok) return { ok: false, error: 'failed' };
    const o = obj(await res.json().catch(() => null));
    if (o.ok === true) return { ok: true, photo: o.photo === true };
    const e = o.error;
    return {
      ok: false,
      error:
        e === 'consent_needed' || e === 'photo_too_early' || e === 'bad_photo' || e === 'closed'
          ? e
          : e === 'invalid' || e === 'bad_style' || e === 'bad_answers'
            ? 'invalid'
            : 'failed',
    };
  } catch {
    return { ok: false, error: 'failed' };
  }
}

/** Does this shop offer the health form on the guest's phone (spas only)? */
export async function loadHealthFormEnabled(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl(`/api/guest/booking?t=${encodeURIComponent(token)}&op=health_form`);
    if (!res.ok) return false;
    return obj(await res.json().catch(() => null)).enabled === true;
  } catch {
    return false;
  }
}

export type HealthSend = {
  consent: boolean;
  signedName: string;
  answers: Record<string, boolean | string>;
};
export type HealthResult =
  | { ok: true }
  | { ok: false; error: 'consent_needed' | 'bad_name' | 'closed' | 'too_many' | 'failed' };

/** Send the signed health form for ONE booking; the booking code is the proof. */
export async function sendHealthForm(
  token: string,
  id: string,
  code: string,
  f: HealthSend,
  fetchImpl: typeof fetch = fetch,
): Promise<HealthResult> {
  try {
    const res = await fetchImpl('/api/guest/booking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        t: token,
        op: 'health',
        id,
        code,
        form: { consent: f.consent, signed_name: f.signedName, answers: f.answers },
      }),
    });
    if (!res.ok) return { ok: false, error: 'failed' };
    const o = obj(await res.json().catch(() => null));
    if (o.ok === true) return { ok: true };
    const e = o.error;
    return {
      ok: false,
      error:
        e === 'consent_needed' || e === 'bad_name' || e === 'closed' || e === 'too_many'
          ? e
          : 'failed',
    };
  } catch {
    return { ok: false, error: 'failed' };
  }
}
