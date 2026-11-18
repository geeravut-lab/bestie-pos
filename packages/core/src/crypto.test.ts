import { describe, expect, it } from 'vitest';
import {
  CRYPTO_NETWORKS,
  addressFormatOk,
  addressParts,
  amountTolerance,
  baseUnits,
  classifyPayment,
  confirmationsDone,
  cryptoFlags,
  formatUnits,
  limitProblems,
  lockRate,
  matchRequest,
  paymentQrValue,
  pickSuffix,
  sha256,
  tronAddressValid,
  cryptoAddressValid,
  requestUnits,
} from './crypto';

describe('rate lock', () => {
  it('locks the lower of two agreeing rates', () => {
    expect(lockRate(3650, 3662)).toEqual({ ok: true, rate: 3650 });
  });
  it('refuses when the sources differ by more than 1.5 %', () => {
    expect(lockRate(3650, 3710)).toEqual({ ok: false, reason: 'rates_disagree' });
    expect(lockRate(3650, 3700).ok).toBe(true); // 1.37 %
  });
  it('refuses nonsense', () => {
    expect(lockRate(0, 3650)).toEqual({ ok: false, reason: 'bad_rate' });
    expect(lockRate(NaN, 3650)).toEqual({ ok: false, reason: 'bad_rate' });
  });
});

describe('amounts', () => {
  it('turns baht into USDT to the cent and adds the suffix', () => {
    // THB 1,000 at 36.50 = 27.397260… → 27.40
    expect(baseUnits(100_000, 3650)).toBe(27_400_000);
    expect(formatUnits(requestUnits(100_000, 3650, 317))).toBe('27.400317');
  });
  it('never asks for less than 0.01 USDT and rejects bad input', () => {
    expect(baseUnits(1, 3650)).toBe(10_000);
    expect(() => baseUnits(0, 3650)).toThrow();
    expect(() => requestUnits(100_000, 3650, 0)).toThrow();
    expect(() => requestUnits(100_000, 3650, 1000)).toThrow();
  });
  it('picks a free suffix, and says so when all 999 are taken', () => {
    expect(pickSuffix(new Set(), 41)).toBe(42);
    expect(pickSuffix(new Set([42]), 41)).toBe(43);
    expect(pickSuffix(new Set(Array.from({ length: 999 }, (_, i) => i + 1)), 5)).toBeNull();
  });
  it('tolerance is 0.5 % or 0.10 USDT, whichever is smaller', () => {
    expect(amountTolerance(10_000_000)).toBe(50_000); // 10 USDT → 0.05
    expect(amountTolerance(100_000_000)).toBe(100_000); // 100 USDT → capped at 0.10
  });
});

describe('matching a transfer to a request', () => {
  const t0 = 1_000_000;
  const c = (id: string, units: number) => ({
    id,
    expectedUnits: units,
    expiresAtMs: t0 + 900_000,
  });
  it('matches the nearest request within tolerance', () => {
    expect(matchRequest(27_400_317, t0 + 1000, [c('a', 27_400_317), c('b', 27_400_902)])).toEqual({
      id: 'a',
    });
  });
  it('is ambiguous when two requests are equally near, and refuses unknown amounts', () => {
    expect(matchRequest(27_400_500, t0, [c('a', 27_400_499), c('b', 27_400_501)])).toEqual({
      problem: 'ambiguous',
    });
    expect(matchRequest(5_000_000, t0, [c('a', 27_400_317)])).toEqual({ problem: 'none' });
  });
  it('never matches a transfer that arrived after the request expired', () => {
    expect(matchRequest(27_400_317, t0 + 900_001, [c('a', 27_400_317)])).toEqual({
      problem: 'late',
    });
  });
  it('explains a payment for the review screen', () => {
    const base = { expectedUnits: 27_400_317, arrivedAtMs: 0, expiresAtMs: 10 };
    expect(classifyPayment({ ...base, receivedUnits: 27_400_317 })).toBe('exact');
    expect(classifyPayment({ ...base, receivedUnits: 20_000_000 })).toBe('under');
    expect(classifyPayment({ ...base, receivedUnits: 30_000_000 })).toBe('over');
    expect(classifyPayment({ ...base, receivedUnits: 27_400_317, arrivedAtMs: 11 })).toBe('late');
  });
});

describe('networks, addresses, QR', () => {
  it('waits for 20 blocks on Tron and 12 on Ethereum', () => {
    expect(confirmationsDone('tron', 19)).toBe(false);
    expect(confirmationsDone('tron', 20)).toBe(true);
    expect(confirmationsDone('ethereum', 12)).toBe(true);
    expect(CRYPTO_NETWORKS.tron.tokenLabel).toBe('USDT on TRON (TRC-20)');
  });
  it('checks address formats', () => {
    expect(addressFormatOk('tron', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')).toBe(true);
    expect(addressFormatOk('tron', '0xdAC17F958D2ee523a2206206994597C13D831ec7')).toBe(false);
    expect(addressFormatOk('ethereum', '0xdAC17F958D2ee523a2206206994597C13D831ec7')).toBe(true);
    expect(addressFormatOk('ethereum', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')).toBe(false);
  });
  it('splits an address for the 6 + 6 check', () => {
    expect(addressParts('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')).toMatchObject({
      head: 'TR7NHq',
      tail: 'gjLj6t',
    });
  });
  it('builds EIP-681 for Ethereum and a bare address for Tron', () => {
    const eth = '0x1111111111111111111111111111111111111111';
    expect(paymentQrValue({ network: 'ethereum', address: eth, units: 27_400_317 })).toBe(
      `ethereum:0xdAC17F958D2ee523a2206206994597C13D831ec7@1/transfer?address=${eth}&uint256=27400317`,
    );
    expect(paymentQrValue({ network: 'tron', address: 'TXyz', units: 1 })).toBe('TXyz');
  });
});

describe('limits and flags', () => {
  const base = { network: 'tron' as const, usedDay: 0, used30d: 0, balance: 0 };
  it('T1: 500–30,000 per transaction, 30,000 a day, 50,000 in 30 days', () => {
    expect(limitProblems({ ...base, tier: 'T1', thb: 100_000 })).toEqual([]);
    expect(limitProblems({ ...base, tier: 'T1', thb: 40_000 })).toContain('below_minimum');
    expect(limitProblems({ ...base, tier: 'T1', thb: 3_500_000 })).toContain('per_transaction');
    expect(limitProblems({ ...base, tier: 'T1', thb: 1_000_000, usedDay: 2_500_000 })).toEqual([
      'per_day',
    ]);
    expect(limitProblems({ ...base, tier: 'T1', thb: 1_000_000, used30d: 4_500_000 })).toEqual([
      'per_30_days',
    ]);
  });
  it('Ethereum needs at least 1,000 baht; the balance cap is 100,000', () => {
    expect(limitProblems({ ...base, network: 'ethereum', tier: 'T1', thb: 60_000 })).toContain(
      'below_minimum',
    );
    expect(limitProblems({ ...base, tier: 'T2', thb: 1_000_000, balance: 9_500_000 })).toContain(
      'balance_cap',
    );
  });
  it('T2 allows up to 100,000 per transaction', () => {
    expect(limitProblems({ ...base, tier: 'T2', thb: 10_000_000 })).toEqual([]);
  });
  it('raises the review flags', () => {
    expect(
      cryptoFlags({
        topups24h: 4,
        nearLimitTopups30d: 2,
        customersOnThisAddress: 2,
        addresses30d: 4,
      }),
    ).toEqual(['many_topups_24h', 'near_limit_repeated', 'address_shared', 'many_addresses_30d']);
    expect(
      cryptoFlags({
        topups24h: 3,
        nearLimitTopups30d: 1,
        customersOnThisAddress: 1,
        addresses30d: 3,
      }),
    ).toEqual([]);
  });
});

describe('address checksums', () => {
  const hex = (u: Uint8Array) => [...u].map((b) => b.toString(16).padStart(2, '0')).join('');
  it('sha256 matches the standard test vectors', () => {
    expect(hex(sha256(new TextEncoder().encode('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(hex(sha256(new Uint8Array(0)))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(hex(sha256(new TextEncoder().encode('a'.repeat(1000))))).toBe(
      '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3',
    );
  });
  it('accepts the real USDT contract address and rejects a one-character typo', () => {
    expect(tronAddressValid('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')).toBe(true);
    expect(tronAddressValid('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u')).toBe(false);
    expect(tronAddressValid('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6')).toBe(false);
    expect(cryptoAddressValid('ethereum', '0xdAC17F958D2ee523a2206206994597C13D831ec7')).toBe(true);
    expect(cryptoAddressValid('tron', '0xdAC17F958D2ee523a2206206994597C13D831ec7')).toBe(false);
  });
});
