import { describe, expect, it } from 'vitest';
import { applyRounding, roundingFor } from './rounding';

describe('applyRounding', () => {
  it('none keeps the amount', () => {
    expect(applyRounding(12345, 'none')).toEqual({ rounded: 12345, adjustment: 0 });
  });

  it('nearest-25 satang rounds half-up', () => {
    expect(applyRounding(10012, 'nearest-25')).toEqual({ rounded: 10000, adjustment: -12 });
    expect(applyRounding(10013, 'nearest-25')).toEqual({ rounded: 10025, adjustment: 12 });
    expect(applyRounding(10037, 'nearest-25')).toEqual({ rounded: 10025, adjustment: -12 });
    expect(applyRounding(10038, 'nearest-25')).toEqual({ rounded: 10050, adjustment: 12 });
  });

  it('nearest-baht and floor-baht', () => {
    expect(applyRounding(10050, 'nearest-baht').rounded).toBe(10100);
    expect(applyRounding(10049, 'nearest-baht').rounded).toBe(10000);
    expect(applyRounding(10099, 'floor-baht')).toEqual({ rounded: 10000, adjustment: -99 });
  });

  it('adjustment always equals rounded − total', () => {
    for (const rule of ['nearest-25', 'nearest-50', 'nearest-baht', 'floor-baht'] as const) {
      for (let t = 0; t < 500; t += 7) {
        const { rounded, adjustment } = applyRounding(t, rule);
        expect(rounded - t).toBe(adjustment);
      }
    }
  });
});

describe('roundingFor', () => {
  it('uses the store config per tender, defaulting to exact', () => {
    expect(roundingFor('cash', { cash: 'nearest-25' })).toBe('nearest-25');
    expect(roundingFor('promptpay', { cash: 'nearest-25' })).toBe('none');
  });
});
