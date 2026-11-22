// Growth tools (stamp cards, tours, marketing, integration hub, network consents): readers for what the database answers, and the few rules that live in code.
import { toCsv } from './csv';
import type { LocalizedText } from './types';

const obj = (x: unknown): Record<string, unknown> =>
  x && typeof x === 'object' ? (x as Record<string, unknown>) : {};
const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0;
const nnum = (v: unknown): number | null =>
  v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const name = (v: unknown): LocalizedText => {
  const o = obj(v);
  return { th: str(o.th), ...(str(o.en) ? { en: str(o.en) } : {}) };
};
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// ── stamp cards and day passes ──
export type StampProgram = {
  id: string;
  kind: 'stamps' | 'pass';
  name: LocalizedText;
  rewardItemId: string;
  stampsNeeded: number | null;
  minSpend: number;
  passPrice: number | null;
  passDays: number | null;
  active: boolean;
};
export function parseStampPrograms(v: unknown): StampProgram[] {
  const out: StampProgram[] = [];
  for (const x of list(v)) {
    const o = obj(x);
    if (!str(o.id) || (o.kind !== 'stamps' && o.kind !== 'pass')) continue;
    out.push({
      id: str(o.id),
      kind: o.kind,
      name: name(o.name),
      rewardItemId: str(o.reward_item_id),
      stampsNeeded: nnum(o.stamps_needed),
      minSpend: num(o.min_spend),
      passPrice: nnum(o.pass_price),
      passDays: nnum(o.pass_days),
      active: o.active !== false,
    });
  }
  return out;
}

export type StampStatus = {
  programId: string;
  kind: 'stamps' | 'pass';
  name: LocalizedText;
  rewardItemId: string;
  stampsNeeded: number | null;
  passPrice: number | null;
  passDays: number | null;
  stamps: number;
  rewardsReady: number;
  passUntil: string | null;
  passUsedToday: boolean | null;
};
export function parseStampStatus(v: unknown): StampStatus[] {
  const out: StampStatus[] = [];
  for (const x of list(v)) {
    const o = obj(x);
    if (!str(o.program_id) || (o.kind !== 'stamps' && o.kind !== 'pass')) continue;
    out.push({
      programId: str(o.program_id),
      kind: o.kind,
      name: name(o.name),
      rewardItemId: str(o.reward_item_id),
      stampsNeeded: nnum(o.stamps_needed),
      passPrice: nnum(o.pass_price),
      passDays: nnum(o.pass_days),
      stamps: num(o.stamps),
      rewardsReady: num(o.rewards_ready),
      passUntil: str(o.pass_until) || null,
      passUsedToday: typeof o.pass_used_today === 'boolean' ? o.pass_used_today : null,
    });
  }
  return out;
}
/** Stamps still missing for the next reward ("2 of 5" → 3). A pass has no stamps. */
export function stampsToNext(s: Pick<StampStatus, 'stamps' | 'stampsNeeded'>): number | null {
  if (!s.stampsNeeded) return null;
  return s.stampsNeeded - (s.stamps % s.stampsNeeded);
}

export type StampReport = {
  stampsGiven: number;
  rewardsUsed: number;
  rewardValue: number;
  passesSold: number;
  passesActive: number;
};
export function parseStampReport(v: unknown): StampReport {
  const o = obj(v);
  return {
    stampsGiven: num(o.stamps_given),
    rewardsUsed: num(o.rewards_used),
    rewardValue: num(o.reward_value),
    passesSold: num(o.passes_sold),
    passesActive: num(o.passes_active),
  };
}

// ── tours ──
export type TourSlot = {
  id: string;
  title: LocalizedText;
  startsAt: string;
  durationMin: number;
  capacity: number;
  price: number;
  guideStaffId: string | null;
  status: 'open' | 'cancelled';
  note: string | null;
};
export function parseTourSlots(v: unknown): TourSlot[] {
  const out: TourSlot[] = [];
  for (const x of list(v)) {
    const o = obj(x);
    if (!str(o.id) || !str(o.starts_at)) continue;
    out.push({
      id: str(o.id),
      title: name(o.title),
      startsAt: str(o.starts_at),
      durationMin: num(o.duration_min),
      capacity: num(o.capacity),
      price: num(o.price),
      guideStaffId: str(o.guide_staff_id) || null,
      status: o.status === 'cancelled' ? 'cancelled' : 'open',
      note: str(o.note) || null,
    });
  }
  return out;
}
export type TourBooking = {
  id: string;
  guestName: string;
  phone: string | null;
  seats: number;
  status: 'booked' | 'checked_in' | 'cancelled' | 'no_show';
  deposit: number;
  orderId: string | null;
};
export function parseTourBookings(v: unknown): TourBooking[] {
  const out: TourBooking[] = [];
  for (const x of list(v)) {
    const o = obj(x);
    if (!str(o.id)) continue;
    const s = o.status;
    out.push({
      id: str(o.id),
      guestName: str(o.guest_name),
      phone: str(o.phone) || null,
      seats: num(o.seats),
      status: s === 'checked_in' || s === 'cancelled' || s === 'no_show' ? s : 'booked',
      deposit: num(o.deposit),
      orderId: str(o.order_id) || null,
    });
  }
  return out;
}
/** Seats still free on a slot, never below zero. */
export function seatsLeft(
  capacity: number,
  bookings: readonly Pick<TourBooking, 'seats' | 'status'>[],
): number {
  const taken = bookings
    .filter((b) => b.status === 'booked' || b.status === 'checked_in')
    .reduce((a, b) => a + b.seats, 0);
  return Math.max(capacity - taken, 0);
}

// ── marketing ──
export type CampaignKind = 'winback' | 'rebook' | 'welcome';
export type Campaign = {
  id: string;
  name: string;
  kind: CampaignKind;
  idleDays: number;
  message: LocalizedText;
  active: boolean;
};
export function parseCampaigns(v: unknown): Campaign[] {
  const out: Campaign[] = [];
  for (const x of list(v)) {
    const o = obj(x);
    if (!str(o.id) || o.deleted_at) continue;
    const k = o.kind === 'rebook' || o.kind === 'welcome' ? o.kind : 'winback';
    out.push({
      id: str(o.id),
      name: str(o.name),
      kind: k,
      idleDays: num(o.idle_days) || 30,
      message: name(o.message),
      active: o.active === true,
    });
  }
  return out;
}
/** What goes to LINE: Thai, then English when there is one, and always the way to stop. */
export const MARKETING_STOP_FOOTER =
  '\u0e1e\u0e34\u0e21\u0e1e\u0e4c STOP \u0e40\u0e1e\u0e37\u0e48\u0e2d\u0e44\u0e21\u0e48\u0e23\u0e31\u0e1a\u0e02\u0e49\u0e2d\u0e04\u0e27\u0e32\u0e21 · Reply STOP to unsubscribe';
export function marketingText(message: LocalizedText): string {
  const body = message.en ? `${message.th}\n\n${message.en}` : message.th;
  return `${body}\n\n${MARKETING_STOP_FOOTER}`;
}
const STOP_WORDS = new Set([
  'stop',
  'unsubscribe',
  '\u0e2b\u0e22\u0e38\u0e14',
  '\u0e22\u0e01\u0e40\u0e25\u0e34\u0e01',
  '\u0e2b\u0e22\u0e38\u0e14\u0e23\u0e31\u0e1a',
]);
/** A chat message that withdraws the marketing consent. */
export function isStopMessage(text: string): boolean {
  return STOP_WORDS.has(text.trim().toLowerCase());
}

// ── integration hub ──
export const WEBHOOK_EVENTS = ['order.paid', 'appointment.created', 'tour.booked'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
export type ApiKeyRow = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  revokedAt: string | null;
};
export function parseApiKeys(v: unknown): ApiKeyRow[] {
  const out: ApiKeyRow[] = [];
  for (const x of list(v)) {
    const o = obj(x);
    if (!str(o.id)) continue;
    out.push({
      id: str(o.id),
      name: str(o.name),
      prefix: str(o.prefix),
      scopes: list(o.scopes).map(str).filter(Boolean),
      lastUsedAt: str(o.last_used_at) || null,
      revokedAt: str(o.revoked_at) || null,
    });
  }
  return out;
}
export type WebhookRow = {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  failCount: number;
  queued: number;
  lastStatus: number | null;
};
export function parseWebhooks(v: unknown): WebhookRow[] {
  const out: WebhookRow[] = [];
  for (const x of list(v)) {
    const o = obj(x);
    if (!str(o.id)) continue;
    out.push({
      id: str(o.id),
      url: str(o.url),
      events: list(o.events).map(str).filter(Boolean),
      active: o.active !== false,
      failCount: num(o.fail_count),
      queued: num(o.queued),
      lastStatus: nnum(o.last_status),
    });
  }
  return out;
}
/** A webhook address the server will call: https, a real host name (never an IP or a local name). */
export function webhookUrlOk(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  const h = u.hostname.toLowerCase();
  if (!h.includes('.') || /^[0-9.]+$/.test(h) || h.includes(':') || h.startsWith('[')) return false;
  return !/(^|\.)(localhost|local|internal|lan|home|corp)$/.test(h);
}

export type AccountingRow = {
  date: string;
  receipt: string;
  store: string;
  branch: string;
  sellerTaxId: string;
  netBeforeVat: number;
  serviceCharge: number;
  vat: number;
  total: number;
  rounding: number;
  payable: number;
  cash: number;
  promptpay: number;
  gateway: number;
  credit: number;
  points: number;
  other: number;
  customerTaxId: string;
};
export function parseAccountingRows(v: unknown): AccountingRow[] {
  const out: AccountingRow[] = [];
  for (const x of list(v)) {
    const o = obj(x);
    if (!str(o.receipt)) continue;
    out.push({
      date: str(o.date),
      receipt: str(o.receipt),
      store: str(o.store),
      branch: str(o.branch),
      sellerTaxId: str(o.seller_tax_id),
      netBeforeVat: num(o.net_before_vat),
      serviceCharge: num(o.service_charge),
      vat: num(o.vat),
      total: num(o.total),
      rounding: num(o.rounding),
      payable: num(o.payable),
      cash: num(o.cash),
      promptpay: num(o.promptpay),
      gateway: num(o.gateway),
      credit: num(o.credit),
      points: num(o.points),
      other: num(o.other),
      customerTaxId: str(o.customer_tax_id),
    });
  }
  return out;
}
/** satang → "1234.50" (a plain decimal for spreadsheets; integer arithmetic only). */
export function satangDecimal(n: number): string {
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(Math.round(n));
  return `${sign}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}
export const ACCOUNTING_HEADER = [
  'date',
  'receipt',
  'store',
  'branch',
  'seller_tax_id',
  'net_before_vat',
  'service_charge',
  'vat',
  'total',
  'rounding',
  'payable',
  'cash',
  'promptpay',
  'card_gateway',
  'bestie_credit',
  'bestie_points',
  'other',
  'customer_tax_id',
] as const;
export function accountingCsv(rows: readonly AccountingRow[]): string {
  return toCsv(
    ACCOUNTING_HEADER,
    rows.map((r) => [
      r.date,
      r.receipt,
      r.store,
      r.branch,
      r.sellerTaxId,
      satangDecimal(r.netBeforeVat),
      satangDecimal(r.serviceCharge),
      satangDecimal(r.vat),
      satangDecimal(r.total),
      satangDecimal(r.rounding),
      satangDecimal(r.payable),
      satangDecimal(r.cash),
      satangDecimal(r.promptpay),
      satangDecimal(r.gateway),
      satangDecimal(r.credit),
      satangDecimal(r.points),
      satangDecimal(r.other),
      r.customerTaxId,
    ]),
  );
}

// ── network consents ──
export type PassPartner = { orgId: string; name: string; blocked: boolean };
export function parsePassPartners(v: unknown): PassPartner[] {
  const out: PassPartner[] = [];
  for (const x of list(v)) {
    const o = obj(x);
    if (!str(o.org_id)) continue;
    out.push({ orgId: str(o.org_id), name: str(o.name), blocked: o.blocked === true });
  }
  return out;
}
