// Head-office dashboard (several shops of one business): turns two `sales_report()` answers (this period and the one before it) and the list of shops into
// one row per shop, with the change against the previous period and each shop's share of the company. Integer arithmetic only.
import type { SalesReport } from './reportRead';

export type HqRow = {
  storeId: string;
  name: string;
  bills: number;
  payable: number;
  average: number;
  prevPayable: number;
  /** Change against the previous period in whole percent (rounded half away from zero); null when there was nothing before. */
  changePct: number | null;
  /** Share of the company's sales in whole percent. */
  sharePct: number;
};
export type HqSummary = {
  rows: HqRow[];
  totals: {
    bills: number;
    payable: number;
    average: number;
    prevPayable: number;
    changePct: number | null;
  };
  best: string | null;
  quiet: string[];
};

/** `(now - before) / before` in whole percent, half away from zero; null when `before` is 0. */
export function pctChange(now: number, before: number): number | null {
  if (before <= 0) return null;
  const d = now - before;
  const q = Math.floor((Math.abs(d) * 100 * 2 + before) / (before * 2));
  return d < 0 ? -q : q;
}

export function hqSummary(
  shops: readonly { id: string; name: string }[],
  current: SalesReport,
  previous: SalesReport,
): HqSummary {
  const cur = new Map(current.byStore.map((s) => [s.storeId, s]));
  const prev = new Map(previous.byStore.map((s) => [s.storeId, s]));
  const total = current.totals.payable;
  const rows: HqRow[] = shops.map((s) => {
    const c = cur.get(s.id);
    const p = prev.get(s.id);
    const payable = c?.payable ?? 0;
    const bills = c?.bills ?? 0;
    return {
      storeId: s.id,
      name: s.name,
      bills,
      payable,
      average: bills > 0 ? Math.round(payable / bills) : 0,
      prevPayable: p?.payable ?? 0,
      changePct: pctChange(payable, p?.payable ?? 0),
      sharePct: total > 0 ? Math.round((payable * 100) / total) : 0,
    };
  });
  rows.sort((a, b) => b.payable - a.payable || a.name.localeCompare(b.name));
  return {
    rows,
    totals: {
      bills: current.totals.bills,
      payable: total,
      average: current.totals.average,
      prevPayable: previous.totals.payable,
      changePct: pctChange(total, previous.totals.payable),
    },
    best: rows[0] && rows[0].payable > 0 ? rows[0].name : null,
    quiet: rows.filter((r) => r.bills === 0).map((r) => r.name),
  };
}

/** The two periods the dashboard compares: today with yesterday, the last 7 days with the 7 before, or the month so far with the same days of the last month. */
export type HqPeriod = 'today' | 'week' | 'month';
export function hqRanges(
  period: HqPeriod,
  today: string,
): { current: { from: string; to: string }; previous: { from: string; to: string } } {
  const add = (d: string, n: number): string => {
    const t = new Date(`${d}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() + n);
    return t.toISOString().slice(0, 10);
  };
  if (period === 'today')
    return {
      current: { from: today, to: today },
      previous: { from: add(today, -1), to: add(today, -1) },
    };
  if (period === 'week')
    return {
      current: { from: add(today, -6), to: today },
      previous: { from: add(today, -13), to: add(today, -7) },
    };
  const first = `${today.slice(0, 8)}01`;
  const day = Number(today.slice(8, 10));
  const prevFirst = ((): string => {
    const t = new Date(`${first}T00:00:00Z`);
    t.setUTCMonth(t.getUTCMonth() - 1);
    return t.toISOString().slice(0, 10);
  })();
  const prevLastDay = new Date(
    Date.UTC(Number(prevFirst.slice(0, 4)), Number(prevFirst.slice(5, 7)), 0),
  ).getUTCDate();
  const prevTo = `${prevFirst.slice(0, 8)}${String(Math.min(day, prevLastDay)).padStart(2, '0')}`;
  return { current: { from: first, to: today }, previous: { from: prevFirst, to: prevTo } };
}
