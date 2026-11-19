import { describe, expect, it } from 'vitest';
import {
  consumption,
  dishCost,
  formatPctX10,
  isLow,
  lineCost,
  margin,
  parseQty,
  parseRecipeLines,
  parseStockItems,
  priceBeforeVat,
  splitQty,
} from './stock';

describe('quantities', () => {
  it('shows grams as kg from 1,000 and keeps small ones', () => {
    expect(splitQty(1500, 'g')).toEqual({ value: '1.5', unit: 'kg' });
    expect(splitQty(250, 'g')).toEqual({ value: '250', unit: 'g' });
    expect(splitQty(-1200, 'g')).toEqual({ value: '-1.2', unit: 'kg' });
    expect(splitQty(2000, 'ml')).toEqual({ value: '2', unit: 'l' });
    expect(splitQty(1000, 'pcs')).toEqual({ value: '1000', unit: 'pcs' });
  });
  it('reads typed quantities as whole base units', () => {
    expect(parseQty('1.5', 'kg')).toBe(1500);
    expect(parseQty('1,25', 'l')).toBe(1250);
    expect(parseQty('250', 'g')).toBe(250);
    expect(parseQty('12', 'pcs')).toBe(12);
    expect(parseQty('-30', 'g')).toBe(-30);
    expect(parseQty('1.5', 'g')).toBeNull(); // no half grams
    expect(parseQty('0.0005', 'kg')).toBeNull();
    expect(parseQty('abc', 'g')).toBeNull();
    expect(parseQty('', 'g')).toBeNull();
  });
});

describe('cost and margin', () => {
  it('a line costs its share of the cost per 1,000', () => {
    expect(lineCost(150, 4000)).toBe(600); // 150 g at 40.00/kg = 6.00
    expect(lineCost(1, 3500)).toBe(4); // 3.5 satang rounds to 4
  });
  it('one portion is the sum of its ingredients; an unknown ingredient is flagged', () => {
    const items = [
      { id: 'a', costPer1000: 4000 },
      { id: 'b', costPer1000: 12000 },
    ];
    expect(
      dishCost(
        [
          { itemId: 'a', quantity: 150 },
          { itemId: 'b', quantity: 50 },
          { itemId: 'zz', quantity: 10 },
        ],
        items,
      ),
    ).toEqual({ cost: 600 + 600, missing: ['zz'] });
  });
  it('margin is on the price without VAT, by integer maths', () => {
    expect(priceBeforeVat(10700, 700, true)).toBe(10000);
    expect(priceBeforeVat(10700, 700, false)).toBe(10700);
    expect(margin(10000, 3300)).toEqual({ profit: 6700, pctX10: 670 });
    expect(formatPctX10(670)).toBe('67.0');
    expect(formatPctX10(-55)).toBe('-5.5');
    expect(margin(0, 100)).toBeNull();
  });
});

describe('stock levels and consumption', () => {
  it('low means at or under a level that was set', () => {
    expect(isLow({ quantity: 900, lowAt: 1000, active: true })).toBe(true);
    expect(isLow({ quantity: 1000, lowAt: 1000, active: true })).toBe(true);
    expect(isLow({ quantity: 1001, lowAt: 1000, active: true })).toBe(false);
    expect(isLow({ quantity: 0, lowAt: 0, active: true })).toBe(false);
    expect(isLow({ quantity: 0, lowAt: 100, active: false })).toBe(false);
  });
  it('sold lines use up their recipes (the same sums as the database)', () => {
    const recipes = [
      { menuItemId: 'pad', itemId: 'noodle', quantity: 150 },
      { menuItemId: 'pad', itemId: 'egg', quantity: 1 },
      { menuItemId: 'tea', itemId: 'leaf', quantity: 5 },
    ];
    const use = consumption(
      [
        { menuItemId: 'pad', quantity: 2 },
        { menuItemId: 'pad', quantity: 1 },
        { menuItemId: null, quantity: 9 },
        { menuItemId: 'water', quantity: 4 },
      ],
      recipes,
    );
    expect(Object.fromEntries(use)).toEqual({ noodle: 450, egg: 3 });
  });
});

describe('reading rows', () => {
  it('keeps good rows only', () => {
    const items = parseStockItems([
      {
        id: 'a',
        name: { th: 'แป้ง', en: 'Flour' },
        unit: 'g',
        quantity: '1200',
        cost_per_1000: 4000,
        low_at: 500,
      },
      { id: 'b', name: { th: 'x' }, unit: 'oz' },
      { id: 'c', name: {}, unit: 'g' },
      'nope',
    ]);
    expect(items).toEqual([
      {
        id: 'a',
        name: { th: 'แป้ง', en: 'Flour' },
        unit: 'g',
        quantity: 1200,
        costPer1000: 4000,
        lowAt: 500,
        active: true,
      },
    ]);
    expect(
      parseRecipeLines([
        { menu_item_id: 'm', item_id: 'a', quantity: 150 },
        { menu_item_id: 'm', item_id: 'b', quantity: 0 },
      ]),
    ).toEqual([{ menuItemId: 'm', itemId: 'a', quantity: 150 }]);
  });
});
