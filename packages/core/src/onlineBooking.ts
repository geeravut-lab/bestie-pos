// Online booking by guests (module `booking.online`): the shop's booking settings and what a guest's phone reads from the server.
// Pure functions only; the database does the real checking (migration 54), these just read answers safely.
import type { LocalizedText } from './types';

export type BookingSettings = {
  /** First bookable start, "HH:MM" Bangkok time. */
  open: string;
  /** Closing time: a booking must end by then. */
  close: string;
  /** Minutes between possible start times. */
  stepMin: number;
  /** Shortest notice: nobody can book a time that starts sooner than this. */
  leadMin: number;
  /** How many days ahead guests may book. */
  maxDays: number;
};

export const DEFAULT_BOOKING: BookingSettings = {
  open: '09:00',
  close: '20:00',
  stepMin: 30,
  leadMin: 120,
  maxDays: 30,
};

const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const int = (v: unknown, fallback: number): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) ? n : fallback;
};
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** The settings with the defaults filled in (the same defaults as the database). */
export function parseBookingSettings(raw: unknown): BookingSettings {
  const o = obj(raw);
  return {
    open: typeof o.open === 'string' && HHMM.test(o.open) ? o.open : DEFAULT_BOOKING.open,
    close: typeof o.close === 'string' && HHMM.test(o.close) ? o.close : DEFAULT_BOOKING.close,
    stepMin: int(o.step_min, DEFAULT_BOOKING.stepMin),
    leadMin: int(o.lead_min, DEFAULT_BOOKING.leadMin),
    maxDays: int(o.max_days, DEFAULT_BOOKING.maxDays),
  };
}

export type BookingSettingsProblem = 'hours' | 'step' | 'lead' | 'days';

/** What is wrong with the settings (same limits as the database), or null. */
export function bookingSettingsProblem(s: BookingSettings): BookingSettingsProblem | null {
  if (!HHMM.test(s.open) || !HHMM.test(s.close) || s.open >= s.close) return 'hours';
  if (s.stepMin < 5 || s.stepMin > 120) return 'step';
  if (s.leadMin < 0 || s.leadMin > 10080) return 'lead';
  if (s.maxDays < 1 || s.maxDays > 180) return 'days';
  return null;
}

/** What the page sends to `save_booking_settings`. */
export const bookingSettingsPayload = (s: BookingSettings) => ({
  open: s.open,
  close: s.close,
  step_min: s.stepMin,
  lead_min: s.leadMin,
  max_days: s.maxDays,
});

const BOOK_PATH = /^\/book\/([0-9a-f]{32})\/?$/;

/** The token in `/book/<token>`, or null when the URL is not a booking link. */
export const bookingTokenFromPath = (pathname: string): string | null =>
  BOOK_PATH.exec(pathname)?.[1] ?? null;

export const bookingLink = (origin: string, token: string): string =>
  `${origin.replace(/\/+$/, '')}/book/${token}`;

// ── what a guest's phone reads ──
export type BookingService = {
  id: string;
  name: LocalizedText;
  durationMin: number;
  /** Satang. */
  price: number;
};
export type BookingProvider = { id: string; name: string };
export type BookingInfo =
  | { open: false; storeName: string }
  | {
      open: true;
      storeName: string;
      settings: BookingSettings;
      services: BookingService[];
      providers: BookingProvider[];
    };

const text = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.trim().slice(0, max) : '';

export function parseBookingInfo(raw: unknown): BookingInfo | null {
  const o = obj(raw);
  const storeName = text(o.store_name, 120);
  if (!storeName) return null;
  if (o.open !== true) return { open: false, storeName };
  const services: BookingService[] = [];
  for (const x of Array.isArray(o.services) ? o.services : []) {
    const r = obj(x);
    const n = obj(r.name);
    const th = text(n.th, 120);
    const dur = int(r.duration_min, 0);
    if (typeof r.id !== 'string' || !th || dur < 5 || dur > 720) continue;
    const en = text(n.en, 120);
    services.push({
      id: r.id,
      name: en ? { th, en } : { th },
      durationMin: dur,
      price: Math.max(0, int(r.price, 0)),
    });
  }
  const providers: BookingProvider[] = [];
  for (const x of Array.isArray(o.providers) ? o.providers : []) {
    const r = obj(x);
    const name = text(r.name, 60);
    if (typeof r.id === 'string' && name) providers.push({ id: r.id, name });
  }
  return { open: true, storeName, settings: parseBookingSettings(o.settings), services, providers };
}

/** "HH:MM" start times from the server; anything else is dropped. */
export const parseSlots = (raw: unknown): string[] =>
  (Array.isArray(raw) ? raw : []).filter((x): x is string => typeof x === 'string' && HHMM.test(x));

export type BookingError = 'off' | 'invalid' | 'taken' | 'too_many' | 'not_found' | 'closed';
const ERRORS: readonly BookingError[] = [
  'off',
  'invalid',
  'taken',
  'too_many',
  'not_found',
  'closed',
];
export type BookingResult =
  | { ok: true; id: string; code: string | null; startsAt: string; provider: string | null }
  | { ok: false; error: BookingError | 'failed' };

export function parseBookingResult(raw: unknown): BookingResult {
  const o = obj(raw);
  if (o.ok === true && typeof o.id === 'string' && typeof o.starts_at === 'string') {
    return {
      ok: true,
      id: o.id,
      code: typeof o.code === 'string' ? o.code : null,
      startsAt: o.starts_at,
      provider: typeof o.provider === 'string' ? o.provider : null,
    };
  }
  const e = o.error;
  return { ok: false, error: ERRORS.find((x) => x === e) ?? 'failed' };
}

export type CancelResult =
  { ok: true } | { ok: false; error: 'invalid' | 'closed' | 'not_found' | 'failed' };

export function parseCancelResult(raw: unknown): CancelResult {
  const o = obj(raw);
  if (o.ok === true) return { ok: true };
  const e = o.error;
  return {
    ok: false,
    error: e === 'invalid' || e === 'closed' || e === 'not_found' ? e : 'failed',
  };
}

/** A date "YYYY-MM-DD" in Bangkok `n` days after `today` (also Bangkok). */
export function bookingDays(today: string, n: number): string[] {
  const out: string[] = [];
  const base = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(base)) return out;
  for (let i = 0; i < n; i++) out.push(new Date(base + i * 86_400_000).toISOString().slice(0, 10));
  return out;
}
