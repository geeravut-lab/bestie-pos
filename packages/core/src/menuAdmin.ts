/**
 * Menu editor rules shared by the screens and (as SQL twins) by the database guards:
 * names (Thai required, English optional), prices per channel, modifier min/max, price input parsing.
 * Pure — no React, no I/O. Money is integer satang.
 */
import { MoneyError, parseBaht } from './money';
import type { Satang } from './money';
import type { Channel, ChannelPrices, LocalizedText } from './types';

export const CHANNELS: readonly Channel[] = ['dine-in', 'takeaway', 'delivery', 'qr'];
export const MAX_PRICE: Satang = 100_000_000; // THB 1,000,000 per unit: a typo guard, not a business rule
export const NAME_MAX = 120;
export const STATIONS = ['kitchen', 'bar'] as const;
export type MenuStation = (typeof STATIONS)[number];

/** "55", "55.5", "1,250.00" → satang; null when it is not a price (negative, too many decimals, huge). */
export function parsePriceInput(input: string): Satang | null {
  try {
    const v = parseBaht(input);
    return v <= MAX_PRICE ? v : null;
  } catch (e) {
    if (e instanceof MoneyError) return null;
    throw e;
  }
}

/** Like `parsePriceInput` but a leading "-" or "+" is allowed (option price change: "no meat" = −20). */
export function parseDeltaInput(input: string): Satang | null {
  const t = input.trim();
  if (t === '') return 0;
  const sign = t.startsWith('-') ? -1 : 1;
  const body = t.replace(/^[-+]/, '');
  const v = parsePriceInput(body);
  return v === null ? null : sign * v;
}

/** Satang → what the person edits ("55", "55.5", "55.25"): no trailing zeros, no thousands separator. */
export function priceInputValue(satang: Satang): string {
  const sign = satang < 0 ? '-' : '';
  const abs = Math.abs(satang);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  return frac === 0
    ? `${sign}${whole}`
    : `${sign}${whole}.${String(frac).padStart(2, '0').replace(/0$/, '')}`;
}

// ── names ───────────────────────────────────────────────────────────────────
export type NameProblem = 'th_missing' | 'too_long';

/** Thai is the source language (CLAUDE.md i18n rule); English is optional and falls back to Thai when empty. */
export function nameProblems(name: { th: string; en?: string }): NameProblem[] {
  const out: NameProblem[] = [];
  const th = name.th.trim();
  if (th.length < 1) out.push('th_missing');
  if (th.length > NAME_MAX || (name.en ?? '').trim().length > NAME_MAX) out.push('too_long');
  return out;
}

/** What gets stored: trimmed, and no empty English key. */
export function toLocalizedText(th: string, en: string): LocalizedText {
  const e = en.trim();
  return e === '' ? { th: th.trim() } : { th: th.trim(), en: e };
}

/** Lenient read of a stored value (a bad row must never break a screen). */
export function parseLocalizedText(raw: unknown): LocalizedText {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    const th = typeof r.th === 'string' ? r.th : '';
    return typeof r.en === 'string' && r.en.trim() !== '' ? { th, en: r.en } : { th };
  }
  return { th: '' };
}

/** The name to show for a language, falling back to Thai when there is no translation yet. */
export const localizedName = (n: LocalizedText, lang: 'th' | 'en'): string =>
  (lang === 'en' ? n.en : n.th)?.trim() || n.th;

// ── channel prices ──────────────────────────────────────────────────────────
/** Lenient read: only known channels with whole non-negative satang survive; base is required. */
export function parseChannelPrices(raw: unknown): ChannelPrices | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const ok = (v: unknown): v is number =>
    typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= MAX_PRICE;
  if (!ok(r.base)) return null;
  const out: ChannelPrices = { base: r.base };
  for (const c of CHANNELS) if (ok(r[c])) out[c] = r[c];
  return out;
}

/** Store only what differs from the base (feature-flag rule): an override equal to base is dropped. */
export function channelPricesToColumn(prices: ChannelPrices): ChannelPrices {
  const out: ChannelPrices = { base: prices.base };
  for (const c of CHANNELS) {
    const v = prices[c];
    if (v !== undefined && v !== prices.base) out[c] = v;
  }
  return out;
}

// ── items & modifier groups ─────────────────────────────────────────────────
export type ItemProblem = 'name' | 'price' | 'category' | 'station';

export function itemProblems(d: {
  name: { th: string; en?: string };
  base: Satang | null;
  categoryId: string;
  station: string | null;
}): ItemProblem[] {
  const out: ItemProblem[] = [];
  if (nameProblems(d.name).length > 0) out.push('name');
  if (d.base === null) out.push('price');
  if (d.categoryId === '') out.push('category');
  if (d.station !== null && !(STATIONS as readonly string[]).includes(d.station))
    out.push('station');
  return out;
}

export type GroupProblem =
  'name' | 'min_negative' | 'max_below_one' | 'min_above_max' | 'min_above_options';

/**
 * "Choose between min and max": min 0 = optional, min ≥ 1 = required; max ≥ 1; and a required group needs at least
 * `min` options (otherwise the cashier could never finish the line — the exact bug this check prevents).
 */
export function groupProblems(g: {
  name: { th: string; en?: string };
  min: number;
  max: number;
  optionCount: number;
}): GroupProblem[] {
  const out: GroupProblem[] = [];
  if (nameProblems(g.name).length > 0) out.push('name');
  if (!Number.isInteger(g.min) || g.min < 0) out.push('min_negative');
  if (!Number.isInteger(g.max) || g.max < 1) out.push('max_below_one');
  if (g.min > g.max) out.push('min_above_max');
  if (g.min > g.optionCount) out.push('min_above_options');
  return out;
}

/** Display order: explicit `sort` first, then the order they were made. */
export function bySort<T extends { sort: number; created_at?: string }>(a: T, b: T): number {
  return a.sort - b.sort || (a.created_at ?? '').localeCompare(b.created_at ?? '');
}
