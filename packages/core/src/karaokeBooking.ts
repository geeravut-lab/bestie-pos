// Online booking of karaoke rooms by guests (module `karaoke.booking`, migration 75): the shop's settings, the deposit arithmetic and what a guest's phone
// reads from the server. Pure functions only; the database does the real checking, these read its answers safely.

export type KaraokeBookingSettings = {
  /** First bookable start, "HH:MM" Bangkok time. */
  open: string;
  /** Last bookable START ("HH:MM"). */
  close: string;
  stepMin: number;
  leadMin: number;
  maxDays: number;
  /** Deposit as a percentage of the booked room time (0–100). */
  depositPct: number;
  /** Minutes an online booking waits for its deposit before it is released. */
  holdMin: number;
  /** What the guest is told about how to pay the deposit (e.g. the PromptPay number). */
  payNote: string;
};

export const DEFAULT_KARAOKE_BOOKING: KaraokeBookingSettings = {
  open: '12:00',
  close: '23:00',
  stepMin: 30,
  leadMin: 60,
  maxDays: 30,
  depositPct: 30,
  holdMin: 120,
  payNote: '',
};

const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const int = (v: unknown, fallback: number): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) ? n : fallback;
};
const text = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.trim().slice(0, max) : '';

/** The settings with the defaults filled in (the same defaults as the database). */
export function parseKaraokeBookingSettings(raw: unknown): KaraokeBookingSettings {
  const o = obj(raw);
  const d = DEFAULT_KARAOKE_BOOKING;
  return {
    open: typeof o.open === 'string' && HHMM.test(o.open) ? o.open : d.open,
    close: typeof o.close === 'string' && HHMM.test(o.close) ? o.close : d.close,
    stepMin: int(o.step_min, d.stepMin),
    leadMin: int(o.lead_min, d.leadMin),
    maxDays: int(o.max_days, d.maxDays),
    depositPct: int(o.deposit_pct, d.depositPct),
    holdMin: int(o.hold_min, d.holdMin),
    payNote: text(o.pay_note, 200),
  };
}

export type KaraokeBookingSettingsProblem = 'hours' | 'step' | 'lead' | 'days' | 'deposit' | 'hold';

/** What is wrong with the settings (same limits as the database), or null. */
export function karaokeBookingSettingsProblem(
  s: KaraokeBookingSettings,
): KaraokeBookingSettingsProblem | null {
  if (!HHMM.test(s.open) || !HHMM.test(s.close) || s.open >= s.close) return 'hours';
  if (s.stepMin < 5 || s.stepMin > 120) return 'step';
  if (s.leadMin < 0 || s.leadMin > 10080) return 'lead';
  if (s.maxDays < 1 || s.maxDays > 180) return 'days';
  if (s.depositPct < 0 || s.depositPct > 100) return 'deposit';
  if (s.holdMin < 15 || s.holdMin > 2880 || s.payNote.length > 200) return 'hold';
  return null;
}

/** What the page sends to `save_karaoke_booking_settings`. */
export const karaokeBookingSettingsPayload = (s: KaraokeBookingSettings) => ({
  open: s.open,
  close: s.close,
  step_min: s.stepMin,
  lead_min: s.leadMin,
  max_days: s.maxDays,
  deposit_pct: s.depositPct,
  hold_min: s.holdMin,
  pay_note: s.payNote,
});

/** The deposit for a room price (satang): the shop's percentage, half up. Same arithmetic as `karaoke_deposit_for`. */
export const karaokeDepositFor = (priceSatang: number, pct: number): number =>
  Math.floor((priceSatang * Math.max(0, Math.min(100, pct)) + 50) / 100);

const PATH = /^\/kb\/([0-9a-f]{32})\/?$/;
/** The token in `/kb/<token>`, or null when the URL is not a karaoke booking link. */
export const karaokeBookingTokenFromPath = (pathname: string): string | null =>
  PATH.exec(pathname)?.[1] ?? null;
export const karaokeBookingLink = (origin: string, token: string): string =>
  `${origin.replace(/\/+$/, '')}/kb/${token}`;

// ── what a guest's phone reads ──
export type KaraokeBookRoom = {
  id: string;
  name: string;
  /** Satang per hour. */
  ratePerHour: number;
  /** The lengths (minutes) the room can be booked for. */
  lengths: number[];
};
export type KaraokeBookingInfo =
  | { open: false; storeName: string }
  | {
      open: true;
      storeName: string;
      settings: KaraokeBookingSettings;
      rooms: KaraokeBookRoom[];
    };

export function parseKaraokeBookingInfo(raw: unknown): KaraokeBookingInfo | null {
  const o = obj(raw);
  const storeName = text(o.store_name, 120);
  if (!storeName) return null;
  if (o.open !== true) return { open: false, storeName };
  const rooms: KaraokeBookRoom[] = [];
  for (const x of Array.isArray(o.rooms) ? o.rooms : []) {
    const r = obj(x);
    const name = text(r.name, 60);
    if (typeof r.id !== 'string' || !name) continue;
    const lengths = (Array.isArray(r.lengths) ? r.lengths : []).filter(
      (n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 15 && n <= 720,
    );
    if (lengths.length === 0) continue;
    rooms.push({ id: r.id, name, ratePerHour: Math.max(0, int(r.rate_per_hour, 0)), lengths });
  }
  return { open: true, storeName, settings: parseKaraokeBookingSettings(o.settings), rooms };
}

export const KARAOKE_BOOK_ERRORS = [
  'off',
  'invalid',
  'taken',
  'too_many',
  'not_found',
  'closed',
] as const;
export type KaraokeBookError = (typeof KARAOKE_BOOK_ERRORS)[number];
const asError = (v: unknown): KaraokeBookError =>
  (KARAOKE_BOOK_ERRORS as readonly string[]).includes(String(v))
    ? (v as KaraokeBookError)
    : 'invalid';

export type KaraokeBookResult =
  | {
      ok: true;
      id: string;
      /** Shown once; null when the same request is repeated. */
      code: string | null;
      startsAt: string;
      minutes: number;
      room: string;
      price: number;
      depositDue: number;
      holdUntil: string | null;
    }
  | { ok: false; error: KaraokeBookError };

export function parseKaraokeBookResult(raw: unknown): KaraokeBookResult {
  const o = obj(raw);
  if (o.ok !== true || typeof o.id !== 'string' || typeof o.starts_at !== 'string')
    return { ok: false, error: asError(o.error) };
  return {
    ok: true,
    id: o.id,
    code: typeof o.code === 'string' ? o.code : null,
    startsAt: o.starts_at,
    minutes: int(o.minutes, 0),
    room: text(o.room, 60),
    price: Math.max(0, int(o.price, 0)),
    depositDue: Math.max(0, int(o.deposit_due, 0)),
    holdUntil: typeof o.hold_until === 'string' ? o.hold_until : null,
  };
}

export type KaraokeBookStatus =
  | {
      ok: true;
      status: string;
      startsAt: string;
      minutes: number;
      room: string;
      depositDue: number;
      depositPaid: number;
      holdUntil: string | null;
    }
  | { ok: false; error: KaraokeBookError };

export function parseKaraokeBookStatus(raw: unknown): KaraokeBookStatus {
  const o = obj(raw);
  if (o.ok !== true || typeof o.status !== 'string' || typeof o.starts_at !== 'string')
    return { ok: false, error: asError(o.error) };
  return {
    ok: true,
    status: o.status,
    startsAt: o.starts_at,
    minutes: int(o.minutes, 0),
    room: text(o.room, 60),
    depositDue: Math.max(0, int(o.deposit_due, 0)),
    depositPaid: Math.max(0, int(o.deposit_paid, 0)),
    holdUntil: typeof o.hold_until === 'string' ? o.hold_until : null,
  };
}

export const parseKaraokeCancelResult = (
  raw: unknown,
): { ok: true } | { ok: false; error: KaraokeBookError } => {
  const o = obj(raw);
  return o.ok === true ? { ok: true } : { ok: false, error: asError(o.error) };
};

// ── the front desk's view of deposits ──
export const KARAOKE_DEPOSIT_METHODS = ['cash', 'promptpay', 'gateway'] as const;
export type KaraokeDepositMethod = (typeof KARAOKE_DEPOSIT_METHODS)[number];
export type KaraokeDepositStatus = 'held' | 'on_bill' | 'forfeited' | 'refunded';
export type KaraokeDeposit = {
  id: string;
  bookingId: string;
  amount: number;
  method: KaraokeDepositMethod;
  status: KaraokeDepositStatus;
};
export function parseKaraokeDeposits(v: unknown): KaraokeDeposit[] {
  if (!Array.isArray(v)) return [];
  const out: KaraokeDeposit[] = [];
  for (const x of v) {
    const o = obj(x);
    const method = String(o.method);
    const status = String(o.status);
    if (
      typeof o.id !== 'string' ||
      typeof o.booking_id !== 'string' ||
      typeof o.amount !== 'number' ||
      !(KARAOKE_DEPOSIT_METHODS as readonly string[]).includes(method) ||
      !['held', 'on_bill', 'forfeited', 'refunded'].includes(status)
    )
      continue;
    out.push({
      id: o.id,
      bookingId: o.booking_id,
      amount: o.amount,
      method: method as KaraokeDepositMethod,
      status: status as KaraokeDepositStatus,
    });
  }
  return out;
}
/** What is in hand for a booking (held or already on its bill), satang. */
export const karaokeDepositPaid = (list: readonly KaraokeDeposit[], bookingId: string): number =>
  list
    .filter((d) => d.bookingId === bookingId && (d.status === 'held' || d.status === 'on_bill'))
    .reduce((s, d) => s + d.amount, 0);
