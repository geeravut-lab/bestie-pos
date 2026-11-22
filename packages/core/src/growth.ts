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
  depositDue: number;
  source: 'staff' | 'online';
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
      depositDue: num(o.deposit_due),
      source: o.source === 'online' ? 'online' : 'staff',
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

// ── points overview ──
export type PointsOverview = {
  outstanding: number;
  earned30d: number;
  redeemed30d: number;
  members: number;
  top: { customerId: string; name: string; balance: number }[];
  recent: { kind: string; points: number; at: string; name: string }[];
};
export function parsePointsOverview(v: unknown): PointsOverview {
  const o = obj(v);
  return {
    outstanding: num(o.outstanding),
    earned30d: num(o.earned_30d),
    redeemed30d: num(o.redeemed_30d),
    members: num(o.members),
    top: list(o.top).flatMap((x) => {
      const r = obj(x);
      return str(r.customer_id)
        ? [{ customerId: str(r.customer_id), name: str(r.name), balance: num(r.balance) }]
        : [];
    }),
    recent: list(o.recent).flatMap((x) => {
      const r = obj(x);
      return str(r.kind)
        ? [{ kind: str(r.kind), points: num(r.points), at: str(r.at), name: str(r.name) }]
        : [];
    }),
  };
}

// ── waitlist, table turnover ──
export type WaitEntry = {
  id: string;
  name: string;
  phone: string | null;
  party: number;
  status: 'waiting' | 'called' | 'seated' | 'left';
  quotedMin: number;
  note: string | null;
  createdAt: string;
};
export function parseWaitlist(v: unknown): WaitEntry[] {
  const out: WaitEntry[] = [];
  for (const x of list(v)) {
    const o = obj(x);
    if (!str(o.id)) continue;
    const s = o.status;
    out.push({
      id: str(o.id),
      name: str(o.name),
      phone: str(o.phone) || null,
      party: num(o.party),
      status: s === 'called' || s === 'seated' || s === 'left' ? s : 'waiting',
      quotedMin: num(o.quoted_min),
      note: str(o.note) || null,
      createdAt: str(o.created_at),
    });
  }
  return out;
}
/** Minutes a party has waited so far. */
export const waitedMinutes = (createdAt: string, nowMs: number): number =>
  Math.max(0, Math.floor((nowMs - Date.parse(createdAt)) / 60_000));
export type TurnoverRow = {
  tableId: string;
  name: string;
  seats: number;
  bills: number;
  avgMin: number;
  revenue: number;
  perHour: number;
};
export function parseTurnover(v: unknown): TurnoverRow[] {
  const out: TurnoverRow[] = [];
  for (const x of list(v)) {
    const o = obj(x);
    if (!str(o.table_id)) continue;
    out.push({
      tableId: str(o.table_id),
      name: str(o.name),
      seats: num(o.seats),
      bills: num(o.bills),
      avgMin: num(o.avg_min),
      revenue: num(o.revenue),
      perHour: num(o.per_hour),
    });
  }
  return out;
}

// ── time clock ──
export type ClockedIn = { staffId: string; name: string; since: string };
export function parseClockedIn(v: unknown): ClockedIn[] {
  const out: ClockedIn[] = [];
  for (const x of list(v)) {
    const o = obj(x);
    if (str(o.staff_id))
      out.push({ staffId: str(o.staff_id), name: str(o.name), since: str(o.since) });
  }
  return out;
}
export type SheetRow = {
  staffId: string;
  name: string;
  workedMin: number;
  days: number;
  plannedMin: number;
};
export function parseTimesheet(v: unknown): SheetRow[] {
  const out: SheetRow[] = [];
  for (const x of list(v)) {
    const o = obj(x);
    if (str(o.staff_id))
      out.push({
        staffId: str(o.staff_id),
        name: str(o.name),
        workedMin: num(o.worked_min),
        days: num(o.days),
        plannedMin: num(o.planned_min),
      });
  }
  return out;
}
/** 485 → "8:05" */
export const hoursMinutes = (min: number): string =>
  `${Math.floor(min / 60)}:${String(Math.round(min % 60)).padStart(2, '0')}`;
export function timesheetCsv(rows: readonly SheetRow[]): string {
  return toCsv(
    ['name', 'days_worked', 'hours_worked', 'hours_planned'],
    rows.map((r) => [r.name, r.days, hoursMinutes(r.workedMin), hoursMinutes(r.plannedMin)]),
  );
}

// ── discount with a manager's PIN ──
/** The discount a percentage (in basis points) or an amount gives on a bill, never more than the bill (same arithmetic as the database). */
export function discountAmount(
  kind: 'percent' | 'amount',
  value: number,
  billTotal: number,
): number {
  if (!Number.isInteger(value) || value < 1 || billTotal < 1) return 0;
  return Math.min(
    kind === 'percent' ? Math.floor((billTotal * Math.min(value, 10_000)) / 10_000) : value,
    billTotal,
  );
}

// ── e-receipt ──
export type ReceiptSendData = {
  number: string;
  issuedAt: string;
  sellerName: string;
  sellerTaxId: string | null;
  branch: string;
  posId: string | null;
  vatRegistered: boolean;
  subtotal: number;
  serviceCharge: number;
  vat: number;
  total: number;
  rounding: number;
  payable: number;
  lines: { name: LocalizedText; qty: number; unitPrice: number }[];
  payments: { tender: string; amount: number }[];
  memberLine: boolean;
};
export function parseReceiptSend(v: unknown): ReceiptSendData | null {
  const o = obj(v);
  const r = obj(o.receipt);
  if (!str(r.number)) return null;
  return {
    number: str(r.number),
    issuedAt: str(r.issued_at),
    sellerName: str(r.seller_name),
    sellerTaxId: str(r.seller_tax_id) || null,
    branch: str(r.branch),
    posId: str(r.pos_id) || null,
    vatRegistered: r.vat_registered === true,
    subtotal: num(r.subtotal),
    serviceCharge: num(r.service_charge),
    vat: num(r.vat),
    total: num(r.total),
    rounding: num(r.rounding),
    payable: num(r.payable),
    lines: list(o.lines).map((x) => {
      const l = obj(x);
      return { name: name(l.name), qty: num(l.qty), unitPrice: num(l.unit_price) };
    }),
    payments: list(o.payments).map((x) => {
      const p = obj(x);
      return { tender: str(p.tender), amount: num(p.amount) };
    }),
    memberLine: o.member_line === true,
  };
}
const TENDER_TH: Record<string, string> = {
  cash: '\u0e40\u0e07\u0e34\u0e19\u0e2a\u0e14',
  promptpay: '\u0e1e\u0e23\u0e49\u0e2d\u0e21\u0e40\u0e1e\u0e22\u0e4c',
  gateway: '\u0e1a\u0e31\u0e15\u0e23',
  credit: 'Bestie Credit',
  points: 'Bestie Points',
  room: '\u0e25\u0e07\u0e2b\u0e49\u0e2d\u0e07\u0e1e\u0e31\u0e01',
  platform: '\u0e41\u0e1e\u0e25\u0e15\u0e1f\u0e2d\u0e23\u0e4c\u0e21',
};
const TENDER_EN: Record<string, string> = {
  cash: 'Cash',
  promptpay: 'PromptPay',
  gateway: 'Card',
  credit: 'Bestie Credit',
  points: 'Bestie Points',
  room: 'Charged to room',
  platform: 'Delivery platform',
};
const baht = (satang: number): string => `${satangDecimal(satang)} THB`;
/** The receipt as plain text for an e-mail or a LINE message, in Thai or English. Totals come from the frozen receipt, never recomputed. */
export function receiptText(r: ReceiptSendData, lang: 'th' | 'en'): string {
  const th = lang === 'th';
  const L: string[] = [];
  L.push(r.sellerName);
  if (r.vatRegistered && r.sellerTaxId)
    L.push(
      `${th ? '\u0e40\u0e25\u0e02\u0e1b\u0e23\u0e30\u0e08\u0e33\u0e15\u0e31\u0e27\u0e1c\u0e39\u0e49\u0e40\u0e2a\u0e35\u0e22\u0e20\u0e32\u0e29\u0e35' : 'Tax ID'}: ${r.sellerTaxId}${r.branch ? ` (${th ? '\u0e2a\u0e32\u0e02\u0e32' : 'branch'} ${r.branch})` : ''}`,
    );
  if (r.posId) L.push(`POS ID: ${r.posId}`);
  L.push(
    `${th ? '\u0e43\u0e1a\u0e40\u0e2a\u0e23\u0e47\u0e08\u0e40\u0e25\u0e02\u0e17\u0e35\u0e48' : 'Receipt no.'} ${r.number}`,
  );
  if (r.issuedAt) L.push(r.issuedAt.slice(0, 16).replace('T', ' ') + ' UTC');
  L.push('');
  for (const l of r.lines) {
    const n = (th ? l.name.th : l.name.en) || l.name.th || l.name.en || '';
    L.push(`${l.qty} x ${n}  ${baht(l.unitPrice * l.qty)}`);
  }
  L.push('');
  L.push(`${th ? '\u0e22\u0e2d\u0e14\u0e23\u0e27\u0e21' : 'Subtotal'}: ${baht(r.subtotal)}`);
  if (r.serviceCharge > 0)
    L.push(
      `${th ? '\u0e04\u0e48\u0e32\u0e1a\u0e23\u0e34\u0e01\u0e32\u0e23' : 'Service charge'}: ${baht(r.serviceCharge)}`,
    );
  if (r.vatRegistered)
    L.push(
      `${th ? '\u0e20\u0e32\u0e29\u0e35\u0e21\u0e39\u0e25\u0e04\u0e48\u0e32\u0e40\u0e1e\u0e34\u0e48\u0e21' : 'VAT'}: ${baht(r.vat)}`,
    );
  if (r.rounding !== 0)
    L.push(`${th ? '\u0e1b\u0e31\u0e14\u0e40\u0e28\u0e29' : 'Rounding'}: ${baht(r.rounding)}`);
  L.push(`${th ? '\u0e22\u0e2d\u0e14\u0e0a\u0e33\u0e23\u0e30' : 'Total paid'}: ${baht(r.payable)}`);
  for (const p of r.payments)
    L.push(`${(th ? TENDER_TH : TENDER_EN)[p.tender] ?? p.tender}: ${baht(p.amount)}`);
  if (r.vatRegistered)
    L.push(
      '',
      th
        ? '\u0e43\u0e1a\u0e01\u0e33\u0e01\u0e31\u0e1a\u0e20\u0e32\u0e29\u0e35\u0e2d\u0e22\u0e48\u0e32\u0e07\u0e22\u0e48\u0e2d'
        : 'Abbreviated tax invoice',
    );
  return L.join('\n');
}

// ── data export ──
export const EXPORT_DATASETS = ['customers', 'menu', 'orders', 'stock', 'staff', 'points'] as const;
export type ExportDataset = (typeof EXPORT_DATASETS)[number];
/** Flat objects → CSV with the union of their keys as the header (spreadsheet-safe cells). */
export function rowsToCsv(rows: readonly Record<string, unknown>[]): string {
  const keys: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
  return toCsv(
    keys,
    rows.map((r) => keys.map((k) => r[k] ?? '')),
  );
}

// ── tours: what a guest's phone reads and sends ──
const TOUR_PATH = /^\/tour\/([0-9a-f]{32})\/?$/;
export const tourTokenFromPath = (pathname: string): string | null =>
  TOUR_PATH.exec(pathname)?.[1] ?? null;
export const tourLink = (origin: string, token: string): string =>
  `${origin.replace(/\/+$/, '')}/tour/${token}`;
/** The deposit due for a booking: the shop's percentage of price × seats, half up (the same integer arithmetic as the database). */
export const tourDepositFor = (price: number, seats: number, pct: number): number =>
  Math.floor((price * seats * pct + 50) / 100);

export type TourOnlineSlot = {
  id: string;
  title: LocalizedText;
  startsAt: string;
  durationMin: number;
  price: number;
  seatsLeft: number;
  note: string | null;
  depositPerSeat: number;
};
export type TourOnlineInfo = {
  open: boolean;
  storeName: string;
  depositPct: number;
  holdMin: number;
  payNote: string;
  slots: TourOnlineSlot[];
};
export function parseTourOnlineInfo(v: unknown): TourOnlineInfo | null {
  const o = obj(v);
  if (!str(o.store_name)) return null;
  const s = obj(o.settings);
  const slots: TourOnlineSlot[] = [];
  for (const x of list(o.slots)) {
    const t = obj(x);
    if (!str(t.id) || !str(t.starts_at)) continue;
    slots.push({
      id: str(t.id),
      title: name(t.title),
      startsAt: str(t.starts_at),
      durationMin: num(t.duration_min),
      price: num(t.price),
      seatsLeft: num(t.seats_left),
      note: str(t.note) || null,
      depositPerSeat: num(t.deposit_per_seat),
    });
  }
  return {
    open: o.open === true,
    storeName: str(o.store_name),
    depositPct: num(s.deposit_pct),
    holdMin: num(s.hold_min),
    payNote: str(s.pay_note),
    slots,
  };
}
export type TourBookError =
  | 'not_found'
  | 'closed'
  | 'invalid'
  | 'unavailable'
  | 'rate_limited'
  | 'too_many'
  | 'full'
  | 'too_late';
const TOUR_ERRORS: readonly string[] = [
  'not_found',
  'closed',
  'invalid',
  'unavailable',
  'rate_limited',
  'too_many',
  'full',
  'too_late',
];
export type TourBookResult =
  | { ok: true; id: string; code: string | null; depositDue: number; holdUntil: string | null }
  | { ok: false; error: TourBookError | 'failed' };
export function parseTourBookResult(v: unknown): TourBookResult {
  const o = obj(v);
  if (o.ok === true && str(o.id))
    return {
      ok: true,
      id: str(o.id),
      code: str(o.code) || null,
      depositDue: num(o.deposit_due),
      holdUntil: str(o.hold_until) || null,
    };
  const e = str(o.error);
  return { ok: false, error: TOUR_ERRORS.includes(e) ? (e as TourBookError) : 'failed' };
}
export type TourStatus = {
  status: string;
  seats: number;
  depositDue: number;
  depositReceived: number;
  holdUntil: string | null;
  startsAt: string;
  title: LocalizedText;
} | null;
export function parseTourStatus(v: unknown): TourStatus {
  const o = obj(v);
  if (!str(o.status)) return null;
  return {
    status: str(o.status),
    seats: num(o.seats),
    depositDue: num(o.deposit_due),
    depositReceived: num(o.deposit_received),
    holdUntil: str(o.hold_until) || null,
    startsAt: str(o.starts_at),
    title: name(o.title),
  };
}
export type TourSettings = {
  depositPct: number;
  holdMin: number;
  daysAhead: number;
  noticeMin: number;
  payNote: string;
};
export function parseTourLink(
  v: unknown,
): { token: string; settings: TourSettings; enabled: boolean } | null {
  const o = obj(v);
  if (!/^[0-9a-f]{32}$/.test(str(o.token))) return null;
  const s = obj(o.settings);
  return {
    token: str(o.token),
    enabled: o.enabled === true,
    settings: {
      depositPct: num(s.deposit_pct),
      holdMin: num(s.hold_min),
      daysAhead: num(s.days_ahead),
      noticeMin: num(s.notice_min),
      payNote: str(s.pay_note),
    },
  };
}
export type TourDeposit = {
  id: string;
  bookingId: string;
  amount: number;
  method: 'cash' | 'promptpay' | 'gateway';
  status: 'held' | 'on_bill' | 'refunded' | 'forfeited';
};
export function parseTourDeposits(v: unknown): TourDeposit[] {
  const out: TourDeposit[] = [];
  for (const x of list(v)) {
    const o = obj(x);
    if (!str(o.id)) continue;
    const m = o.method === 'cash' || o.method === 'gateway' ? o.method : 'promptpay';
    const s =
      o.status === 'on_bill' || o.status === 'refunded' || o.status === 'forfeited'
        ? o.status
        : 'held';
    out.push({
      id: str(o.id),
      bookingId: str(o.booking_id),
      amount: num(o.amount),
      method: m,
      status: s,
    });
  }
  return out;
}
