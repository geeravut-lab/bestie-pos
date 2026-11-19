import { describe, expect, it } from 'vitest';
import {
  LABEL_SIZES,
  MAX_LABELS,
  countSheetRows,
  labelCount,
  labelSize,
  planLabels,
  printableCode,
  sheetCount,
} from './labels';

const item = (id: string, price = 10000, barcode: string | null = null) => ({
  id,
  name: { th: id },
  price,
  barcode,
  sku: null,
});

describe('planLabels', () => {
  const items = [item('a'), item('b'), item('c')];
  it('keeps items with copies > 0, in order', () => {
    const p = planLabels(items, { a: 2, c: 1, b: 0 });
    expect(p.map((x) => [x.item.id, x.copies])).toEqual([
      ['a', 2],
      ['c', 1],
    ]);
    expect(labelCount(p)).toBe(3);
  });
  it('ignores junk counts and never exceeds the cap', () => {
    expect(
      planLabels(items, { a: -3, b: Number.NaN, c: 2.9 }).map((x) => [x.item.id, x.copies]),
    ).toEqual([['c', 2]]);
    const big = planLabels(items, { a: MAX_LABELS, b: 50 });
    expect(labelCount(big)).toBe(MAX_LABELS);
    expect(big).toHaveLength(1);
  });
});

describe('sizes and sheets', () => {
  it('a size id that is unknown falls back to the first size', () => {
    expect(labelSize('nope').id).toBe(LABEL_SIZES[0]!.id);
    expect(labelSize('roll-50x30').sheet).toBe('roll');
  });
  it('a roll prints one label per page; an A4 grid holds columns x rows', () => {
    expect(sheetCount(5, labelSize('roll-50x30'))).toBe(5);
    expect(sheetCount(0, labelSize('a4-3x8'))).toBe(0);
    // 70 x 37 mm, 3 columns, 7 full rows between 8 mm margins -> 21 labels a sheet
    expect(sheetCount(21, labelSize('a4-3x8'))).toBe(1);
    expect(sheetCount(22, labelSize('a4-3x8'))).toBe(2);
  });
});

describe('printableCode', () => {
  it('prints bars for plain codes and falls back to text for the rest', () => {
    expect(printableCode('TEE-0001')).toBe('TEE-0001');
    expect(printableCode('ผัด')).toBeNull();
    expect(printableCode('')).toBeNull();
    expect(printableCode(null)).toBeNull();
    expect(printableCode('A'.repeat(41))).toBeNull();
  });
});

describe('countSheetRows', () => {
  const stock = [
    { id: '1', name: { th: 'ข้าว', en: 'Rice' }, unit: 'g', quantity: 5000, barcode: null },
    { id: '2', name: { th: 'น้ำมัน', en: 'Oil' }, unit: 'ml', quantity: -20, barcode: 'OIL-0001' },
  ];
  it('is sorted by the shown name and carries the expected quantity', () => {
    const r = countSheetRows(stock, { blind: false, lang: 'en' });
    expect(r.map((x) => x.name)).toEqual(['Oil', 'Rice']);
    expect(r[0]).toMatchObject({ expected: -20, barcode: 'OIL-0001', unit: 'ml' });
    expect(r[1]).toMatchObject({ expected: 5000, barcode: '' });
  });
  it('a blind sheet has no expected quantity; Thai names are used in Thai', () => {
    const r = countSheetRows(stock, { blind: true, lang: 'th' });
    expect(r.every((x) => x.expected === null)).toBe(true);
    expect(r.map((x) => x.name).sort()).toEqual(['ข้าว', 'น้ำมัน'].sort());
  });
});
