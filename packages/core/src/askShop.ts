import type { SalesReport } from './reportRead.js';
import type { Satang } from './money.js';

/**
 * "Ask my shop": the owner / manager asks a question in words, the assistant answers in words — but every NUMBER comes
 * from the database report. Code builds a figures pack (this period, the period just before it, differences and shares),
 * the model only explains what is in it, and code then checks that no number in the answer is missing from the pack.
 */
export type AskPreset = 'today' | 'yesterday' | 'last7' | 'last30' | 'month';
export const ASK_PRESETS: readonly AskPreset[] = ['today', 'yesterday', 'last7', 'last30', 'month'];

const DAY = 86_400_000;
const dayMs = (iso: string): number => Date.parse(`${iso}T00:00:00Z`);
const isoOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The same number of days immediately before `from` .. `to` (the period to compare with). */
export function previousRange(r: { from: string; to: string }): { from: string; to: string } {
  const days = Math.round((dayMs(r.to) - dayMs(r.from)) / DAY) + 1;
  return { from: isoOf(dayMs(r.from) - days * DAY), to: isoOf(dayMs(r.from) - DAY) };
}

const baht = (s: Satang): string => {
  const sign = s < 0 ? '-' : '';
  const a = Math.abs(s);
  const whole = Math.floor(a / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = a % 100;
  return `${sign}${whole}${frac === 0 ? '' : `.${String(frac).padStart(2, '0')}`}`;
};
/** One decimal place, by integer arithmetic (no toFixed): 12.34 -> "12.3". */
const dec1 = (v: number): string => {
  const r = Math.round(v * 10);
  const a = Math.abs(r);
  return `${r < 0 ? '-' : ''}${Math.floor(a / 10)}.${a % 10}`;
};
const round1 = (v: number): number => Math.round(v * 10) / 10;
const pct = (now: number, before: number): string | null =>
  before === 0 ? null : `${now >= before ? '+' : ''}${dec1(((now - before) / before) * 100)}%`;

export type FiguresPack = {
  text: string;
  /** Every number the answer may use (plain values: baht as decimals, counts, percentages, hours, date parts). */
  allowed: number[];
};

/**
 * The only facts the model gets. Amounts are in baht (THB). `previous` is optional (a shop with no earlier sales has none).
 */
export function buildFiguresPack(p: {
  shopName: string;
  current: SalesReport;
  previous: SalesReport | null;
}): FiguresPack {
  const allowed: number[] = [];
  const addN = (n: number) => void allowed.push(Math.round(n * 100) / 100);
  const addB = (s: Satang) => addN(s / 100);
  const addDate = (iso: string) => iso.split('-').forEach((x) => addN(Number(x)));
  const c = p.current;
  const prev = p.previous;
  const lines: string[] = [];
  lines.push(`Shop: ${p.shopName}`);
  lines.push(`Period: ${c.range.from} to ${c.range.to} (Bangkok business dates)`);
  addDate(c.range.from);
  addDate(c.range.to);
  const days = Math.round((dayMs(c.range.to) - dayMs(c.range.from)) / DAY) + 1;
  addN(days);

  const t = c.totals;
  lines.push(
    `Sales (paid bills only): total ${baht(t.payable)} THB from ${t.bills} bills, average per bill ${baht(t.average)} THB; VAT ${baht(t.vat)} THB; service charge ${baht(t.serviceCharge)} THB.`,
  );
  [t.payable, t.average, t.vat, t.serviceCharge, t.subtotal].forEach(addB);
  addN(t.bills);

  if (prev) {
    const q = prev.totals;
    lines.push(`Previous period: ${prev.range.from} to ${prev.range.to}`);
    addDate(prev.range.from);
    addDate(prev.range.to);
    lines.push(
      `Previous period sales: total ${baht(q.payable)} THB from ${q.bills} bills, average ${baht(q.average)} THB.`,
    );
    [q.payable, q.average].forEach(addB);
    addN(q.bills);
    const dSales = t.payable - q.payable;
    const dBills = t.bills - q.bills;
    lines.push(
      `Change vs previous period: sales ${dSales >= 0 ? '+' : ''}${baht(dSales)} THB${pct(t.payable, q.payable) ? ` (${pct(t.payable, q.payable)})` : ''}; bills ${dBills >= 0 ? '+' : ''}${dBills}${pct(t.bills, q.bills) ? ` (${pct(t.bills, q.bills)})` : ''}.`,
    );
    addB(Math.abs(dSales));
    addN(Math.abs(dBills));
    for (const [a, b] of [
      [t.payable, q.payable],
      [t.bills, q.bills],
    ] as const)
      if (b !== 0) {
        const v = ((a - b) / b) * 100;
        addN(Math.abs(round1(v)));
        addN(Math.round(Math.abs(v)));
      }
  } else {
    lines.push('Previous period: no data.');
  }

  const top = (title: string, rows: string[]) =>
    lines.push(
      rows.length > 0 ? `${title}:\n${rows.map((r) => `  - ${r}`).join('\n')}` : `${title}: none`,
    );

  const items = c.byItem.slice(0, 10);
  top(
    'Best sellers by revenue',
    items.map((i, n) => {
      addN(n + 1);
      addN(i.quantity);
      addB(i.revenue);
      return `${i.nameEn || i.nameTh} (${i.nameTh}): ${i.quantity} sold, ${baht(i.revenue)} THB`;
    }),
  );
  const tenderTotal = c.byTender.reduce((a, x) => a + x.amount, 0);
  top(
    'Payment mix',
    c.byTender.map((x) => {
      addB(x.amount);
      addN(x.bills);
      const share = tenderTotal > 0 ? (x.amount / tenderTotal) * 100 : 0;
      addN(round1(share));
      addN(Math.round(share));
      return `${x.tender}: ${baht(x.amount)} THB (${dec1(share)}%), ${x.bills} bills`;
    }),
  );
  const hours = [...c.byHour].sort((a, b) => b.payable - a.payable).slice(0, 5);
  top(
    'Busiest hours by sales',
    hours.map((h) => {
      addN(h.hour);
      addN(h.hour + 1);
      addB(h.payable);
      addN(h.bills);
      return `${String(h.hour).padStart(2, '0')}:00-${String(h.hour + 1).padStart(2, '0')}:00: ${baht(h.payable)} THB, ${h.bills} bills`;
    }),
  );
  top(
    'Sales by staff',
    c.byStaff.slice(0, 8).map((s) => {
      addB(s.payable);
      addN(s.bills);
      return `${s.name || 'unknown'}: ${baht(s.payable)} THB, ${s.bills} bills`;
    }),
  );
  top(
    'Sales by day',
    c.byDay.slice(-31).map((d) => {
      addDate(d.date);
      addB(d.payable);
      addN(d.bills);
      return `${d.date}: ${baht(d.payable)} THB, ${d.bills} bills`;
    }),
  );
  if (c.byStore.length > 1)
    top(
      'Sales by shop',
      c.byStore.slice(0, 20).map((x) => {
        addB(x.payable);
        addN(x.bills);
        return `${x.name}: ${baht(x.payable)} THB, ${x.bills} bills`;
      }),
    );
  if (prev) {
    top(
      'Previous period best sellers',
      prev.byItem.slice(0, 5).map((i, n) => {
        addN(n + 1);
        addN(i.quantity);
        addB(i.revenue);
        return `${i.nameEn || i.nameTh}: ${i.quantity} sold, ${baht(i.revenue)} THB`;
      }),
    );
  }
  return { text: lines.join('\n'), allowed };
}

/**
 * Numbers in an answer that the pack does not contain. Small plain integers (under 100, no percent sign) are ignored — they are
 * counting words like "top 3"; everything else (amounts, decimals, percentages, big counts) must be in the pack.
 */
export function unverifiedNumbers(answer: string, allowed: readonly number[]): string[] {
  const out: string[] = [];
  for (const m of answer.matchAll(/(\d[\d,]*(?:\.\d+)?)(\s*%)?/g)) {
    const raw = m[1]!;
    const n = Number(raw.replace(/,/g, ''));
    if (!Number.isFinite(n)) continue;
    const plainSmall = Number.isInteger(n) && n < 100 && !m[2];
    if (plainSmall) continue;
    if (!allowed.some((a) => Math.abs(a - n) < 0.006)) out.push(`${raw}${m[2] ? '%' : ''}`);
  }
  return [...new Set(out)];
}
