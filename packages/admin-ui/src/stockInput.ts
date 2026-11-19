import { parsePriceInput } from '@bestie/core';
import type { InputUnit, StockUnit } from '@bestie/core';
import type { Dict } from '@bestie/i18n';

/** A dictionary entry by a computed key (the keys are checked by the dictionary's own tests). */
export const tx = (t: Dict, key: string): string => (t as Record<string, string>)[key] ?? key;

/** Satang per 1,000 base units from what a person types: per kg / litre, or per piece. */
export const toCost1000 = (text: string, unit: StockUnit): number | null => {
  const v = parsePriceInput(text);
  return v === null ? null : unit === 'pcs' ? v * 1000 : v;
};
export const fromCost1000 = (c: number, unit: StockUnit): number =>
  unit === 'pcs' ? Math.round(c / 1000) : c;

/** The unit a person usually types for an item: kg for grams, litres for millilitres, pieces. */
export const bigUnit = (u: StockUnit): InputUnit => (u === 'g' ? 'kg' : u === 'ml' ? 'l' : 'pcs');
