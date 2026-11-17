import type { ModuleId } from './modules/registry';

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

export const isBusinessProfile = (v: unknown): v is BusinessProfile =>
  typeof v === 'string' && (BUSINESS_PROFILES as readonly string[]).includes(v);

export type HomeScreen =
  'floor-plan' | 'product-grid' | 'calendar' | 'outlets' | 'barcode' | 'slots';
export type SellUnit = 'dish' | 'item' | 'service' | 'night' | 'sku' | 'seat';

/**
 * A preset = what a profile pre-selects at signup. The module list is NOT stored here: it is derived
 * from the registry's `defaultProfiles` so the toggle matrix has exactly one source of truth.
 */
export type ProfilePreset = {
  id: BusinessProfile;
  homeScreen: HomeScreen;
  sellUnit: SellUnit;
  /** Default service charge in bps (0 = none). */
  serviceChargeBps: number;
  /** Shelf prices include VAT in Thai retail/F&B almost everywhere. */
  priceMode: 'inclusive' | 'exclusive';
  /** Default nav order for the role home (module ids it highlights first). */
  highlight: readonly ModuleId[];
};

export const PROFILE_PRESETS: Readonly<Record<BusinessProfile, ProfilePreset>> = {
  restaurant: {
    id: 'restaurant',
    homeScreen: 'floor-plan',
    sellUnit: 'dish',
    serviceChargeBps: 1000,
    priceMode: 'inclusive',
    highlight: ['tables.floorplan', 'kds', 'bill.split'],
  },
  cafe: {
    id: 'cafe',
    homeScreen: 'product-grid',
    sellUnit: 'item',
    serviceChargeBps: 0,
    priceMode: 'inclusive',
    highlight: ['queue.call', 'kds'],
  },
  salon: {
    id: 'salon',
    homeScreen: 'calendar',
    sellUnit: 'service',
    serviceChargeBps: 0,
    priceMode: 'inclusive',
    highlight: ['appointments', 'commission'],
  },
  spa: {
    id: 'spa',
    homeScreen: 'calendar',
    sellUnit: 'service',
    serviceChargeBps: 0,
    priceMode: 'inclusive',
    highlight: ['appointments', 'resources', 'packages'],
  },
  resort: {
    id: 'resort',
    homeScreen: 'outlets',
    sellUnit: 'night',
    serviceChargeBps: 1000,
    priceMode: 'inclusive',
    highlight: ['folio', 'tables.floorplan'],
  },
  retail: {
    id: 'retail',
    homeScreen: 'barcode',
    sellUnit: 'sku',
    serviceChargeBps: 0,
    priceMode: 'inclusive',
    highlight: ['stock'],
  },
  tours: {
    id: 'tours',
    homeScreen: 'slots',
    sellUnit: 'seat',
    serviceChargeBps: 0,
    priceMode: 'inclusive',
    highlight: ['slots.booking', 'deposits'],
  },
};
