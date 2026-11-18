/** A member as the screens use it. The balance is the Bestie Points ledger's sum (never stored on the customer). */
export type CustomerCard = {
  id: string;
  name: string;
  phone: string | null;
  memberCode: string;
  points: number;
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};

export function parseCustomerCard(raw: unknown): CustomerCard | null {
  const r = obj(raw);
  if (typeof r.id !== 'string' || typeof r.name !== 'string') return null;
  const balance = typeof r.balance === 'string' ? Number(r.balance) : r.balance;
  return {
    id: r.id,
    name: r.name,
    phone: typeof r.phone === 'string' ? r.phone : null,
    memberCode: typeof r.member_code === 'string' ? r.member_code : '',
    points: typeof balance === 'number' && Number.isFinite(balance) ? Math.round(balance) : 0,
  };
}

export const parseCustomerCards = (raw: unknown): CustomerCard[] =>
  Array.isArray(raw) ? raw.map(parseCustomerCard).filter((c): c is CustomerCard => c !== null) : [];

/** Digits only, as stored. The database re-checks (8–15 digits). */
export const normalizePhone = (input: string): string => input.replace(/\D/g, '');

/** A search is worth sending to the server once it could match something (phone digits, a member code, or a name fragment). */
export function searchWorthy(q: string): boolean {
  const s = q.trim();
  if (s.length < 2) return false;
  const digits = normalizePhone(s);
  if (/^[0-9 +()-]+$/.test(s)) return digits.length >= 4; // looks like a phone number
  return true;
}

export type PointsHistoryRow = {
  id: string;
  kind: string;
  points: number;
  reason: string | null;
  orderId: string | null;
  createdAt: string;
};

export function parsePointsHistory(raw: unknown): PointsHistoryRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x) => {
    const r = obj(x);
    if (typeof r.id !== 'string' || typeof r.kind !== 'string' || typeof r.points !== 'number')
      return [];
    return [
      {
        id: r.id,
        kind: r.kind,
        points: r.points,
        reason: typeof r.reason === 'string' ? r.reason : null,
        orderId: typeof r.order_id === 'string' ? r.order_id : null,
        createdAt: typeof r.created_at === 'string' ? r.created_at : '',
      },
    ];
  });
}
