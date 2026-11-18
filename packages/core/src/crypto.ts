import type { Satang } from './money';

/**
 * Crypto top-up of Bestie Credit (module `credit.topup.crypto`, off by default, legally gated).
 * Pure rules only: no network, no keys. The money never leaves THB: the customer sends a STABLECOIN to the company's
 * receiving address, the server watches the chain, and after the required confirmations Bestie Credit (THB 1:1) is added.
 * Spec: docs/modules/CRYPTO_TOPUP.md · knowledge: docs/CRYPTO_TRANSFER_KNOWLEDGE.md
 */
export type CryptoNetwork = 'tron' | 'ethereum';

export type NetworkInfo = {
  label: string;
  /** What the customer is told, in words, next to the QR — a wrong network is the commonest mistake. */
  tokenLabel: string;
  /** USDT contract. ⚠️ verify against the issuer's official list before going live. */
  contract: string;
  decimals: 6;
  /** Confirmations (blocks) before Credit is added. */
  confirmations: number;
  /** Smallest top-up, satang. */
  minThb: Satang;
  /** EIP-155 chain id (EVM only). */
  chainId?: number;
};

export const CRYPTO_NETWORKS: Record<CryptoNetwork, NetworkInfo> = {
  tron: {
    label: 'TRON',
    tokenLabel: 'USDT on TRON (TRC-20)',
    contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    decimals: 6,
    confirmations: 20,
    minThb: 50_000, // THB 500
  },
  ethereum: {
    label: 'Ethereum',
    tokenLabel: 'USDT on Ethereum (ERC-20)',
    contract: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    decimals: 6,
    confirmations: 12,
    minThb: 100_000, // THB 1,000
    chainId: 1,
  },
};

export const isCryptoNetwork = (v: unknown): v is CryptoNetwork => v === 'tron' || v === 'ethereum';

/** A request lives 15 minutes (stablecoin). */
export const REQUEST_TTL_MS = 15 * 60_000;
/** Two price sources must agree within 1.5 %, otherwise no request is issued. */
export const MAX_RATE_GAP_BPS = 150;
/** Outstanding Credit that may be held by one customer when topping up with crypto, satang. */
export const MAX_CREDIT_BALANCE_CRYPTO: Satang = 10_000_000; // THB 100,000

const UNIT = 1_000_000; // 6 decimals

// ── rate and amount ─────────────────────────────────────────────────────────
/** Rate = satang per 1.000000 USDT (THB 36.50 → 3650). */
export type RateLock =
  { ok: true; rate: number } | { ok: false; reason: 'rates_disagree' | 'bad_rate' };

/**
 * Two independent sources must agree (≤ 1.5 %). The LOWER rate is locked: the customer sends slightly more USDT for the
 * same baht, so a source that is a little high can never leave the shop short.
 */
export function lockRate(a: number, b: number, maxGapBps = MAX_RATE_GAP_BPS): RateLock {
  if (![a, b].every((x) => Number.isFinite(x) && x > 0)) return { ok: false, reason: 'bad_rate' };
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  if (((hi - lo) * 10_000) / lo > maxGapBps) return { ok: false, reason: 'rates_disagree' };
  return { ok: true, rate: Math.round(lo) };
}

/** USDT base units (6 decimals) worth `thb` satang at `rate`, rounded to whole cents of USDT (0.01). */
export function baseUnits(thb: Satang, rate: number): number {
  if (!Number.isSafeInteger(thb) || thb <= 0 || !Number.isFinite(rate) || rate <= 0)
    throw new RangeError('amount and rate must be positive');
  const exact = (thb * UNIT) / rate;
  return Math.max(10_000, Math.round(exact / 10_000) * 10_000);
}

/** The exact amount asked of the customer: base + a suffix of 1…999 base units that is unique among live requests. */
export const SUFFIX_MAX = 999;
export function pickSuffix(taken: ReadonlySet<number>, seed: number): number | null {
  for (let i = 0; i < SUFFIX_MAX; i++) {
    const s = ((Math.abs(Math.trunc(seed)) + i) % SUFFIX_MAX) + 1;
    if (!taken.has(s)) return s;
  }
  return null;
}
export const requestUnits = (thb: Satang, rate: number, suffix: number): number => {
  if (!Number.isInteger(suffix) || suffix < 1 || suffix > SUFFIX_MAX)
    throw new RangeError('bad suffix');
  return baseUnits(thb, rate) + suffix;
};

/** "28.450317" */
export function formatUnits(units: number): string {
  const whole = Math.floor(units / UNIT);
  const frac = String(units % UNIT).padStart(6, '0');
  return `${whole}.${frac}`;
}

// ── matching ────────────────────────────────────────────────────────────────
/** Allowed difference: 0.5 % of the request or 0.10 USDT, whichever is smaller. */
export const amountTolerance = (expectedUnits: number): number =>
  Math.min(Math.floor((expectedUnits * 50) / 10_000), 100_000);

export type Candidate = { id: string; expectedUnits: number; expiresAtMs: number };

/**
 * Which open request a transfer belongs to: the one whose amount is nearest and within tolerance. Two requests that are
 * equally near (or the runner-up is within 2 suffix steps) are ambiguous → null → a person decides. A transfer arriving
 * after the request expired is never matched here.
 */
export function matchRequest(
  receivedUnits: number,
  arrivedAtMs: number,
  candidates: readonly Candidate[],
): { id: string } | { problem: 'none' | 'ambiguous' | 'late' } {
  const near = candidates
    .map((c) => ({ c, d: Math.abs(c.expectedUnits - receivedUnits) }))
    .filter((x) => x.d <= amountTolerance(x.c.expectedUnits))
    .sort((a, b) => a.d - b.d);
  if (near.length === 0) return { problem: 'none' };
  const best = near[0]!;
  if (near.length > 1 && near[1]!.d - best.d <= 2) return { problem: 'ambiguous' };
  if (arrivedAtMs > best.c.expiresAtMs) return { problem: 'late' };
  return { id: best.c.id };
}

export type PaymentVerdict = 'exact' | 'under' | 'over' | 'late';
/** Used by the review screen to explain a transfer that was not credited automatically. */
export function classifyPayment(p: {
  expectedUnits: number;
  receivedUnits: number;
  arrivedAtMs: number;
  expiresAtMs: number;
}): PaymentVerdict {
  if (p.arrivedAtMs > p.expiresAtMs) return 'late';
  const tol = amountTolerance(p.expectedUnits);
  if (p.receivedUnits < p.expectedUnits - tol) return 'under';
  if (p.receivedUnits > p.expectedUnits + tol) return 'over';
  return 'exact';
}

export const confirmationsDone = (network: CryptoNetwork, confirmations: number): boolean =>
  confirmations >= CRYPTO_NETWORKS[network].confirmations;

// ── addresses and QR ────────────────────────────────────────────────────────
/** Format check only (the server also verifies the Tron Base58Check checksum). */
export function addressFormatOk(network: CryptoNetwork, address: string): boolean {
  return network === 'tron'
    ? /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)
    : /^0x[0-9a-fA-F]{40}$/.test(address);
}

/** First 6 and last 6 characters, shown LARGE so staff compare them with the card printed at the shop. */
export function addressParts(address: string): { head: string; middle: string; tail: string } {
  if (address.length <= 12) return { head: address, middle: '', tail: '' };
  return { head: address.slice(0, 6), middle: address.slice(6, -6), tail: address.slice(-6) };
}

/**
 * What goes in the QR. Ethereum: EIP-681 token transfer (`ethereum:<contract>@1/transfer?address=<to>&uint256=<units>`),
 * so the wallet fills in the amount. Tron has no standard every wallet reads: the QR holds the address only and the
 * amount is shown large with a copy button.
 */
export function paymentQrValue(p: {
  network: CryptoNetwork;
  address: string;
  units: number;
}): string {
  if (p.network === 'tron') return p.address;
  const n = CRYPTO_NETWORKS.ethereum;
  return `ethereum:${n.contract}@${n.chainId}/transfer?address=${p.address}&uint256=${p.units}`;
}

// ── KYC tiers and limits ────────────────────────────────────────────────────
export type KycTier = 'T1' | 'T2';
export type TierLimits = { perTxMin: Satang; perTxMax: Satang; perDay: Satang; per30Days: Satang };

/** ⚠️ waiting for the lawyer (CRYPTO_TRANSFER_KNOWLEDGE §6); the owner can change these in the settings later. */
export const CRYPTO_TIERS: Record<KycTier, TierLimits> = {
  T1: { perTxMin: 50_000, perTxMax: 3_000_000, perDay: 3_000_000, per30Days: 5_000_000 },
  T2: { perTxMin: 50_000, perTxMax: 10_000_000, perDay: 10_000_000, per30Days: 50_000_000 },
};

export type LimitProblem =
  'below_minimum' | 'per_transaction' | 'per_day' | 'per_30_days' | 'balance_cap';

export function limitProblems(p: {
  tier: KycTier;
  network: CryptoNetwork;
  thb: Satang;
  /** Sum of the customer's live + credited crypto requests (satang) in the last 24 h / 30 days. */
  usedDay: Satang;
  used30d: Satang;
  /** Credit balance now (satang). */
  balance: Satang;
}): LimitProblem[] {
  const t = CRYPTO_TIERS[p.tier];
  const out: LimitProblem[] = [];
  if (p.thb < Math.max(t.perTxMin, CRYPTO_NETWORKS[p.network].minThb)) out.push('below_minimum');
  if (p.thb > t.perTxMax) out.push('per_transaction');
  if (p.usedDay + p.thb > t.perDay) out.push('per_day');
  if (p.used30d + p.thb > t.per30Days) out.push('per_30_days');
  if (p.balance + p.thb > MAX_CREDIT_BALANCE_CRYPTO) out.push('balance_cap');
  return out;
}

export type CryptoFlag =
  'many_topups_24h' | 'near_limit_repeated' | 'address_shared' | 'many_addresses_30d';

/** Automatic review flags (CRYPTO_TRANSFER_KNOWLEDGE §6). */
export function cryptoFlags(p: {
  topups24h: number;
  nearLimitTopups30d: number;
  customersOnThisAddress: number;
  addresses30d: number;
}): CryptoFlag[] {
  const f: CryptoFlag[] = [];
  if (p.topups24h > 3) f.push('many_topups_24h');
  if (p.nearLimitTopups30d >= 2) f.push('near_limit_repeated');
  if (p.customersOnThisAddress > 1) f.push('address_shared');
  if (p.addresses30d > 3) f.push('many_addresses_30d');
  return f;
}

// ── Tron address checksum (Base58Check = 0x41 + 20 bytes + 4-byte double-SHA256 checksum) ──
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 (pure, so the browser can check a Tron address without a crypto library). */
export function sha256(data: Uint8Array): Uint8Array {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const bitLen = data.length * 8;
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, bitLen >>> 0);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  h.forEach((x, i) => ov.setUint32(i * 4, x));
  return out;
}

/** A Tron address is valid when it decodes to 25 bytes, starts with 0x41 and its double-SHA256 checksum matches. */
export function tronAddressValid(address: string): boolean {
  if (!addressFormatOk('tron', address)) return false;
  let n = 0n;
  for (const ch of address) n = n * 58n + BigInt(B58.indexOf(ch));
  const bytes = new Uint8Array(25);
  for (let i = 24; i >= 0; i--) {
    bytes[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  if (n !== 0n || bytes[0] !== 0x41) return false;
  const sum = sha256(sha256(bytes.slice(0, 21)));
  return (
    bytes[21] === sum[0] && bytes[22] === sum[1] && bytes[23] === sum[2] && bytes[24] === sum[3]
  );
}

/** Format for Ethereum (case-insensitive: the EIP-55 checksum needs keccak and is checked by the wallet app and by the 6+6 comparison). */
export const cryptoAddressValid = (network: CryptoNetwork, address: string): boolean =>
  network === 'tron' ? tronAddressValid(address) : addressFormatOk('ethereum', address);
