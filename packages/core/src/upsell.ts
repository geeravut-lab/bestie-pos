// Upsell suggestions (rules, no AI): "when this dish is on the bill, offer that one". Pure code over the shop's own rules; a suggestion is never a dish that is sold out or already ordered.
export type UpsellRule = {
  id: string;
  itemId: string;
  suggestId: string;
  sort: number;
  active: boolean;
};

export function parseUpsellRules(v: unknown): UpsellRule[] {
  if (!Array.isArray(v)) return [];
  const out: UpsellRule[] = [];
  for (const x of v) {
    const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    if (
      typeof o.id !== 'string' ||
      typeof o.item_id !== 'string' ||
      typeof o.suggest_id !== 'string'
    )
      continue;
    out.push({
      id: o.id,
      itemId: o.item_id,
      suggestId: o.suggest_id,
      sort: Number(o.sort) || 0,
      active: o.active !== false,
    });
  }
  return out;
}

/** Dish ids to suggest for the dishes now on the bill: most triggers first, then the owner's order; at most `max`. */
export function suggestUpsells(
  inBill: readonly string[],
  rules: readonly UpsellRule[],
  available: ReadonlySet<string>,
  max = 3,
): string[] {
  const have = new Set(inBill);
  const score = new Map<string, { n: number; sort: number }>();
  for (const r of rules) {
    if (!r.active || !have.has(r.itemId) || have.has(r.suggestId) || !available.has(r.suggestId))
      continue;
    const cur = score.get(r.suggestId);
    score.set(r.suggestId, { n: (cur?.n ?? 0) + 1, sort: Math.min(cur?.sort ?? r.sort, r.sort) });
  }
  return [...score.entries()]
    .sort((a, b) => b[1].n - a[1].n || a[1].sort - b[1].sort || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([id]) => id);
}

export type PairStat = {
  a: string;
  b: string;
  aName: { th: string; en?: string };
  bName: { th: string; en?: string };
  together: number;
  aCount: number;
};
export function parsePairStats(v: unknown): PairStat[] {
  if (!Array.isArray(v)) return [];
  const out: PairStat[] = [];
  for (const x of v) {
    const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    const an = o.a_name as PairStat['aName'] | undefined;
    const bn = o.b_name as PairStat['bName'] | undefined;
    if (typeof o.a !== 'string' || typeof o.b !== 'string' || !an || !bn) continue;
    out.push({
      a: o.a,
      b: o.b,
      aName: an,
      bName: bn,
      together: Number(o.together) || 0,
      aCount: Number(o.a_count) || 0,
    });
  }
  return out;
}
/** Of the bills with dish A, the share (percent) that also had dish B. */
export const pairConfidence = (p: PairStat): number =>
  p.aCount > 0 ? Math.round((p.together / p.aCount) * 100) : 0;
