/**
 * @bestie/core — pure domain logic (no React, no I/O, no framework imports).
 *
 * Phase 1 task 1 ("Core domain") fills this package: types, satang money, VAT / service charge,
 * module registry, profile presets, points rules. For now it only pins the platform constants
 * every other package must agree on.
 */

/** Every price, bill and ledger is THB (CLAUDE.md rule 1). */
export const CURRENCY = 'THB' as const;

/** Money is integer satang — THB × 100. Never floats (CLAUDE.md, Stack → Money). */
export const SATANG_PER_BAHT = 100 as const;

/** Business Profiles a store can pick at signup (docs/PRODUCT_SPEC.md §4). */
export const BUSINESS_PROFILES = [
  'restaurant',
  'cafe',
  'salon',
  'spa',
  'resort',
  'retail',
  'tours',
] as const;

export type BusinessProfile = (typeof BUSINESS_PROFILES)[number];

/** Profiles that ship in Phase 1 (docs/PRODUCT_SPEC.md §8). */
export const PHASE1_PROFILES = ['restaurant', 'cafe'] as const satisfies readonly BusinessProfile[];
