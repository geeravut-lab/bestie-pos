/**
 * Money = integer satang (THB × 100). Never floats (CLAUDE.md).
 * Every function here either returns a safe integer or throws; nothing rounds silently.
 */

/** Integer satang. A plain number alias — validated at the boundaries with `assertSatang`. */
export type Satang = number;

export const SATANG_PER_BAHT = 100;
export const BPS = 10_000; // basis points: 100% = 10_000

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

export function isSatang(n: unknown): n is Satang {
  return typeof n === 'number' && Number.isSafeInteger(n);
}

export function assertSatang(n: unknown, what = 'amount'): asserts n is Satang {
  if (!isSatang(n))
    throw new MoneyError(`${what} must be an integer number of satang, got ${String(n)}`);
}

export function assertNonNegative(n: Satang, what = 'amount'): void {
  assertSatang(n, what);
  if (n < 0) throw new MoneyError(`${what} must not be negative`);
}

/** Whole baht → satang. */
export const baht = (whole: number): Satang => {
  if (!Number.isSafeInteger(whole))
    throw new MoneyError('baht() takes whole baht; use parseBaht for decimals');
  return whole * SATANG_PER_BAHT;
};

/**
 * Parse what a human typed ("125", "125.5", "1,250.00") into satang, exactly (string maths, no floats).
 * At most 2 decimals; anything else throws.
 */
export function parseBaht(input: string): Satang {
  const cleaned = input.trim().replace(/,/g, '');
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!m) throw new MoneyError(`not a valid baht amount: "${input}"`);
  const whole = Number(m[1]);
  const frac = Number((m[2] ?? '').padEnd(2, '0') || '0');
  const out = whole * SATANG_PER_BAHT + frac;
  assertSatang(out);
  return out;
}

export type RoundMode = 'half-up' | 'floor' | 'ceil';

/** amount × bps / 10_000 with explicit rounding. `amount` must be ≥ 0. */
export function mulBps(amount: Satang, bps: number, mode: RoundMode = 'half-up'): Satang {
  assertNonNegative(amount);
  if (!Number.isSafeInteger(bps) || bps < 0)
    throw new MoneyError('bps must be a non-negative integer');
  const product = amount * bps;
  if (!Number.isSafeInteger(product)) throw new MoneyError('amount too large');
  switch (mode) {
    case 'floor':
      return Math.floor(product / BPS);
    case 'ceil':
      return Math.ceil(product / BPS);
    default:
      return Math.floor((product + BPS / 2) / BPS);
  }
}

export const sum = (xs: readonly Satang[]): Satang => xs.reduce((a, b) => a + b, 0);

/**
 * Split `total` across `weights` so the parts add up EXACTLY to total (largest remainder;
 * ties go to the earlier index, so the result is deterministic). Used for split bills.
 */
export function allocate(total: Satang, weights: readonly number[]): Satang[] {
  assertNonNegative(total, 'total');
  if (weights.length === 0) throw new MoneyError('allocate needs at least one weight');
  if (weights.some((w) => !Number.isFinite(w) || w < 0))
    throw new MoneyError('weights must be non-negative');
  const weightSum = weights.reduce((a, b) => a + b, 0);
  if (weightSum <= 0) throw new MoneyError('weights must not all be zero');

  const exact = weights.map((w) => (total * w) / weightSum);
  const base = exact.map(Math.floor);
  let remaining = total - sum(base);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remaining <= 0) break;
    base[i] = (base[i] ?? 0) + 1;
    remaining -= 1;
  }
  return base;
}

/** Equal split into `n` parts that sum exactly to total. */
export const splitEvenly = (total: Satang, n: number): Satang[] => {
  if (!Number.isSafeInteger(n) || n < 1) throw new MoneyError('n must be a positive integer');
  return allocate(
    total,
    Array.from({ length: n }, () => 1),
  );
};

/** Display only — never feed the result back into maths. */
export function formatTHB(
  amount: Satang,
  locale: 'th-TH' | 'en-GB' = 'th-TH',
  opts: { symbol?: boolean } = {},
): string {
  assertSatang(amount);
  const sign = amount < 0 ? '-' : '';
  const abs = Math.abs(amount);
  const whole = Math.floor(abs / SATANG_PER_BAHT);
  const frac = abs % SATANG_PER_BAHT;
  const wholeStr = new Intl.NumberFormat(locale).format(whole);
  const body = frac === 0 ? wholeStr : `${wholeStr}.${String(frac).padStart(2, '0')}`;
  return `${sign}${opts.symbol === false ? '' : '\u0E3F'}${body}`;
}
