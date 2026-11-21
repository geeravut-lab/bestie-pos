// Menu engineering (Kasavana–Smith): every dish is placed by how popular it is and how much it earns per portion.
//   star      popular and profitable        → keep, show it first
//   plowhorse popular but earns little      → raise the price a little or cut its cost
//   puzzle    profitable but not popular    → push it (menu position, a mention, a combo)
//   dog       neither                       → rework or drop
// Dishes with no recipe cost cannot be placed (`unknown`): the figure would be a guess. Money is integer satang; the cost of a portion may have a fraction of a satang.
import type { LocalizedText } from './types';

export type ProfitRow = {
  itemId: string;
  name: LocalizedText;
  qty: number;
  revenue: number;
  costUnit: number | null;
};
export type Quadrant = 'star' | 'plowhorse' | 'puzzle' | 'dog' | 'unknown';
export type EngRow = ProfitRow & {
  /** Average price before VAT of one portion as sold. */
  unitPrice: number;
  /** Price minus cost of one portion (satang, rounded), null when the cost is unknown. */
  unitMargin: number | null;
  /** Margin as a share of the price, basis points. */
  marginBps: number | null;
  /** Total profit of the period (satang), null when the cost is unknown. */
  profit: number | null;
  /** Share of all portions sold, basis points. */
  shareBps: number;
  quadrant: Quadrant;
};
export type Engineering = {
  rows: EngRow[];
  avgMargin: number;
  popularityCutBps: number;
  revenue: number;
  profit: number;
  costKnownBps: number;
};

const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0;

export function parseProfitReport(v: unknown): ProfitRow[] {
  if (!Array.isArray(v)) return [];
  const out: ProfitRow[] = [];
  for (const x of v) {
    const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    const name = o.name as LocalizedText | undefined;
    if (typeof o.item_id !== 'string' || !name || typeof name.th !== 'string') continue;
    out.push({
      itemId: o.item_id,
      name,
      qty: num(o.qty),
      revenue: num(o.revenue),
      costUnit: o.cost_unit == null ? null : num(o.cost_unit),
    });
  }
  return out;
}

export function classifyMenu(rows: readonly ProfitRow[]): Engineering {
  const totalQty = rows.reduce((a, r) => a + r.qty, 0);
  const costed = rows.filter((r) => r.costUnit !== null && r.qty > 0);
  const costedQty = costed.reduce((a, r) => a + r.qty, 0);
  const profitSum = costed.reduce((a, r) => a + (r.revenue - r.costUnit! * r.qty), 0);
  const avgMargin = costedQty > 0 ? Math.round(profitSum / costedQty) : 0; // weighted average margin of one portion
  // popular = at least 70 % of an equal share (the classic rule)
  const popularityCutBps = rows.length > 0 ? Math.round((7000 / rows.length) * 1) : 0;
  const out: EngRow[] = rows.map((r) => {
    const unitPrice = r.qty > 0 ? Math.round(r.revenue / r.qty) : 0;
    const unitMargin = r.costUnit === null ? null : Math.round(unitPrice - r.costUnit);
    const shareBps = totalQty > 0 ? Math.round((r.qty / totalQty) * 10000) : 0;
    const popular = shareBps >= popularityCutBps;
    const quadrant: Quadrant =
      unitMargin === null
        ? 'unknown'
        : popular
          ? unitMargin >= avgMargin
            ? 'star'
            : 'plowhorse'
          : unitMargin >= avgMargin
            ? 'puzzle'
            : 'dog';
    return {
      ...r,
      unitPrice,
      unitMargin,
      marginBps:
        unitMargin === null || unitPrice <= 0 ? null : Math.round((unitMargin / unitPrice) * 10000),
      profit: r.costUnit === null ? null : Math.round(r.revenue - r.costUnit * r.qty),
      shareBps,
      quadrant,
    };
  });
  const revenue = rows.reduce((a, r) => a + r.revenue, 0);
  return {
    rows: out.sort((a, b) => b.revenue - a.revenue),
    avgMargin,
    popularityCutBps,
    revenue,
    profit: Math.round(profitSum),
    costKnownBps:
      revenue > 0 ? Math.round((costed.reduce((a, r) => a + r.revenue, 0) / revenue) * 10000) : 0,
  };
}
