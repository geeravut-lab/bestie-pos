import { describe, expect, it } from 'vitest';
import { MODULE_IDS } from '@bestie/core';
import type { StoreModuleConfig } from '@bestie/core';
import { dict } from '@bestie/i18n';
import {
  APP_ROLES,
  ART_IDS,
  NAV_BY_ID,
  NAV_ITEMS,
  PLATFORM_CARDS,
  ROLE_LAYOUT,
  activeNavId,
  disabledNavIds,
  layoutFor,
  moreItems,
  navItemEnabled,
  roleLabelKey,
  ungatePlatform,
} from './nav';
import type { ArtId } from './nav';

const store = (over: Partial<StoreModuleConfig> = {}): StoreModuleConfig => ({
  profile: 'cafe',
  plan: 'pro',
  moduleOverrides: {},
  legalSignOff: { cryptoTopup: false },
  ...over,
});

describe('nav list', () => {
  it('has exactly one item per art id and unique paths', () => {
    expect(NAV_ITEMS.map((n) => n.id).sort()).toEqual([...ART_IDS].sort());
    expect(new Set(NAV_ITEMS.map((n) => n.path)).size).toBe(NAV_ITEMS.length);
  });

  it('every label and hint exists in BOTH languages', () => {
    for (const lang of ['th', 'en'] as const) {
      for (const n of NAV_ITEMS) {
        expect(dict[lang][n.label], `${lang}.${n.label}`).toBeTruthy();
        if (n.hint) expect(dict[lang][n.hint], `${lang}.${n.hint}`).toBeTruthy();
      }
      for (const r of APP_ROLES)
        expect(dict[lang][roleLabelKey(r)], `${lang}.${roleLabelKey(r)}`).toBeTruthy();
    }
  });

  it('only references real modules', () => {
    for (const n of NAV_ITEMS) for (const m of n.anyModule ?? []) expect(MODULE_IDS).toContain(m);
  });

  it('every role layout points at real items and has a hint for each card', () => {
    for (const role of APP_ROLES) {
      const l = ROLE_LAYOUT[role];
      for (const id of [...l.cards, ...l.tabs, ...(l.center ? [l.center] : [])])
        expect(NAV_BY_ID[id], `${role}:${id}`).toBeDefined();
      for (const id of l.cards)
        expect(NAV_BY_ID[id].hint, `${role}:${id} needs a hint`).toBeTruthy();
    }
  });
});

describe('module gating', () => {
  it('greys out items whose module is off, keeps always-on items', () => {
    const grey = disabledNavIds({ store: store() }); // cafe: no floor plan, no stock, no AI
    expect(grey.has('tables')).toBe(true);
    expect(grey.has('stock')).toBe(true);
    expect(grey.has('credit')).toBe(true); // Credit is opt-in
    expect(grey.has('sell')).toBe(false);
    expect(grey.has('queue')).toBe(false); // cafe has queue
  });

  it('follows store overrides and device allow-lists', () => {
    expect(
      navItemEnabled(NAV_BY_ID.tables, {
        store: store({ moduleOverrides: { 'tables.floorplan': true } }),
      }),
    ).toBe(true);
    expect(
      navItemEnabled(NAV_BY_ID.queue, { store: store(), device: { moduleAllowList: ['kds'] } }),
    ).toBe(false);
  });
});

describe('activeNavId', () => {
  it('picks the longest matching path', () => {
    expect(activeNavId('/')).toBe('home');
    expect(activeNavId('/tables/12')).toBe('tables');
    expect(activeNavId('/admin/audit/settings')).toBe('audit');
    expect(activeNavId('/nope')).toBeUndefined();
  });
});

describe('moreItems', () => {
  it('lists role cards not already on the bar', () => {
    const more = moreItems('cashier');
    expect(more).not.toContain('sell'); // centre
    expect(more).not.toContain('orders'); // tab
    expect(more).toContain('shift');
  });
});

describe('a platform administrator in a shop app', () => {
  it('gets the platform pages next to the pages of the shop role', () => {
    const plain = layoutFor('owner').cards;
    expect(plain).not.toContain('branding');
    const pa = layoutFor('owner', true).cards;
    for (const id of PLATFORM_CARDS) expect(pa).toContain(id);
    expect(pa).toContain('dashboard'); // the shop role's own cards stay
    expect(new Set(pa).size).toBe(pa.length); // no card twice ('ai' was already an owner card)
    expect(moreItems('owner', true)).toContain('line');
  });
  it('never greys the platform pages because of a shop module switch', () => {
    const off = new Set<ArtId>(['ai', 'tables']);
    expect(ungatePlatform(new Set(off), true).has('ai')).toBe(false);
    expect(ungatePlatform(new Set(off), true).has('tables')).toBe(true);
    expect(ungatePlatform(new Set(off), false).has('ai')).toBe(true);
  });
});
