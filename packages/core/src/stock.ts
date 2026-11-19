import type { LocalizedText } from './types';
import type { Satang } from './money';

/**
 * Stock and recipe cost, the pure part. Quantities are whole numbers in a BASE unit (grams, millilitres or pieces) so nothing is ever a
 * float; a cost is satang per 1,000 base units (per kg / litre / 1,000 pieces).
 */
export const STOCK_UNITS = ['g', 'ml', 'pcs'] as const;
export type StockUnit = (typeof STOCK_UNITS)[number];
/** What a person types / reads: grams as g or kg, millilitres as ml or l, pieces as pcs. */
export type InputUnit = 'g' | 'kg' | 'ml' | 'l' | 'pcs';
export const inputUnitsFor = (u: StockUnit): InputUnit[] =>
  u === 'g' ? ['g', 'kg'] : u === 'ml' ? ['ml', 'l'] : ['pcs'];
const FACTOR: Record<InputUnit, number> = { g: 1, kg: 1000, ml: 1, l: 1000, pcs: 1 };

export type StockItem = {
  id: string;
  name: LocalizedText;
  barcode: string | null;
  unit: StockUnit;
  quantity: number;
  costPer1000: Satang;
  lowAt: number;
  active: boolean;
};
export type RecipeLine = { menuItemId: string; itemId: string; quantity: number };

/** "1500" g → { value: "1.5", unit: "kg" }; below 1,000 stays in the base unit. */
export function splitQty(q: number, unit: StockUnit): { value: string; unit: InputUnit } {
  const big = unit === 'g' ? 'kg' : unit === 'ml' ? 'l' : null;
  if (!big || Math.abs(q) < 1000) return { value: String(q), unit };
  const sign = q < 0 ? '-' : '';
  const a = Math.abs(q);
  const whole = Math.floor(a / 1000);
  const frac = String(a % 1000)
    .padStart(3, '0')
    .replace(/0+$/, '');
  return { value: `${sign}${whole}${frac ? `.${frac}` : ''}`, unit: big };
}

/** A typed quantity ("1.5" in kg) as whole base units, or null when it is not a number with at most 3 decimals. */
export function parseQty(text: string, unit: InputUnit): number | null {
  const m = /^\s*(-?)(\d{1,9})(?:[.,](\d{1,3}))?\s*$/.exec(text);
  if (!m) return null;
  const f = FACTOR[unit];
  const frac = m[3] ?? '';
  if (frac.length > 0 && f === 1) return null; // no fractions of a gram / ml / piece
  const base = Number(m[2]) * f + (frac ? Number(frac.padEnd(3, '0')) * (f / 1000) : 0);
  if (!Number.isInteger(base) || base > 1_000_000_000) return null;
  return m[1] === '-' ? -base : base;
}

/** What `quantity` base units cost at `costPer1000` satang per 1,000, rounded to the satang. */
export const lineCost = (quantity: number, costPer1000: Satang): Satang =>
  Math.round((quantity * costPer1000) / 1000);

/** The cost of one portion: every ingredient line at the cost on hand. A dish with an unknown ingredient is flagged, not guessed. */
export function dishCost(
  lines: readonly Pick<RecipeLine, 'itemId' | 'quantity'>[],
  items: readonly Pick<StockItem, 'id' | 'costPer1000'>[],
): { cost: Satang; missing: string[] } {
  const byId = new Map(items.map((i) => [i.id, i]));
  let cost = 0;
  const missing: string[] = [];
  for (const l of lines) {
    const it = byId.get(l.itemId);
    if (!it) missing.push(l.itemId);
    else cost += lineCost(l.quantity, it.costPer1000);
  }
  return { cost, missing };
}

/** The menu price without VAT (a margin is judged on what the shop keeps). */
export const priceBeforeVat = (price: Satang, vatBps: number, inclusive: boolean): Satang =>
  inclusive && vatBps > 0 ? Math.round((price * 10_000) / (10_000 + vatBps)) : price;

/** Gross profit and margin (one decimal, by integer maths: 667 = 66.7 %) — null when the price is not above zero. */
export function margin(price: Satang, cost: Satang): { profit: Satang; pctX10: number } | null {
  if (price <= 0) return null;
  return { profit: price - cost, pctX10: Math.round(((price - cost) * 1000) / price) };
}
export const formatPctX10 = (v: number): string => {
  const a = Math.abs(v);
  return `${v < 0 ? '-' : ''}${Math.floor(a / 10)}.${a % 10}`;
};

export const isLow = (i: Pick<StockItem, 'quantity' | 'lowAt' | 'active'>): boolean =>
  i.active && i.lowAt > 0 && i.quantity <= i.lowAt;

/** What a chosen option uses (per ONE portion), and optionally which recipe ingredient it stands in for ("oat milk instead of milk"). */
export type OptionUse = {
  optionId: string;
  itemId: string;
  quantity: number;
  insteadOf: string | null;
};

/**
 * What a set of sold lines uses up — the same arithmetic the database does when a bill is paid: the dish's recipe (except an ingredient
 * a chosen option stands in for) plus what every chosen option uses, per portion × quantity.
 */
export function consumption(
  sold: readonly { menuItemId: string | null; quantity: number; optionIds?: readonly string[] }[],
  recipes: readonly RecipeLine[],
  optionUse: readonly OptionUse[] = [],
): Map<string, number> {
  const out = new Map<string, number>();
  const add = (id: string, q: number) => out.set(id, (out.get(id) ?? 0) + q);
  for (const s of sold) {
    if (!s.menuItemId) continue;
    const chosen = optionUse.filter((u) => s.optionIds?.includes(u.optionId));
    const replaced = new Set(chosen.map((u) => u.insteadOf).filter((x): x is string => !!x));
    for (const r of recipes)
      if (r.menuItemId === s.menuItemId && !replaced.has(r.itemId))
        add(r.itemId, r.quantity * s.quantity);
    for (const u of chosen) add(u.itemId, u.quantity * s.quantity);
  }
  return out;
}

/** What the whole stock is worth at cost (goods that are not there — a negative count — are worth nothing). */
export const stockValue = (items: readonly Pick<StockItem, 'quantity' | 'costPer1000'>[]): Satang =>
  items.reduce((a, i) => a + lineCost(Math.max(0, i.quantity), i.costPer1000), 0);

/** A scanned or typed barcode: letters, digits and dashes, 4–40 long (what the database accepts); anything else is null. */
export function normalizeBarcode(text: string): string | null {
  const t = text.trim();
  return /^[0-9A-Za-z-]{4,40}$/.test(t) ? t : null;
}

const isRec = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const int = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : 0;
};
export function parseStockItems(raw: unknown): StockItem[] {
  if (!Array.isArray(raw)) return [];
  const out: StockItem[] = [];
  for (const r of raw) {
    if (!isRec(r) || typeof r.id !== 'string' || !isRec(r.name) || typeof r.name.th !== 'string')
      continue;
    if (!(STOCK_UNITS as readonly unknown[]).includes(r.unit)) continue;
    out.push({
      id: r.id,
      name: {
        th: r.name.th,
        ...(typeof r.name.en === 'string' && r.name.en ? { en: r.name.en } : {}),
      },
      barcode: typeof r.barcode === 'string' && r.barcode ? r.barcode : null,
      unit: r.unit as StockUnit,
      quantity: int(r.quantity),
      costPer1000: int(r.cost_per_1000),
      lowAt: int(r.low_at),
      active: r.active !== false,
    });
  }
  return out;
}
export function parseRecipeLines(raw: unknown): RecipeLine[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (r): r is Record<string, unknown> =>
        isRec(r) && typeof r.menu_item_id === 'string' && typeof r.item_id === 'string',
    )
    .map((r) => ({
      menuItemId: String(r.menu_item_id),
      itemId: String(r.item_id),
      quantity: int(r.quantity),
    }))
    .filter((r) => r.quantity > 0);
}

export function parseOptionUse(raw: unknown): OptionUse[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (r): r is Record<string, unknown> =>
        isRec(r) && typeof r.option_id === 'string' && typeof r.item_id === 'string',
    )
    .map((r) => ({
      optionId: String(r.option_id),
      itemId: String(r.item_id),
      quantity: int(r.quantity),
      insteadOf: typeof r.instead_of === 'string' ? r.instead_of : null,
    }))
    .filter((r) => r.quantity > 0);
}
