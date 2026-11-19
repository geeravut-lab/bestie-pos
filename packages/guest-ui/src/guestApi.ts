import { parseGuestBill, parseGuestMenu } from '@bestie/core';
import type { CartLine, GuestBill, GuestMenu } from '@bestie/core';
import { orderPayload, parseFilter } from '@bestie/core';
import type { DietFilter } from '@bestie/core';

export type GuestPayInfo = {
  enabled: boolean;
  total: number;
  pointsDiscount: number;
  unconfirmed: boolean;
  live: { attemptId: string; amount: number; qrImageUrl: string } | null;
};

export type GuestTable = {
  pay: GuestPayInfo;
  storeName: string;
  tableName: string;
  autoSend: boolean;
  /** The shop switched the food assistant on (module ai.guest). The filter buttons work without it. */
  ai: boolean;
  menu: GuestMenu;
  bill: GuestBill;
};

/** Why a call failed, in the words of the dictionary (`gsErr_<code>` / the not-found and off pages). */
export type GuestFailure =
  | 'not_found'
  | 'ordering_off'
  | 'unavailable'
  | 'too_many'
  | 'invalid'
  | 'rate_limited'
  | 'bill_locked'
  | 'pay_off'
  | 'unconfirmed'
  | 'attempt_pending'
  | 'provider_error'
  | 'empty'
  | 'failed';

export type GuestLoad =
  | { ok: true; data: GuestTable }
  | { ok: false; reason: GuestFailure; storeName?: string; tableName?: string };

const KNOWN: readonly GuestFailure[] = [
  'not_found',
  'ordering_off',
  'unavailable',
  'too_many',
  'invalid',
  'rate_limited',
  'bill_locked',
  'pay_off',
  'unconfirmed',
  'attempt_pending',
  'provider_error',
  'empty',
];
const reasonOf = (v: unknown): GuestFailure => KNOWN.find((k) => k === v) ?? 'failed';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const nameOf = (v: unknown): string => {
  const n = obj(v).name;
  return typeof n === 'string' ? n : '';
};

function parsePay(raw: unknown): GuestPayInfo {
  const p = obj(raw);
  const live = obj(p.live);
  return {
    enabled: p.enabled === true,
    total: typeof p.total === 'number' ? Math.round(p.total) : 0,
    pointsDiscount: typeof p.pointsDiscount === 'number' ? Math.round(p.pointsDiscount) : 0,
    unconfirmed: p.unconfirmed === true,
    live:
      typeof live.attemptId === 'string' && typeof live.qrImageUrl === 'string'
        ? {
            attemptId: live.attemptId,
            amount: typeof live.amount === 'number' ? live.amount : 0,
            qrImageUrl: live.qrImageUrl,
          }
        : null,
  };
}

export async function loadGuestTable(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GuestLoad> {
  try {
    const res = await fetchImpl(`/api/guest/menu?t=${encodeURIComponent(token)}`, {
      cache: 'no-store',
    });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      return {
        ok: false,
        reason: reasonOf(obj(body).error),
        storeName: nameOf(obj(body).store) || undefined,
        tableName: nameOf(obj(body).table) || undefined,
      };
    }
    const b = obj(body);
    return {
      ok: true,
      data: {
        storeName: nameOf(b.store),
        tableName: nameOf(b.table),
        autoSend: b.autoSend === true,
        ai: b.ai === true,
        menu: parseGuestMenu(b.menu),
        bill: parseGuestBill(b.bill),
        pay: parsePay(b.pay),
      },
    };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

export type PlacedOrder = { number: string; lines: number; status: 'sent' | 'waiting' };

export async function placeGuestOrder(
  token: string,
  clientId: string,
  cart: readonly CartLine[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; order: PlacedOrder } | { ok: false; reason: GuestFailure }> {
  try {
    const res = await fetchImpl('/api/guest/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(orderPayload(token, clientId, cart)),
    });
    const body = obj(await res.json().catch(() => null));
    if (!res.ok) return { ok: false, reason: reasonOf(body.error) };
    return {
      ok: true,
      order: {
        number: typeof body.number === 'string' ? body.number : '',
        lines: typeof body.lines === 'number' ? body.lines : 0,
        status: body.status === 'sent' ? 'sent' : 'waiting',
      },
    };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

export type GuestCharge = { attemptId: string; amount: number; qrImageUrl: string };

/** Ask the server for a PromptPay QR for the table's bill. The amount is the server's, not ours. */
export async function startGuestPayment(
  token: string,
  lang: 'th' | 'en',
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; charge: GuestCharge } | { ok: false; reason: GuestFailure }> {
  try {
    const res = await fetchImpl('/api/guest/pay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, lang }),
    });
    const b = obj(await res.json().catch(() => null));
    if (!res.ok) return { ok: false, reason: reasonOf(b.error) };
    if (typeof b.attempt_id !== 'string' || typeof b.qr_image_url !== 'string')
      return { ok: false, reason: 'provider_error' };
    return {
      ok: true,
      charge: {
        attemptId: b.attempt_id,
        amount: typeof b.amount === 'number' ? b.amount : 0,
        qrImageUrl: b.qr_image_url,
      },
    };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

export type GuestPayStatus = {
  status: 'created' | 'pending' | 'succeeded' | 'failed' | 'canceled' | 'needs_review' | 'unknown';
  receipt: string | null;
};

export async function guestPaymentStatus(
  token: string,
  attemptId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GuestPayStatus | null> {
  try {
    const res = await fetchImpl(
      `/api/guest/pay?t=${encodeURIComponent(token)}&a=${encodeURIComponent(attemptId)}`,
      { cache: 'no-store' },
    );
    if (!res.ok) return null;
    const b = obj(await res.json().catch(() => null));
    const known = [
      'created',
      'pending',
      'succeeded',
      'failed',
      'canceled',
      'needs_review',
    ] as const;
    return {
      status: known.find((k) => k === b.status) ?? 'unknown',
      receipt: typeof b.receipt === 'string' ? b.receipt : null,
    };
  } catch {
    return null;
  }
}

export async function cancelGuestPayment(
  token: string,
  attemptId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  try {
    await fetchImpl('/api/guest/pay-cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, attemptId }),
    });
  } catch {
    /* the QR expires by itself; the next "pay" press cancels a stale one */
  }
}

export type GuestAiAnswer =
  | { kind: 'filter'; filter: DietFilter }
  | { kind: 'unavailable' }
  | { kind: 'not_understood' }
  | { kind: 'failed' };

/** The guest's words → a filter (the page applies it to the menu with plain code; nothing else comes back). */
export async function askGuestAi(
  token: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GuestAiAnswer> {
  try {
    const res = await fetchImpl('/api/guest/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ t: token, text }),
    });
    const b = obj(await res.json().catch(() => null));
    if (!res.ok) return { kind: 'failed' };
    if (b.available !== true) return { kind: 'unavailable' };
    if (b.understood !== true) return { kind: 'not_understood' };
    const filter = parseFilter(b.filter);
    return filter ? { kind: 'filter', filter } : { kind: 'not_understood' };
  } catch {
    return { kind: 'failed' };
  }
}
