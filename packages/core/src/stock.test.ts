import { describe, expect, it } from 'vitest';
import {
  consumption,
  dishCost,
  formatPctX10,
  isLow,
  lineCost,
  margin,
  normalizeBarcode,
  parseOptionUse,
  parseQty,
  parseRecipeLines,
  parseStockItems,
  priceBeforeVat,
  stockValue,
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
        barcode: null,
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

describe('options that use stock', () => {
  const recipes = [
    { menuItemId: 'latte', itemId: 'milk', quantity: 150 },
    { menuItemId: 'latte', itemId: 'beans', quantity: 18 },
  ];
  const uses = [
    { optionId: 'oat', itemId: 'oatmilk', quantity: 150, insteadOf: 'milk' },
    { optionId: 'shot', itemId: 'beans', quantity: 9, insteadOf: null },
  ];
  it('an option can stand in for a recipe ingredient (oat milk instead of milk)', () => {
    const c = consumption(
      [{ menuItemId: 'latte', quantity: 2, optionIds: ['oat'] }],
      recipes,
      uses,
    );
    expect(c.get('oatmilk')).toBe(300);
    expect(c.has('milk')).toBe(false);
    expect(c.get('beans')).toBe(36);
  });
  it('an extra shot adds to the recipe; no option changes nothing', () => {
    const c = consumption(
      [{ menuItemId: 'latte', quantity: 1, optionIds: ['shot'] }],
      recipes,
      uses,
    );
    expect(c.get('beans')).toBe(27);
    expect(c.get('milk')).toBe(150);
    expect(consumption([{ menuItemId: 'latte', quantity: 1 }], recipes, uses).get('milk')).toBe(
      150,
    );
  });
  it('options of other dishes are not touched, and options never use stock without a link', () => {
    const c = consumption([{ menuItemId: 'tea', quantity: 1, optionIds: ['oat'] }], recipes, uses);
    expect(c.get('oatmilk')).toBe(150);
    expect(
      consumption(
        [{ menuItemId: 'latte', quantity: 1, optionIds: ['unknown'] }],
        recipes,
        uses,
      ).get('oatmilk'),
    ).toBeUndefined();
  });
  it('parses links and drops broken rows', () => {
    expect(
      parseOptionUse([
        { option_id: 'a', item_id: 'b', quantity: '150', instead_of: 'c' },
        { option_id: 'a', item_id: 'b', quantity: 0 },
        { nope: 1 },
      ]),
    ).toEqual([{ optionId: 'a', itemId: 'b', quantity: 150, insteadOf: 'c' }]);
  });
});

describe('stock value and barcodes', () => {
  it('values stock at cost and counts a negative item as nothing', () => {
    expect(
      stockValue([
        { quantity: 2000, costPer1000: 3500 },
        { quantity: -500, costPer1000: 9000 },
        { quantity: 500, costPer1000: 9000 },
      ]),
    ).toBe(7000 + 4500);
  });
  it('accepts only what the database accepts as a barcode', () => {
    expect(normalizeBarcode(' 8851234567890 ')).toBe('8851234567890');
    expect(normalizeBarcode('AB-12')).toBe('AB-12');
    expect(normalizeBarcode('123')).toBeNull();
    expect(normalizeBarcode('12 34')).toBeNull();
    expect(normalizeBarcode('รหัส1234')).toBeNull();
  });
});
