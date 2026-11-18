/**
 * Cash shifts — a drawer session per device. Pure arithmetic shared by the screen (instant, offline) and checked by the server
 * (`close_shift` recomputes the expected cash from the confirmed cash payments of that device — the till cannot pick its own variance).
 */
import type { Satang } from './money';
import type { OrderDoc } from './orders';
import { receiptSeq } from './payments';

export type ShiftDoc = {
  id: string;
  orgId: string;
  storeId: string;
  deviceId: string;
  openedBy: string | null;
  openedAt: string;
  openingCash: Satang;
  status: 'open' | 'closed';
  closedAt: string | null;
  countedCash: Satang | null;
  expectedCash: Satang | null;
  variance: Satang | null;
  note: string | null;
};

export function openShift(p: {
  id: string;
  orgId: string;
  storeId: string;
  deviceId: string;
  openedBy: string | null;
  openingCash: Satang;
  now: number;
}): ShiftDoc {
  if (!Number.isSafeInteger(p.openingCash) || p.openingCash < 0)
    throw new Error('opening cash must be zero or more');
  return {
    id: p.id,
    orgId: p.orgId,
    storeId: p.storeId,
    deviceId: p.deviceId,
    openedBy: p.openedBy,
    openedAt: new Date(p.now).toISOString(),
    openingCash: p.openingCash,
    status: 'open',
    closedAt: null,
    countedCash: null,
    expectedCash: null,
    variance: null,
    note: null,
  };
}

export type ShiftSummary = {
  bills: number;
  cash: Satang;
  promptpay: Satang;
  card: Satang;
  /** Bills closed from this till (its own cash series "A-…") during the shift. */
  cashBills: number;
  /** opening cash + cash taken: what should be in the drawer. */
  expectedCash: Satang;
};

/**
 * What the shift took, from the receipts of paid bills: cash is counted for receipts of THIS device's own series during the
 * window; PromptPay / card are listed for the end-of-day sheet but never count towards the drawer.
 */
export function summarizeShift(
  shift: ShiftDoc,
  deviceCode: string,
  paid: readonly OrderDoc[],
  now: number,
): ShiftSummary {
  const from = Date.parse(shift.openedAt);
  const to = shift.closedAt ? Date.parse(shift.closedAt) : now;
  const out: ShiftSummary = {
    bills: 0,
    cash: 0,
    promptpay: 0,
    card: 0,
    cashBills: 0,
    expectedCash: shift.openingCash,
  };
  for (const o of paid) {
    const r = o.receipt;
    if (!r || o.status !== 'paid') continue;
    const at = Date.parse(r.issuedAt);
    if (at < from || at > to) continue;
    const own = receiptSeq(deviceCode, r.number) !== null; // the till's offline series, "A-000123"
    const online = r.number.startsWith(`${deviceCode}+`); // the server's series for PromptPay / card taken on this device
    if (!own && !online) continue;
    out.bills++;
    for (const p of r.payments) {
      if (p.tender === 'cash' && own) out.cash += p.amount;
      else if (p.tender === 'promptpay' && online) out.promptpay += p.amount;
      else if (p.tender === 'gateway' && online) out.card += p.amount;
    }
    if (own) out.cashBills++;
  }
  out.expectedCash = shift.openingCash + out.cash;
  return out;
}

/** counted − expected: negative = the drawer is short. */
export const cashVariance = (counted: Satang, expected: Satang): Satang => counted - expected;

export function closeShift(
  s: ShiftDoc,
  p: { countedCash: Satang; expectedCash: Satang; now: number; note?: string },
): ShiftDoc {
  if (s.status !== 'open') throw new Error('shift is already closed');
  if (!Number.isSafeInteger(p.countedCash) || p.countedCash < 0)
    throw new Error('counted cash must be zero or more');
  return {
    ...s,
    status: 'closed',
    closedAt: new Date(p.now).toISOString(),
    countedCash: p.countedCash,
    expectedCash: p.expectedCash,
    variance: cashVariance(p.countedCash, p.expectedCash),
    note: p.note?.trim() ? p.note.trim().slice(0, 300) : null,
  };
}

/** Rows from the server → a shift (lenient: a damaged row is skipped). */
export function shiftFromRow(r: Record<string, unknown>): ShiftDoc | null {
  const n = (v: unknown): number | null => {
    const x = typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : v;
    return typeof x === 'number' && Number.isSafeInteger(x) ? x : null;
  };
  const s = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const id = s(r.id);
  const orgId = s(r.org_id);
  const storeId = s(r.store_id);
  const deviceId = s(r.device_id);
  const openedAt = s(r.opened_at);
  const opening = n(r.opening_cash);
  if (!id || !orgId || !storeId || !deviceId || !openedAt || opening === null) return null;
  return {
    id,
    orgId,
    storeId,
    deviceId,
    openedBy: s(r.opened_by),
    openedAt,
    openingCash: opening,
    status: r.status === 'closed' ? 'closed' : 'open',
    closedAt: s(r.closed_at),
    countedCash: n(r.counted_cash),
    expectedCash: n(r.expected_cash),
    variance: n(r.variance),
    note: s(r.note),
  };
}

/** The `open_shift` / `close_shift` calls (snake_case, exactly what the server function takes). */
export const openShiftPayload = (s: ShiftDoc) => ({
  p: {
    id: s.id,
    device_id: s.deviceId,
    staff_id: s.openedBy,
    opened_at: s.openedAt,
    opening_cash: s.openingCash,
  },
});
export const closeShiftPayload = (s: ShiftDoc, staffId: string | null) => ({
  p: {
    id: s.id,
    staff_id: staffId,
    closed_at: s.closedAt,
    counted_cash: s.countedCash,
    note: s.note,
  },
});
