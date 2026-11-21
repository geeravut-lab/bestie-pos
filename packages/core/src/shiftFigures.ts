// "Explain this shift" (owner / manager, module `ai.assistant`): the figures come from the database (`shift_figures`), a model only EXPLAINS them, and every number in its
// answer is checked against the figures (`unverifiedNumbers` from askShop.ts). Pure helpers only.
export type ShiftFigures = {
  shop: string;
  device: string;
  openedAt: string;
  closedAt: string;
  openingCash: number;
  expectedCash: number;
  countedCash: number;
  variance: number;
  bills: number;
  sales: number;
  byTender: Record<string, number>;
};

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function parseShiftFigures(v: unknown): ShiftFigures | null {
  const o = obj(v);
  if (!str(o.closed_at) || !str(o.opened_at)) return null;
  const by: Record<string, number> = {};
  for (const [k, x] of Object.entries(obj(o.by_tender)))
    if (/^[a-z_]{1,20}$/.test(k) && typeof x === 'number' && Number.isFinite(x)) by[k] = x;
  return {
    shop: str(o.shop),
    device: str(o.device),
    openedAt: str(o.opened_at),
    closedAt: str(o.closed_at),
    openingCash: num(o.opening_cash),
    expectedCash: num(o.expected_cash),
    countedCash: num(o.counted_cash),
    variance: num(o.variance),
    bills: num(o.bills),
    sales: num(o.sales),
    byTender: by,
  };
}

/** Satang → "1,234.50" (integers only, no floating point). */
const baht = (satang: number): string => {
  const sign = satang < 0 ? '-' : '';
  const a = Math.abs(Math.trunc(satang));
  const whole = Math.floor(a / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${whole}.${String(a % 100).padStart(2, '0')}`;
};
const plainBaht = (satang: number): string => baht(satang).replace(/\.00$/, '');

/** The text the model may use and every number it may quote (in baht, with and without the decimals). */
export function buildShiftPack(f: ShiftFigures): { text: string; allowed: number[] } {
  const allowed: number[] = [f.bills];
  const money = (satang: number): string => {
    allowed.push(Math.round(Math.abs(satang)) / 100);
    return `${plainBaht(satang)}`;
  };
  const lines = [
    `Shop: ${f.shop} · till: ${f.device}`,
    `Shift: ${f.openedAt} to ${f.closedAt} (Bangkok time is shown to the owner separately)`,
    `Bills closed on this till during the shift: ${f.bills}`,
    `Sales (THB, after discounts, including VAT): ${money(f.sales)}`,
  ];
  for (const [tender, amount] of Object.entries(f.byTender).sort())
    lines.push(`Paid by ${tender}: THB ${money(amount)}`);
  lines.push(
    `Cash drawer: opening THB ${money(f.openingCash)}, expected THB ${money(f.expectedCash)}, counted THB ${money(f.countedCash)}`,
    f.variance === 0
      ? 'Cash difference: none (the count matches)'
      : `Cash difference: ${f.variance < 0 ? 'SHORT' : 'OVER'} by THB ${money(Math.abs(f.variance))}`,
  );
  return { text: lines.join('\n'), allowed };
}
