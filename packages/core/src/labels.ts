// Price labels and count sheets for a shop that sells things off a shelf (the Retail profile): which labels to print, how many, on what paper.
import { code128BOk } from './barcode128';
import type { LocalizedText } from './types';

export type LabelSize = {
  id: string;
  /** One label, in millimetres. */
  widthMm: number;
  heightMm: number;
  /** A4 sheets of sticky labels print in a grid; a roll printer prints one label per page (columns = 1). */
  columns: number;
  sheet: 'a4' | 'roll';
};

export const LABEL_SIZES: readonly LabelSize[] = [
  { id: 'a4-3x8', widthMm: 70, heightMm: 37, columns: 3, sheet: 'a4' },
  { id: 'a4-4x10', widthMm: 52.5, heightMm: 29.7, columns: 4, sheet: 'a4' },
  { id: 'roll-50x30', widthMm: 50, heightMm: 30, columns: 1, sheet: 'roll' },
  { id: 'roll-40x25', widthMm: 40, heightMm: 25, columns: 1, sheet: 'roll' },
];
export const labelSize = (id: string): LabelSize =>
  LABEL_SIZES.find((s) => s.id === id) ?? LABEL_SIZES[0]!;

export type LabelItem = {
  id: string;
  name: LocalizedText;
  /** Satang, as the shelf price (base channel). */
  price: number;
  barcode: string | null;
  sku: string | null;
};

/** The most labels one print run may hold (a runaway number of copies must not freeze the browser). */
export const MAX_LABELS = 600;

export type LabelPlan = { item: LabelItem; copies: number };

/** Items with a copy count > 0, in menu order, cut so the whole run stays within MAX_LABELS. */
export function planLabels(
  items: readonly LabelItem[],
  copies: Readonly<Record<string, number>>,
): LabelPlan[] {
  const out: LabelPlan[] = [];
  let left = MAX_LABELS;
  for (const item of items) {
    const n = Math.min(Math.trunc(copies[item.id] ?? 0), left);
    if (!(n > 0)) continue;
    out.push({ item, copies: n });
    left -= n;
    if (left <= 0) break;
  }
  return out;
}
export const labelCount = (plan: readonly LabelPlan[]): number =>
  plan.reduce((n, p) => n + p.copies, 0);

/** A barcode a label can print as bars (printable ASCII); anything else is printed as plain text only. */
export const printableCode = (code: string | null | undefined): string | null =>
  code && code64(code) ? code : null;
const code64 = (c: string) => c.length <= 40 && code128BOk(c);

/** Sheets needed for `labels` labels on a size: how many rows of the grid are used on the last sheet etc. are the printer's business; this is the page count. */
export function sheetCount(labels: number, size: LabelSize): number {
  if (labels <= 0) return 0;
  if (size.sheet === 'roll') return labels;
  const perPage = size.columns * Math.floor((297 - 2 * 8) / size.heightMm); // 8 mm margins top and bottom
  return Math.ceil(labels / Math.max(1, perPage));
}

// ── count sheet ──
export type CountSheetItem = {
  id: string;
  name: LocalizedText;
  unit: string;
  quantity: number;
  barcode: string | null;
};
export type CountSheetRow = {
  id: string;
  name: string;
  unit: string;
  barcode: string;
  expected: number | null;
};

/** Rows of a stock count sheet, sorted by name. A BLIND sheet leaves the expected quantity out so counters do not copy it. */
export function countSheetRows(
  items: readonly CountSheetItem[],
  opts: { blind: boolean; lang: 'th' | 'en' },
): CountSheetRow[] {
  const nameOf = (n: LocalizedText) => (opts.lang === 'en' && n.en ? n.en : n.th);
  return items
    .map((i) => ({
      id: i.id,
      name: nameOf(i.name),
      unit: i.unit,
      barcode: i.barcode ?? '',
      expected: opts.blind ? null : i.quantity,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, opts.lang === 'th' ? 'th' : 'en'));
}
