import { parseGuestBill, parseGuestMenu } from '@bestie/core';
import type { CartLine, GuestBill, GuestMenu } from '@bestie/core';
import { orderPayload } from '@bestie/core';

export type GuestTable = {
  storeName: string;
  tableName: string;
  autoSend: boolean;
  menu: GuestMenu;
  bill: GuestBill;
};

/** Why a call failed, in the words of the dictionary (`gsErr_<code>` / the not-found and off pages). */
export type GuestFailure =
  'not_found' | 'ordering_off' | 'unavailable' | 'too_many' | 'invalid' | 'rate_limited' | 'failed';

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
];
const reasonOf = (v: unknown): GuestFailure => KNOWN.find((k) => k === v) ?? 'failed';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const nameOf = (v: unknown): string => {
  const n = obj(v).name;
  return typeof n === 'string' ? n : '';
};

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
        menu: parseGuestMenu(b.menu),
        bill: parseGuestBill(b.bill),
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
