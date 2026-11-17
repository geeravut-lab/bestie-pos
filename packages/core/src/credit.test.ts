import { describe, expect, it } from 'vitest';
import {
  CreditScopeError,
  assertCreditUsable,
  canRefundCreditToCash,
  creditUsableAtStore,
} from './credit';

describe('Bestie Credit legal guards', () => {
  it('is usable only inside the issuing legal entity', () => {
    expect(creditUsableAtStore('entity-a', 'entity-a')).toBe(true);
    expect(creditUsableAtStore('entity-a', 'entity-b')).toBe(false);
    expect(creditUsableAtStore('', '')).toBe(false);
    expect(() => assertCreditUsable('entity-a', 'entity-b')).toThrow(CreditScopeError);
  });

  it('crypto-funded Credit can never be refunded to cash', () => {
    expect(canRefundCreditToCash('crypto')).toBe(false);
    expect(canRefundCreditToCash('cash')).toBe(true);
    expect(canRefundCreditToCash('promptpay')).toBe(true);
  });
});
