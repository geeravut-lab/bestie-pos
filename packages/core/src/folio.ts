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
    });
  }
  return out;
}

export type FolioCharge = {
  id: string;
  folioId: string;
  storeId: string;
  orderId: string;
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
    if (!str(o.id) || !str(o.folio_id) || num(o.amount) <= 0) continue;
    out.push({
      id: str(o.id),
      folioId: str(o.folio_id),
      storeId: str(o.store_id),
      orderId: str(o.order_id),
      amount: num(o.amount),
      receiptNumber: str(o.receipt_number) || null,
      voided: !!str(o.voided_at),
      voidReason: str(o.void_reason) || null,
      createdAt: str(o.created_at),
    });
  }
  return out.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/** What a stay owes: the charges that were not taken off. */
export const folioBalance = (charges: readonly FolioCharge[]): number =>
  charges.filter((c) => !c.voided).reduce((sum, c) => sum + c.amount, 0);

/** The label of a stay in a list: "101 · Anna". */
export const stayLabel = (roomName: string, s: Pick<Stay, 'guestName'>): string =>
  `${roomName} · ${s.guestName}`;
