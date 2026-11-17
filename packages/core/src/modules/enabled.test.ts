import { describe, expect, it } from 'vitest';
import { PHASE1_PROFILES, PROFILE_PRESETS } from '../profiles';
import {
  defaultModulesFor,
  enabledModules,
  isEnabled,
  normalizeOverrides,
  toggleModule,
} from './enabled';
import type { StoreModuleConfig } from './enabled';

const store = (over: Partial<StoreModuleConfig> = {}): StoreModuleConfig => ({
  profile: 'restaurant',
  plan: 'pro',
  moduleOverrides: {},
  legalSignOff: { cryptoTopup: false },
  ...over,
});

describe('isEnabled — store level', () => {
  it('uses profile defaults when nothing is overridden', () => {
    expect(isEnabled(store(), 'tables.floorplan')).toBe(true);
    expect(isEnabled(store(), 'queue.call')).toBe(false);
    expect(isEnabled(store({ profile: 'cafe' }), 'queue.call')).toBe(true);
  });

  it('honours explicit overrides both ways', () => {
    expect(isEnabled(store({ moduleOverrides: { 'queue.call': true } }), 'queue.call')).toBe(true);
    expect(
      isEnabled(store({ moduleOverrides: { 'tables.floorplan': false } }), 'tables.floorplan'),
    ).toBe(false);
  });

  it('requires the plan tier', () => {
    expect(isEnabled(store({ plan: 'basic' }), 'kds')).toBe(false); // KDS = Pro
    expect(isEnabled(store({ plan: 'pro' }), 'kds')).toBe(true);
    expect(isEnabled(store({ plan: 'pro', profile: 'resort' }), 'folio')).toBe(false); // Resort plan
    expect(isEnabled(store({ plan: 'resort', profile: 'resort' }), 'folio')).toBe(true);
  });

  it('is off when a dependency is off (even if the module itself is chosen)', () => {
    const s = store({ moduleOverrides: { stock: false, 'recipe.cost': true } });
    expect(isEnabled(s, 'recipe.cost')).toBe(false);
  });
});

describe('isEnabled — crypto top-up legal gate', () => {
  const wanted = { 'tender.credit': true, 'credit.topup.crypto': true } as const;

  it('stays off without legal sign-off, whatever the owner toggles', () => {
    expect(isEnabled(store({ moduleOverrides: wanted }), 'credit.topup.crypto')).toBe(false);
    expect(isEnabled(store({ moduleOverrides: wanted }), 'tender.credit')).toBe(true);
  });

  it('turns on only with sign-off', () => {
    expect(
      isEnabled(
        store({ moduleOverrides: wanted, legalSignOff: { cryptoTopup: true } }),
        'credit.topup.crypto',
      ),
    ).toBe(true);
  });

  it('toggleModule refuses to enable it without sign-off', () => {
    expect(toggleModule(store(), 'credit.topup.crypto', true)).toEqual({
      ok: false,
      reason: 'legal',
      module: 'credit.topup.crypto',
    });
  });
});

describe('isEnabled — device and role level', () => {
  it('device allow-list narrows what a tablet shows', () => {
    const bar = { moduleAllowList: ['kds' as const] };
    expect(isEnabled(store(), 'kds', bar)).toBe(true);
    expect(isEnabled(store(), 'tables.floorplan', bar)).toBe(false);
    expect(isEnabled(store(), 'tables.floorplan', {})).toBe(true);
  });

  it('role can hide modules, never add them', () => {
    const cashier = { hiddenModules: ['recipe.cost' as const] };
    expect(isEnabled(store(), 'recipe.cost', undefined, cashier)).toBe(false);
    expect(
      isEnabled(store({ profile: 'cafe', moduleOverrides: { kds: false } }), 'kds', undefined, {
        hiddenModules: [],
      }),
    ).toBe(false);
  });

  it('enabledModules lists the effective set', () => {
    const list = enabledModules(store({ plan: 'basic' }));
    expect(list).toContain('tables.floorplan');
    expect(list).not.toContain('kds');
  });
});

describe('toggleModule', () => {
  it('enabling auto-enables dependencies and reports them', () => {
    const r = toggleModule(store({ plan: 'resort', profile: 'resort' }), 'pms', true);
    expect(r).toMatchObject({ ok: true, overrides: { pms: true, folio: true } });
  });

  it('enabling deposits for a restaurant pulls in appointments (reservations)', () => {
    const r = toggleModule(store(), 'deposits', true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.autoEnabled).toEqual(['appointments']);
    expect(isEnabled(store({ moduleOverrides: r.overrides }), 'deposits')).toBe(true);
  });

  it('disabling warns about dependents and switches them off too', () => {
    const r = toggleModule(store(), 'stock', true);
    if (!r.ok) throw new Error('expected ok');
    const withStock = store({ moduleOverrides: r.overrides });
    const off = toggleModule(withStock, 'stock', false);
    if (!off.ok) throw new Error('expected ok');
    expect(off.autoDisabled).toEqual(['recipe.cost']); // restaurant has recipe.cost on by default
    expect(isEnabled(store({ moduleOverrides: off.overrides }), 'recipe.cost')).toBe(false);
  });

  it('refuses modules above the plan', () => {
    expect(toggleModule(store({ plan: 'basic' }), 'kds', true)).toEqual({
      ok: false,
      reason: 'plan',
      module: 'kds',
    });
  });
});

describe('profiles', () => {
  it('derive their default modules from the registry', () => {
    expect(defaultModulesFor('cafe')).toContain('queue.call');
    expect(defaultModulesFor('restaurant')).not.toContain('queue.call');
  });

  it('Phase 1 presets exist with the spec home screens', () => {
    expect(PHASE1_PROFILES).toEqual(['restaurant', 'cafe']);
    expect(PROFILE_PRESETS.restaurant).toMatchObject({
      homeScreen: 'floor-plan',
      sellUnit: 'dish',
      serviceChargeBps: 1000,
    });
    expect(PROFILE_PRESETS.cafe).toMatchObject({
      homeScreen: 'product-grid',
      sellUnit: 'item',
      serviceChargeBps: 0,
    });
  });

  it('normalizeOverrides keeps only differences from the profile default (flag-storage rule)', () => {
    expect(
      normalizeOverrides('restaurant', {
        kds: true,
        'queue.call': true,
        'tables.floorplan': false,
      }),
    ).toEqual({
      'queue.call': true,
      'tables.floorplan': false,
    });
  });
});
