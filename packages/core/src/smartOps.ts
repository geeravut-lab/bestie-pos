// Smart operations (stock forecast, waste, lots, service cases, business manager, reconciliation): readers for what the database answers, and the few rules that live in code.
import type { LocalizedText } from './types';

const obj = (x: unknown): Record<string, unknown> =>
  x && typeof x === 'object' ? (x as Record<string, unknown>) : {};
const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0;
const nnum = (v: unknown): number | null =>
  v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const name = (v: unknown): LocalizedText => {
  const o = obj(v);
  return { th: str(o.th), ...(str(o.en) ? { en: str(o.en) } : {}) };
};

// ── forecast ──
export type ForecastRow = {
  itemId: string;
  name: LocalizedText;
  unit: 'g' | 'ml' | 'pcs';
  quantity: number;
  lowAt: number;
  avgDaily: number;
  daysLeft: number | null;
  onOrder: number;
  forecast: number;
  suggested: number;
  supplierId: string | null;
  supplierName: string | null;
  lastCost: number;
};
export function parseForecast(v: unknown): ForecastRow[] {
  if (!Array.isArray(v)) return [];
  const out: ForecastRow[] = [];
  for (const x of v) {
    const o = obj(x);
    if (!str(o.item_id)) continue;
    const unit = o.unit === 'g' || o.unit === 'ml' ? o.unit : 'pcs';
    out.push({
      itemId: str(o.item_id),
      name: name(o.name),
      unit,
      quantity: num(o.quantity),
      lowAt: num(o.low_at),
      avgDaily: num(o.avg_daily),
      daysLeft: nnum(o.days_left),
      onOrder: num(o.on_order),
      forecast: num(o.forecast),
      suggested: num(o.suggested),
      supplierId: str(o.supplier_id) || null,
      supplierName: str(o.supplier_name) || null,
      lastCost: num(o.last_cost),
    });
  }
  return out;
}
/** Suggested orders grouped by supplier, ready for `save_purchase_order`; items with no known supplier are returned apart. */
export function groupSuggestions(rows: readonly ForecastRow[]): {
  bySupplier: {
    supplierId: string;
    supplierName: string;
    lines: { item_id: string; quantity: number; cost_per_1000: number }[];
  }[];
  noSupplier: ForecastRow[];
} {
  const map = new Map<
    string,
    {
      supplierId: string;
      supplierName: string;
      lines: { item_id: string; quantity: number; cost_per_1000: number }[];
    }
  >();
  const noSupplier: ForecastRow[] = [];
  for (const r of rows) {
    if (r.suggested <= 0) continue;
    if (!r.supplierId) {
      noSupplier.push(r);
      continue;
    }
    const g = map.get(r.supplierId) ?? {
      supplierId: r.supplierId,
      supplierName: r.supplierName ?? '',
      lines: [],
    };
    g.lines.push({ item_id: r.itemId, quantity: r.suggested, cost_per_1000: r.lastCost });
    map.set(r.supplierId, g);
  }
  return { bySupplier: [...map.values()], noSupplier };
}
/** Cost of an order line in satang: quantity × price per 1,000 base units. */
export const orderLineCost = (quantity: number, costPer1000: number): number =>
  Math.round((quantity * costPer1000) / 1000);

// ── waste ──
export const WASTE_REASONS = [
  'expired',
  'damaged',
  'overproduced',
  'spilled',
  'returned',
  'other',
] as const;
export type WasteReason = (typeof WASTE_REASONS)[number];
export type WasteReport = {
  total: number;
  byReason: { reason: WasteReason; cost: number; qty: number }[];
  byItem: { itemId: string; name: LocalizedText; unit: string; qty: number; cost: number }[];
};
export function parseWaste(v: unknown): WasteReport {
  const o = obj(v);
  const reasons = (Array.isArray(o.by_reason) ? o.by_reason : []).map(obj);
  const items = (Array.isArray(o.by_item) ? o.by_item : []).map(obj);
  return {
    total: num(o.total),
    byReason: reasons.map((r) => ({
      reason: (WASTE_REASONS as readonly string[]).includes(str(r.reason))
        ? (str(r.reason) as WasteReason)
        : 'other',
      cost: num(r.cost),
      qty: num(r.qty),
    })),
    byItem: items.map((r) => ({
      itemId: str(r.item_id),
      name: name(r.name),
      unit: str(r.unit),
      qty: num(r.qty),
      cost: num(r.cost),
    })),
  };
}
export type CostAlert = {
  itemId: string;
  name: LocalizedText;
  price: number;
  costNow: number;
  costBefore: number;
  marginBps: number | null;
};
export function parseCostAlerts(v: unknown): CostAlert[] {
  return (Array.isArray(v) ? v : [])
    .map(obj)
    .filter((o) => str(o.item_id))
    .map((o) => ({
      itemId: str(o.item_id),
      name: name(o.name),
      price: num(o.price),
      costNow: num(o.cost_now),
      costBefore: num(o.cost_before),
      marginBps: nnum(o.margin_bps),
    }));
}
export type Batch = {
  id: string;
  itemId: string;
  code: string | null;
  qty: number;
  expiresOn: string;
  note: string | null;
};
export function parseBatches(v: unknown): Batch[] {
  return (Array.isArray(v) ? v : [])
    .map(obj)
    .filter((o) => str(o.id) && !o.used_at)
    .map((o) => ({
      id: str(o.id),
      itemId: str(o.item_id),
      code: str(o.code) || null,
      qty: num(o.qty),
      expiresOn: str(o.expires_on),
      note: str(o.note) || null,
    }))
    .sort((a, b) => a.expiresOn.localeCompare(b.expiresOn));
}
/** Days from `today` (YYYY-MM-DD) to a lot's last day; negative = already expired. */
export function daysToExpiry(expiresOn: string, today: string): number {
  return Math.round(
    (Date.parse(`${expiresOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
  );
}

// ── service cases ──
export type CaseStatus = 'open' | 'acknowledged' | 'resolved';
export type ServiceCase = {
  id: string;
  source: 'feedback' | 'manual';
  summary: string;
  status: CaseStatus;
  assignee: string | null;
  slaMin: number;
  createdAt: string;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  resolution: string | null;
  confirmed: boolean | null;
  escalated: boolean;
};
export function parseCases(v: unknown): ServiceCase[] {
  return (Array.isArray(v) ? v : [])
    .map(obj)
    .filter((o) => str(o.id))
    .map((o) => ({
      id: str(o.id),
      source: o.source === 'feedback' ? 'feedback' : 'manual',
      summary: str(o.summary),
      status:
        o.status === 'resolved'
          ? 'resolved'
          : o.status === 'acknowledged'
            ? 'acknowledged'
            : 'open',
      assignee: str(o.assignee) || null,
      slaMin: num(o.sla_min) || 15,
      createdAt: str(o.created_at),
      firstResponseAt: str(o.first_response_at) || null,
      resolvedAt: str(o.resolved_at) || null,
      resolution: str(o.resolution) || null,
      confirmed: typeof o.customer_confirmed === 'boolean' ? o.customer_confirmed : null,
      escalated: !!str(o.escalated_at),
    }));
}
/** Minutes left to answer an open case (negative = late); null once somebody answered. */
export function minutesToAnswer(
  c: Pick<ServiceCase, 'createdAt' | 'slaMin' | 'firstResponseAt' | 'status'>,
  nowMs: number,
): number | null {
  if (c.firstResponseAt || c.status !== 'open') return null;
  return Math.round((Date.parse(c.createdAt) + c.slaMin * 60_000 - nowMs) / 60_000);
}
export type CaseKpi = {
  cases: number;
  answered: number;
  avgFirstResponseSec: number | null;
  avgResolutionSec: number | null;
  confirmed: number;
  late: number;
};
export function parseCaseKpi(v: unknown): CaseKpi {
  const o = obj(v);
  return {
    cases: num(o.cases),
    answered: num(o.answered),
    avgFirstResponseSec: nnum(o.avg_first_response_sec),
    avgResolutionSec: nnum(o.avg_resolution_sec),
    confirmed: num(o.confirmed),
    late: num(o.late),
  };
}

// ── business manager ──
export type InsightKind =
  | 'low_stock'
  | 'thin_margin'
  | 'sales_drop'
  | 'waste_high'
  | 'expiring'
  | 'cases_overdue'
  | 'cost_rise';
export type Insight = {
  id: string;
  kind: InsightKind;
  severity: 'info' | 'watch' | 'act';
  evidence: Record<string, unknown>;
  action: Record<string, unknown> | null;
  status: 'new' | 'approved' | 'dismissed';
  createdAt: string;
};
const KINDS: readonly string[] = [
  'low_stock',
  'thin_margin',
  'sales_drop',
  'waste_high',
  'expiring',
  'cases_overdue',
  'cost_rise',
];
export function parseInsights(v: unknown): Insight[] {
  const ctx = obj(v);
  return (Array.isArray(ctx.insights) ? ctx.insights : [])
    .map(obj)
    .filter((o) => str(o.id) && KINDS.includes(str(o.kind)))
    .map((o) => ({
      id: str(o.id),
      kind: str(o.kind) as InsightKind,
      severity: o.severity === 'act' ? 'act' : o.severity === 'watch' ? 'watch' : 'info',
      evidence: obj(o.evidence),
      action:
        o.action && typeof o.action === 'object' ? (o.action as Record<string, unknown>) : null,
      status: o.status === 'approved' ? 'approved' : o.status === 'dismissed' ? 'dismissed' : 'new',
      createdAt: str(o.created_at),
    }));
}
/** Every number that may appear in the morning brief: the figures inside the findings (money in baht, counts, percentages). */
export function briefFigures(insights: readonly Insight[]): string[] {
  const out = new Set<string>();
  const walk = (x: unknown): void => {
    if (typeof x === 'number' && Number.isFinite(x)) out.add(String(x));
    else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') Object.values(x).forEach(walk);
  };
  insights.filter((i) => i.status === 'new').forEach((i) => walk(i.evidence));
  return [...out];
}

// ── reconciliation ──
export type BestieRow = {
  provider: string;
  providerRef: string;
  amount: number;
  status: string;
  orderNumber: string | null;
  createdAt: string;
};
export type ProviderRow = {
  providerRef: string;
  amount: number;
  currency: string;
  createdMs: number;
};
export type Reconciliation = {
  matched: number;
  /** Paid at the provider, but Bestie did not close a bill for it (money to look for). */
  missingInBestie: ProviderRow[];
  /** Bestie says it was paid, the provider has no such payment. */
  missingAtProvider: BestieRow[];
  /** Both have it with different amounts. */
  amountDiffers: { bestie: BestieRow; provider: ProviderRow }[];
  /** Bestie put it aside for a person to decide. */
  needsReview: BestieRow[];
  providerTotal: number;
  bestieTotal: number;
};
export function reconcile(
  bestie: readonly BestieRow[],
  provider: readonly ProviderRow[],
): Reconciliation {
  const paid = bestie.filter((b) => b.status === 'succeeded');
  const prov = new Map(provider.map((p) => [p.providerRef, p]));
  const seen = new Set<string>();
  const out: Reconciliation = {
    matched: 0,
    missingInBestie: [],
    missingAtProvider: [],
    amountDiffers: [],
    needsReview: bestie.filter((b) => b.status === 'needs_review'),
    providerTotal: provider.reduce((a, p) => a + p.amount, 0),
    bestieTotal: paid.reduce((a, b) => a + b.amount, 0),
  };
  for (const b of paid) {
    const p = prov.get(b.providerRef);
    if (!p) out.missingAtProvider.push(b);
    else if (p.amount !== b.amount) out.amountDiffers.push({ bestie: b, provider: p });
    else out.matched += 1;
    seen.add(b.providerRef);
  }
  const review = new Set(out.needsReview.map((b) => b.providerRef));
  for (const p of provider)
    if (!seen.has(p.providerRef) && !review.has(p.providerRef)) out.missingInBestie.push(p);
  return out;
}
export function parseBestieRows(v: unknown): BestieRow[] {
  return (Array.isArray(v) ? v : [])
    .map(obj)
    .filter((o) => str(o.provider_ref))
    .map((o) => ({
      provider: str(o.provider),
      providerRef: str(o.provider_ref),
      amount: num(o.amount),
      status: str(o.status),
      orderNumber: str(o.order_number) || null,
      createdAt: str(o.created_at),
    }));
}
export type Dispute = {
  disputeRef: string;
  paymentRef: string | null;
  amount: number;
  reason: string | null;
  status: string;
  createdAt: string;
};
export function parseDisputes(v: unknown): Dispute[] {
  return (Array.isArray(v) ? v : [])
    .map(obj)
    .filter((o) => str(o.dispute_ref))
    .map((o) => ({
      disputeRef: str(o.dispute_ref),
      paymentRef: str(o.payment_ref) || null,
      amount: num(o.amount),
      reason: str(o.reason) || null,
      status: str(o.status),
      createdAt: str(o.created_at),
    }));
}
export type RefundRow = {
  refundRef: string;
  amount: number;
  orderNumber: string | null;
  createdAt: string;
};
export function parseRefunds(v: unknown): RefundRow[] {
  return (Array.isArray(v) ? v : [])
    .map(obj)
    .filter((o) => str(o.refund_ref))
    .map((o) => ({
      refundRef: str(o.refund_ref),
      amount: num(o.amount),
      orderNumber: str(o.order_number) || null,
      createdAt: str(o.created_at),
    }));
}

// ── the morning brief: the open findings as plain facts for the model to explain (it may use no other number) ──
const baht = (satang: number): number => Math.round(satang) / 100;
const lname = (n: unknown): string => {
  const o = obj(n);
  return str(o.en) || str(o.th) || '?';
};
export function buildBriefPack(insights: readonly Insight[]): { text: string; allowed: number[] } {
  const allowed: number[] = [];
  const num2 = (n: number): number => {
    allowed.push(n);
    return n;
  };
  const lines: string[] = [];
  for (const i of insights.filter((x) => x.status === 'new')) {
    const e = i.evidence;
    if (i.kind === 'low_stock')
      for (const it of (Array.isArray(e.items) ? e.items : []).map(obj))
        lines.push(
          `Low stock: ${lname(it.name)} has ${num2(num(it.quantity))} ${str(it.unit)} left, about ${num2(num(it.days_left))} days at the usual use; the suggested order is ${num2(num(it.suggested))} ${str(it.unit)}.`,
        );
    else if (i.kind === 'thin_margin')
      for (const it of (Array.isArray(e.items) ? e.items : []).map(obj))
        lines.push(
          `Thin margin: ${lname(it.name)} sells for THB ${num2(baht(num(it.price)))} and costs THB ${num2(baht(num(it.cost)))} to make (${num2(Math.round(num(it.margin_bps) / 100))}% margin).`,
        );
    else if (i.kind === 'sales_drop')
      lines.push(
        `Sales drop: yesterday THB ${num2(baht(num(e.yesterday)))} against THB ${num2(baht(num(e.usual)))} on the same weekday of the weeks before.`,
      );
    else if (i.kind === 'waste_high')
      lines.push(
        `High waste: THB ${num2(baht(num(e.waste)))} of waste against THB ${num2(baht(num(e.sales)))} of sales in the last 7 days.`,
      );
    else if (i.kind === 'expiring')
      for (const it of (Array.isArray(e.lots) ? e.lots : []).map(obj))
        lines.push(
          `Expiring: ${num2(num(it.qty))} of ${lname(it.item)} expire on ${str(it.expires_on)}.`,
        );
    else if (i.kind === 'cases_overdue')
      lines.push(
        `Complaints waiting too long: ${num2(num(e.cases))} case(s) have had no answer in time.`,
      );
  }
  return { text: lines.join('\n'), allowed };
}
