import { describe, expect, it } from 'vitest';
import { cleanScan, duplicateCodes, parseCode, parseSku, resolveScan } from './barcode';

const menu = {
  items: [
    { id: 'tee', barcode: 'TEE-001', available: true, modifier_group_ids: ['size'] },
    { id: 'cap', barcode: '885000111222', available: true, modifier_group_ids: [] },
    { id: 'old', barcode: 'OLD-1234', available: false, modifier_group_ids: [] },
    { id: 'hat', barcode: null, available: true, modifier_group_ids: ['colour'] },
    { id: 'mug', barcode: null, available: true, modifier_group_ids: ['colour'] },
    { id: 'sold', barcode: null, available: false, modifier_group_ids: ['solo'] },
  ],
  opts: [
    { id: 'tee-l', group_id: 'size', barcode: 'TEE-L-002', active: true },
    { id: 'red', group_id: 'colour', barcode: 'RED-0001', active: true },
    { id: 'solo-x', group_id: 'solo', barcode: 'SOLO-0001', active: true },
    { id: 'gone', group_id: 'size', barcode: 'GONE-0001', active: false },
    { id: 'orphan', group_id: 'nobody', barcode: 'ORPH-0001', active: true },
  ],
};

describe('what a scanner types', () => {
  it('drops the Enter key and spaces', () => {
    expect(cleanScan(' 885000111222\r\n')).toBe('885000111222');
    expect(cleanScan('A\u0000B')).toBe('AB');
  });
  it('an empty code is nothing, a bad one is refused, a good one is kept', () => {
    expect(parseCode('  ')).toBeNull();
    expect(parseCode('ab')).toBe('bad');
    expect(parseCode('has space 1')).toBe('bad');
    expect(parseCode(' TEE-001 ')).toBe('TEE-001');
  });
});

describe('SKU', () => {
  it('may be short, never has spaces', () => {
    expect(parseSku('PAD')).toBe('PAD');
    expect(parseSku('')).toBeNull();
    expect(parseSku('a b')).toBe('bad');
  });
});

describe('finding what a code sells', () => {
  it('an item barcode finds the item (any letter case)', () => {
    expect(resolveScan(menu, '885000111222')).toEqual({
      kind: 'found',
      itemId: 'cap',
      optionId: null,
    });
    expect(resolveScan(menu, 'tee-001\r')).toEqual({
      kind: 'found',
      itemId: 'tee',
      optionId: null,
    });
  });
  it('a variant barcode finds its one item and the option', () => {
    expect(resolveScan(menu, 'TEE-L-002')).toEqual({
      kind: 'found',
      itemId: 'tee',
      optionId: 'tee-l',
    });
  });
  it('a variant code that several dishes offer is ambiguous', () => {
    expect(resolveScan(menu, 'RED-0001')).toEqual({ kind: 'ambiguous' });
  });
  it('a sold-out item is reported, not added', () => {
    expect(resolveScan(menu, 'OLD-1234')).toEqual({ kind: 'sold_out', itemId: 'old' });
    expect(resolveScan(menu, 'SOLO-0001')).toEqual({ kind: 'sold_out', itemId: 'sold' });
  });
  it('unknown, switched-off, orphan and malformed codes find nothing', () => {
    for (const c of ['NOPE-9999', 'GONE-0001', 'ORPH-0001', 'ab', '', '%%%%%%']) {
      expect(resolveScan(menu, c)).toEqual({ kind: 'not_found' });
    }
  });
});

describe('duplicates', () => {
  it('finds a code used twice, ignoring letter case and empty ones', () => {
    const d = duplicateCodes([
      { barcode: 'ABC-1234' },
      { barcode: 'abc-1234' },
      { barcode: null },
      { barcode: 'XYZ-9999' },
    ]);
    expect([...d]).toEqual(['abc-1234']);
  });
});
