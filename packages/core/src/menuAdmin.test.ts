import { describe, expect, it } from 'vitest';
import {
  channelPricesToColumn,
  groupProblems,
  itemProblems,
  localizedName,
  nameProblems,
  parseChannelPrices,
  parseDeltaInput,
  parseLocalizedText,
  parsePriceInput,
  priceInputValue,
  toLocalizedText,
} from './menuAdmin';

describe('price input', () => {
  it('parses what people type, exactly', () => {
    expect(parsePriceInput('55')).toBe(5500);
    expect(parsePriceInput('55.5')).toBe(5550);
    expect(parsePriceInput('1,250.25')).toBe(125025);
    expect(parsePriceInput(' 0 ')).toBe(0);
  });
  it('refuses nonsense, negatives, 3 decimals and absurd amounts', () => {
    for (const bad of ['', 'abc', '-5', '5.123', '1e3', '2000000'])
      expect(parsePriceInput(bad), bad).toBeNull();
  });
  it('option price change may be negative; empty means no change', () => {
    expect(parseDeltaInput('-20')).toBe(-2000);
    expect(parseDeltaInput('+10.5')).toBe(1050);
    expect(parseDeltaInput('')).toBe(0);
    expect(parseDeltaInput('--5')).toBeNull();
  });
  it('round-trips satang to the edit field without float noise', () => {
    for (const s of [0, 5, 50, 5500, 5550, 5525, 123456, -2000, -250]) {
      expect(parseDeltaInput(priceInputValue(s)), String(s)).toBe(s);
    }
    expect(priceInputValue(5550)).toBe('55.5');
    expect(priceInputValue(5500)).toBe('55');
  });
});

describe('names', () => {
  it('Thai is required, English optional, both capped', () => {
    expect(nameProblems({ th: '  ' })).toEqual(['th_missing']);
    expect(nameProblems({ th: 'ผัดไทย' })).toEqual([]);
    expect(nameProblems({ th: 'x'.repeat(121) })).toEqual(['too_long']);
    expect(nameProblems({ th: 'ก', en: 'y'.repeat(121) })).toEqual(['too_long']);
  });
  it('stores trimmed text and never an empty English key', () => {
    expect(toLocalizedText(' ผัดไทย ', '  ')).toEqual({ th: 'ผัดไทย' });
    expect(toLocalizedText('ผัดไทย', ' Pad Thai ')).toEqual({ th: 'ผัดไทย', en: 'Pad Thai' });
  });
  it('reads bad rows leniently and falls back to Thai for a missing translation', () => {
    expect(parseLocalizedText(null)).toEqual({ th: '' });
    expect(parseLocalizedText([1])).toEqual({ th: '' });
    expect(parseLocalizedText({ th: 'ก', en: 7 })).toEqual({ th: 'ก' });
    expect(localizedName({ th: 'ผัดไทย' }, 'en')).toBe('ผัดไทย');
    expect(localizedName({ th: 'ผัดไทย', en: 'Pad Thai' }, 'en')).toBe('Pad Thai');
  });
});

describe('channel prices', () => {
  it('keeps only known channels with valid satang, base required', () => {
    expect(
      parseChannelPrices({ base: 5500, delivery: 6500, evil: 1, qr: -5, takeaway: 1.5 }),
    ).toEqual({
      base: 5500,
      delivery: 6500,
    });
    expect(parseChannelPrices({ delivery: 6500 })).toBeNull();
    expect(parseChannelPrices(null)).toBeNull();
    expect(parseChannelPrices([])).toBeNull();
  });
  it('stores only what differs from the base price', () => {
    expect(channelPricesToColumn({ base: 5500, qr: 5500, delivery: 6500 })).toEqual({
      base: 5500,
      delivery: 6500,
    });
  });
});

describe('items & groups', () => {
  const name = { th: 'ผัดไทย' };
  it('an item needs a name, a price, a category and a valid station', () => {
    expect(itemProblems({ name, base: 5500, categoryId: 'c', station: 'bar' })).toEqual([]);
    expect(itemProblems({ name: { th: '' }, base: null, categoryId: '', station: 'x' })).toEqual([
      'name',
      'price',
      'category',
      'station',
    ]);
  });
  it('min/max rules, and a required group needs enough options', () => {
    expect(groupProblems({ name, min: 0, max: 1, optionCount: 0 })).toEqual([]);
    expect(groupProblems({ name, min: 1, max: 1, optionCount: 3 })).toEqual([]);
    expect(groupProblems({ name, min: 1, max: 1, optionCount: 0 })).toEqual(['min_above_options']);
    expect(groupProblems({ name, min: 2, max: 1, optionCount: 3 })).toEqual(['min_above_max']);
    expect(groupProblems({ name, min: -1, max: 0, optionCount: 3 })).toEqual([
      'min_negative',
      'max_below_one',
    ]);
    expect(groupProblems({ name: { th: '' }, min: 0, max: 1, optionCount: 0 })).toEqual(['name']);
  });
});
