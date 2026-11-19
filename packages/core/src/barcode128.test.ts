import { describe, expect, it } from 'vitest';
import { barRuns, code128B, code128BOk } from './barcode128';

// vectors produced by the JsBarcode reference encoder (CODE128B)
const VECTORS: Record<string, string> = {
  A: '1101001000010100011000100010110001100011101011',
  'TEE-0001':
    '110100100001101110001010001101000100011010001001101110010011101100100111011001001110110010011100110101111000101100011101011',
  'PAD-0001':
    '110100100001110111011010100011000101100010001001101110010011101100100111011001001110110010011100110100101111001100011101011',
  '885000111222':
    '11010010000111010011001110100110011011100100100111011001001110110010011101100100111001101001110011010011100110110011100101100111001011001110010110100010001100011101011',
  'Hello, World':
    '11010010000110001010001011001000011001010000110010100001000111101010110011100110110011001110100011010001111010100100111101100101000010000100110101001100001100011101011',
  'a-b_c':
    '110100100001001011000010011011100100100001101010011000010000101100110111011101100011101011',
};

describe('Code 128 B', () => {
  it('matches the reference encoder bit for bit', () => {
    for (const [text, modules] of Object.entries(VECTORS)) expect(code128B(text)).toBe(modules);
  });
  it('every symbol is 11 modules (the stop is 13) and a symbol never has more than 4 modules in a row', () => {
    const m = code128B('WATER-0600');
    expect((m.length - 2) % 11).toBe(0);
    expect(m.endsWith('1100011101011')).toBe(true);
    expect(m).not.toMatch(/1{5}|0{5}/);
  });
  it('starts with the start-B symbol and the quiet part is not part of the string', () => {
    expect(code128B('X').startsWith('11010010000')).toBe(true);
    expect(code128B('X')[0]).toBe('1');
  });
  it('refuses what it cannot carry', () => {
    expect(code128BOk('PAD-0001')).toBe(true);
    expect(code128BOk('ผัด')).toBe(false);
    expect(code128BOk('')).toBe(false);
    expect(() => code128B('ผัด')).toThrow(RangeError);
  });
});

describe('barRuns', () => {
  it('turns modules into bar rectangles', () => {
    expect(barRuns('1101001')).toEqual([
      { x: 0, w: 2 },
      { x: 3, w: 1 },
      { x: 6, w: 1 },
    ]);
    expect(barRuns('000')).toEqual([]);
    const runs = barRuns(code128B('A'));
    expect(runs.reduce((n, r) => n + r.w, 0)).toBe(
      [...code128B('A')].filter((c) => c === '1').length,
    );
  });
});
