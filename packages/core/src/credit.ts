import type { Id } from './types';

/**
 * Bestie CREDIT = prepaid stored value (THB 1:1), a liability until spent. Full double-entry ledger lands in
 * Phase 1 §6; these two guards exist now because they are legal rules, not features (CLAUDE.md rule 2):
 *  - usable only at stores of the SAME legal entity that issued it (otherwise it becomes multi-merchant e-money);
 *  - never cashed out when it was funded by crypto.
 */
export function creditUsableAtStore(issuerEntityId: Id, storeLegalEntityId: Id): boolean {
  return issuerEntityId.length > 0 && issuerEntityId === storeLegalEntityId;
}

export class CreditScopeError extends Error {
  constructor() {
    super('Bestie Credit can only be spent at stores of the legal entity that issued it');
    this.name = 'CreditScopeError';
  }
}

export function assertCreditUsable(issuerEntityId: Id, storeLegalEntityId: Id): void {
  if (!creditUsableAtStore(issuerEntityId, storeLegalEntityId)) throw new CreditScopeError();
}

export type CreditFundingSource = 'cash' | 'promptpay' | 'gateway' | 'crypto';

/** A cash refund of unspent Credit is never allowed for crypto-funded Credit (would look like an exchange). */
export const canRefundCreditToCash = (source: CreditFundingSource): boolean => source !== 'crypto';
