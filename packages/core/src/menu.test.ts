import { describe, expect, it } from 'vitest';
import { itemPrice, lineUnitPrice, validateSelection } from './menu';
import type { MenuItem, ModifierGroup } from './types';

const scope = { orgId: 'o', storeId: 's' };
const item: MenuItem = {
  ...scope,
  id: 'latte',
  categoryId: 'c',
  name: { th: 'x' },
  prices: { base: 6000, delivery: 7000 },
  modifierGroupIds: ['milk', 'shots'],
  available: true,
};
const groups: ModifierGroup[] = [
  {
    ...scope,
    id: 'milk',
    name: { th: 'x' },
    min: 1,
    max: 1,
    options: [
      { id: 'dairy', name: { th: 'x' }, priceDelta: 0 },
      { id: 'oat', name: { th: 'x' }, priceDelta: 1500, channelDelta: { delivery: 2000 } },
    ],
  },
  {
    ...scope,
    id: 'shots',
    name: { th: 'x' },
    min: 0,
    max: 2,
    options: [
      { id: 's1', name: { th: 'x' }, priceDelta: 1000 },
      { id: 's2', name: { th: 'x' }, priceDelta: 1000 },
      { id: 's3', name: { th: 'x' }, priceDelta: 1000 },
    ],
  },
];

describe('menu pricing', () => {
  it('falls back to the base price when a channel has no price', () => {
    expect(itemPrice(item, 'dine-in')).toBe(6000);
    expect(itemPrice(item, 'delivery')).toBe(7000);
  });

  it('adds modifier deltas, honouring per-option channel pricing', () => {
    expect(lineUnitPrice(item, groups, ['oat', 's1'], 'dine-in')).toBe(8500);
    expect(lineUnitPrice(item, groups, ['oat'], 'delivery')).toBe(9000);
  });

  it('enforces min/max per group', () => {
    expect(validateSelection(groups, ['dairy'])).toEqual([]);
    expect(validateSelection(groups, [])).toEqual([{ groupId: 'milk', problem: 'too_few' }]);
    expect(validateSelection(groups, ['dairy', 'oat'])).toEqual([
      { groupId: 'milk', problem: 'too_many' },
    ]);
    expect(validateSelection(groups, ['dairy', 's1', 's2', 's3'])).toEqual([
      { groupId: 'shots', problem: 'too_many' },
    ]);
    expect(validateSelection(groups, ['dairy', 'ghost'])[0]?.problem).toBe('unknown_option');
  });

  it('never yields a negative price', () => {
    const cheap: MenuItem = { ...item, prices: { base: 500 } };
    const g: ModifierGroup = {
      ...groups[0]!,
      options: [{ id: 'd', name: { th: 'x' }, priceDelta: -900 }],
    };
    expect(() => lineUnitPrice(cheap, [g], ['d'], 'dine-in')).toThrow();
  });
});
