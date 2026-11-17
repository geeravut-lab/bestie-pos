import { describe, expect, it } from 'vitest';
import { BUSINESS_PROFILES, CURRENCY, PHASE1_PROFILES, SATANG_PER_BAHT } from './index';

describe('platform constants', () => {
  it('settles in THB with integer satang', () => {
    expect(CURRENCY).toBe('THB');
    expect(SATANG_PER_BAHT).toBe(100);
  });

  it('Phase 1 profiles are a subset of all profiles', () => {
    for (const p of PHASE1_PROFILES) expect(BUSINESS_PROFILES).toContain(p);
  });
});
