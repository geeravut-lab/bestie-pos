import { describe, expect, it } from 'vitest';
import {
  MoneyError,
  allocate,
  assertSatang,
  baht,
  formatTHB,
  mulBps,
  parseBaht,
  splitEvenly,
  sum,
} from './money';

describe('parseBaht / baht', () => {
  it('parses human input exactly', () => {
    expect(parseBaht('125')).toBe(12500);
    expect(parseBaht('125.5')).toBe(12550);
    expect(parseBaht('1,250.05')).toBe(125005);
    expect(parseBaht('0.1')).toBe(10);
    expect(baht(30)).toBe(3000);
  });

  it('rejects anything that is not a plain amount with ≤ 2 decimals', () => {
    for (const bad of ['', 'abc', '1.234', '-5', '1e3', '1.', '.5', '١٢٣']) {
      expect(() => parseBaht(bad), bad).toThrow(MoneyError);
    }
    expect(() => baht(1.5)).toThrow(MoneyError);
  });
});

describe('assertSatang', () => {
  it('only accepts safe integers', () => {
    expect(() => assertSatang(10)).not.toThrow();
    for (const bad of [0.5, NaN, Infinity, '10', null, 2 ** 60])
      expect(() => assertSatang(bad)).toThrow(MoneyError);
  });
});

describe('mulBps', () => {
  it('rounds half-up by default and supports floor/ceil', () => {
    expect(mulBps(1050, 1000)).toBe(105); // 10 %
    expect(mulBps(1005, 1000)).toBe(101); // 100.5 → 101
    expect(mulBps(1005, 1000, 'floor')).toBe(100);
    expect(mulBps(1001, 1000, 'ceil')).toBe(101);
    expect(mulBps(0, 700)).toBe(0);
  });

  it('refuses negatives and non-integers', () => {
    expect(() => mulBps(-1, 100)).toThrow(MoneyError);
    expect(() => mulBps(100, 1.5)).toThrow(MoneyError);
  });
});

describe('allocate / splitEvenly', () => {
  it('always adds up exactly to the total', () => {
    for (const total of [0, 1, 7, 100, 9999, 123457]) {
      for (const n of [1, 2, 3, 4, 7, 11]) {
        const parts = splitEvenly(total, n);
        expect(parts).toHaveLength(n);
        expect(sum(parts)).toBe(total);
        expect(Math.max(...parts) - Math.min(...parts)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('splits by weights (e.g. by seat / item share) and stays deterministic', () => {
    expect(allocate(1000, [1, 1, 1])).toEqual([334, 333, 333]);
    expect(allocate(1000, [3, 1])).toEqual([750, 250]);
    expect(allocate(1000, [0, 5])).toEqual([0, 1000]);
    expect(sum(allocate(99999, [17, 3, 29, 1]))).toBe(99999);
  });

  it('rejects empty / all-zero / negative weights', () => {
    expect(() => allocate(100, [])).toThrow(MoneyError);
    expect(() => allocate(100, [0, 0])).toThrow(MoneyError);
    expect(() => allocate(100, [1, -1])).toThrow(MoneyError);
  });
});

describe('formatTHB', () => {
  it('formats satang for display', () => {
    expect(formatTHB(12550, 'en-GB')).toContain('125.50');
    expect(formatTHB(12500, 'en-GB')).toContain('125');
    expect(formatTHB(12500, 'en-GB')).not.toContain('.00');
    expect(formatTHB(-5, 'en-GB')).toMatch(/^-/);
    expect(formatTHB(123456700, 'en-GB', { symbol: false })).toBe('1,234,567');
  });
});
