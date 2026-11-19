import { describe, expect, it } from 'vitest';
import { BUSINESS_PROFILES } from '../profiles';
import {
  MODULES,
  MODULE_IDS,
  MODULE_BY_ID,
  dependencyClosure,
  dependentClosure,
  dependentsOf,
  validateRegistry,
} from './registry';

describe('module registry', () => {
  it('is internally consistent (known ids, no cycles, one entry per id)', () => {
    expect(validateRegistry()).toEqual([]);
    expect(MODULES.map((m) => m.id).sort()).toEqual([...MODULE_IDS].sort());
  });

  it('detects cycles and unknown dependencies', () => {
    const bad = [
      { ...MODULE_BY_ID.kds, dependsOn: ['stock' as const] },
      { ...MODULE_BY_ID.stock, dependsOn: ['kds' as const] },
    ];
    expect(validateRegistry(bad).some((p) => p.includes('cycle'))).toBe(true);
  });

  it('only references real business profiles', () => {
    for (const m of MODULES)
      for (const p of m.defaultProfiles) expect(BUSINESS_PROFILES).toContain(p);
  });

  it('crypto top-up is never on by default and is legally gated (CLAUDE.md rule 3)', () => {
    const m = MODULE_BY_ID['credit.topup.crypto'];
    expect(m.defaultProfiles).toEqual([]);
    expect(m.legalGate).toBe('cryptoTopup');
    expect(m.dependsOn).toContain('tender.credit');
  });

  it('follows the PRODUCT_SPEC toggle matrix for the Phase 1 profiles', () => {
    const on = (p: (typeof BUSINESS_PROFILES)[number]) =>
      MODULES.filter((m) => m.defaultProfiles.includes(p)).map((m) => m.id);
    expect(on('restaurant')).toEqual(
      expect.arrayContaining([
        'tables.floorplan',
        'bill.split',
        'kds',
        'order.qr',
        'service.charge',
        'recipe.cost',
        'loyalty.network',
      ]),
    );
    expect(on('restaurant')).not.toContain('queue.call'); // ○
    expect(on('cafe')).toEqual(
      expect.arrayContaining(['queue.call', 'kds', 'recipe.cost', 'loyalty.network']),
    );
    expect(on('cafe')).not.toContain('tables.floorplan');
    expect(on('cafe')).not.toContain('service.charge');
  });

  it('computes dependency closures', () => {
    expect(dependencyClosure('pms').sort()).toEqual(['folio', 'pms']);
    expect(dependencyClosure('credit.topup.crypto').sort()).toEqual([
      'credit.topup.crypto',
      'tender.credit',
    ]);
    expect(dependentsOf('appointments').sort()).toEqual([
      'booking.online',
      'deposits',
      'resources',
    ]);
    expect(dependentClosure('stock').sort()).toEqual(['recipe.cost', 'stock']);
  });
});
