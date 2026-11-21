// KPI report of one shop for a period (the figures the pilot shops are judged by).
export type Kpi = {
  bills: number;
  sales: number;
  orderToKitchenSec: number | null;
  prepSec: number | null;
  wasteCost: number;
  stockouts: number;
  noShowRateBps: number | null;
  repeatRateBps: number | null;
  feedbackResolutionSec: number | null;
};
const nz = (v: unknown): number | null =>
  v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;

export function parseKpi(v: unknown): Kpi {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return {
    bills: nz(o.bills) ?? 0,
    sales: nz(o.sales) ?? 0,
    orderToKitchenSec: nz(o.order_to_kitchen_sec),
    prepSec: nz(o.prep_sec),
    wasteCost: nz(o.waste_cost) ?? 0,
    stockouts: nz(o.stockouts) ?? 0,
    noShowRateBps: nz(o.noshow_rate_bps),
    repeatRateBps: nz(o.repeat_rate_bps),
    feedbackResolutionSec: nz(o.feedback_resolution_sec),
  };
}
/** Average of one bill (satang), null with no bills. */
export const averageBill = (k: Pick<Kpi, 'bills' | 'sales'>): number | null =>
  k.bills > 0 ? Math.round(k.sales / k.bills) : null;
/** Waste as a share of sales, basis points. */
export const wasteShareBps = (k: Pick<Kpi, 'wasteCost' | 'sales'>): number | null =>
  k.sales > 0 ? Math.round((k.wasteCost / k.sales) * 10000) : null;
/** "3 min 20 s" style, locale-free pieces for the screen to word. */
export function splitDuration(sec: number): { h: number; m: number; s: number } {
  const t = Math.max(0, Math.round(sec));
  return { h: Math.floor(t / 3600), m: Math.floor((t % 3600) / 60), s: t % 60 };
}
/** Change against the period before in whole percent, null when there was nothing before. */
export function changePct(now: number | null, before: number | null): number | null {
  if (now === null || before === null || before === 0) return null;
  return Math.round(((now - before) / before) * 100);
}
