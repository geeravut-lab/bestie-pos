// Phase 4 — the folio (charge to room) for resorts. Pure helpers; the database decides (migration 74).
export const FOLIO_SETTLE_METHODS = ['cash', 'transfer', 'card'] as const;
export type FolioSettleMethod = (typeof FOLIO_SETTLE_METHODS)[number];

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => {
  const n = typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
};

export type FolioRoom = {
  id: string;
  storeId: string;
  name: string;
  active: boolean;
  sort: number;
  /** Price per night, satang (null = no automatic nights). */
  nightRate: number | null;
};
export function parseFolioRooms(v: unknown): FolioRoom[] {
  if (!Array.isArray(v)) return [];
  const out: FolioRoom[] = [];
  for (const x of v) {
    const o = obj(x);
    if (!str(o.id) || !str(o.name)) continue;
    out.push({
      id: str(o.id),
      storeId: str(o.store_id),
      name: str(o.name),
      active: o.active !== false,
      sort: num(o.sort),
      nightRate: o.night_rate == null ? null : num(o.night_rate),
    });
  }
  return out.sort(
    (a, b) => a.sort - b.sort || a.name.localeCompare(b.name, undefined, { numeric: true }),
  );
}

export type Stay = {
  id: string;
  roomId: string;
  guestName: string;
  phone: string | null;
  checkInAt: string;
  checkOutOn: string | null;
  note: string | null;
  status: 'open' | 'closed';
  closedAt: string | null;
  /** The night rate copied onto this stay at check-in, satang (null = none). */
  nightRate: number | null;
  /** The reservation in the hotel's own system (PMS) this stay is linked to, if any. */
  pmsReservationId?: string | null;
};
export function parseStays(v: unknown): Stay[] {
  if (!Array.isArray(v)) return [];
  const out: Stay[] = [];
  for (const x of v) {
    const o = obj(x);
    if (!str(o.id) || !str(o.room_id) || !str(o.guest_name)) continue;
    out.push({
      id: str(o.id),
      roomId: str(o.room_id),
      guestName: str(o.guest_name),
      phone: str(o.phone) || null,
      checkInAt: str(o.check_in_at),
      checkOutOn: str(o.check_out_on) || null,
      note: str(o.note) || null,
      status: o.status === 'closed' ? 'closed' : 'open',
      closedAt: str(o.closed_at) || null,
      nightRate: o.night_rate == null ? null : num(o.night_rate),
      pmsReservationId: str(o.pms_reservation_id) || null,
    });
  }
  return out;
}

export type FolioChargeKind = 'bill' | 'night' | 'return';
export type FolioCharge = {
  id: string;
  folioId: string;
  storeId: string;
  kind: FolioChargeKind;
  /** The bill that was charged ('' for a night or a return). */
  orderId: string;
  /** The Bangkok date a night starts ('' for a bill or a return). */
  nightDate: string;
  /** Satang: positive for a bill or a night, negative for a return. */
  amount: number;
  receiptNumber: string | null;
  voided: boolean;
  voidReason: string | null;
  createdAt: string;
};
export function parseFolioCharges(v: unknown): FolioCharge[] {
  if (!Array.isArray(v)) return [];
  const out: FolioCharge[] = [];
  for (const x of v) {
    const o = obj(x);
    const kind: FolioChargeKind =
      o.kind === 'night' ? 'night' : o.kind === 'return' ? 'return' : 'bill';
    const amount = num(o.amount);
    if (!str(o.id) || !str(o.folio_id) || amount === 0) continue;
    if (kind === 'return' ? amount > 0 : amount < 0) continue;
    out.push({
      id: str(o.id),
      folioId: str(o.folio_id),
      storeId: str(o.store_id),
      kind,
      orderId: str(o.order_id),
      nightDate: str(o.night_date),
      amount,
      receiptNumber: str(o.receipt_number) || null,
      voided: !!str(o.voided_at),
      voidReason: str(o.void_reason) || null,
      createdAt: str(o.created_at),
    });
  }
  return out.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/** The lines of a stay as a statement lists them: nights by date first, then bills and returns in the order they happened. */
export function statementLines(charges: readonly FolioCharge[]): FolioCharge[] {
  const rank = (c: FolioCharge) => (c.kind === 'night' ? 0 : 1);
  return [...charges].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.kind === 'night' && b.kind === 'night'
        ? a.nightDate.localeCompare(b.nightDate)
        : Date.parse(a.createdAt) - Date.parse(b.createdAt)),
  );
}

/** The nights counted on a stay (not taken off). */
export const folioNights = (charges: readonly FolioCharge[]): number =>
  charges.filter((c) => c.kind === 'night' && !c.voided).length;

/** What a stay owes: the charges that were not taken off. */
export const folioBalance = (charges: readonly FolioCharge[]): number =>
  charges.filter((c) => !c.voided).reduce((sum, c) => sum + c.amount, 0);

/** The label of a stay in a list: "101 · Anna". */
export const stayLabel = (roomName: string, s: Pick<Stay, 'guestName'>): string =>
  `${roomName} · ${s.guestName}`;
