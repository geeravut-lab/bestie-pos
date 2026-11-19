import { lineCost } from './stock';
import type { Satang } from './money';

/** Suppliers, purchase orders and transfers between shops — the pure part (the database does the booking). */
export const PO_STATUSES = ['draft', 'sent', 'partial', 'received', 'cancelled'] as const;
export type PoStatus = (typeof PO_STATUSES)[number];
export const TRANSFER_STATUSES = ['sent', 'received', 'cancelled'] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

export type Supplier = { id: string; name: string; phone: string | null; note: string | null };
export type PoLine = {
  id: string;
  itemId: string;
  ordered: number;
  received: number;
  costPer1000: Satang;
};
export type PurchaseOrder = {
  id: string;
  number: string;
  supplierId: string;
  status: PoStatus;
  note: string | null;
  expectedOn: string | null;
  createdAt: string;
  lines: PoLine[];
};
export type TransferLine = {
  id: string;
  fromItemId: string;
  quantity: number;
  costPer1000: Satang;
};
export type StockTransfer = {
  id: string;
  number: string;
  fromStoreId: string;
  toStoreId: string;
  status: TransferStatus;
  note: string | null;
  createdAt: string;
  lines: TransferLine[];
};

/** What an order is worth at the agreed prices. */
export const poTotal = (lines: readonly Pick<PoLine, 'ordered' | 'costPer1000'>[]): Satang =>
  lines.reduce((a, l) => a + lineCost(l.ordered, l.costPer1000), 0);

/** What is still to come on a line (never negative: extra goods do not make it "owed"). */
export const poOutstanding = (l: Pick<PoLine, 'ordered' | 'received'>): number =>
  Math.max(0, l.ordered - l.received);

/** What a person may do with an order in each state — the database refuses everything else. */
export function poActions(o: Pick<PurchaseOrder, 'status' | 'lines'>): {
  edit: boolean;
  send: boolean;
  receive: boolean;
  cancel: boolean;
} {
  const anyReceived = o.lines.some((l) => l.received > 0);
  return {
    edit: o.status === 'draft',
    send: o.status === 'draft',
    receive: o.status === 'draft' || o.status === 'sent' || o.status === 'partial',
    cancel: (o.status === 'draft' || o.status === 'sent') && !anyReceived,
  };
}

export const transferActions = (t: Pick<StockTransfer, 'status'>, side: 'from' | 'to') => ({
  receive: t.status === 'sent' && side === 'to',
  cancel: t.status === 'sent',
});

const isRec = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const int = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : 0;
};
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export function parseSuppliers(raw: unknown): Supplier[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (r): r is Record<string, unknown> =>
        isRec(r) && typeof r.id === 'string' && typeof r.name === 'string',
    )
    .map((r) => ({
      id: String(r.id),
      name: String(r.name),
      phone: str(r.phone),
      note: str(r.note),
    }));
}

const isPo = (v: unknown): v is PoStatus => (PO_STATUSES as readonly unknown[]).includes(v);
export function parsePurchaseOrders(orders: unknown, lines: unknown): PurchaseOrder[] {
  if (!Array.isArray(orders)) return [];
  const byPo = new Map<string, PoLine[]>();
  for (const l of Array.isArray(lines) ? lines : []) {
    if (
      !isRec(l) ||
      typeof l.id !== 'string' ||
      typeof l.po_id !== 'string' ||
      typeof l.item_id !== 'string'
    )
      continue;
    const arr = byPo.get(l.po_id) ?? [];
    arr.push({
      id: l.id,
      itemId: l.item_id,
      ordered: int(l.qty_ordered),
      received: int(l.qty_received),
      costPer1000: int(l.cost_per_1000),
    });
    byPo.set(l.po_id, arr);
  }
  const out: PurchaseOrder[] = [];
  for (const o of orders) {
    if (!isRec(o) || typeof o.id !== 'string' || typeof o.number !== 'string' || !isPo(o.status))
      continue;
    out.push({
      id: o.id,
      number: o.number,
      supplierId: String(o.supplier_id ?? ''),
      status: o.status,
      note: str(o.note),
      expectedOn: str(o.expected_on),
      createdAt: String(o.created_at ?? ''),
      lines: byPo.get(o.id) ?? [],
    });
  }
  return out;
}

const isTs = (v: unknown): v is TransferStatus =>
  (TRANSFER_STATUSES as readonly unknown[]).includes(v);
export function parseTransfers(transfers: unknown, lines: unknown): StockTransfer[] {
  if (!Array.isArray(transfers)) return [];
  const byTr = new Map<string, TransferLine[]>();
  for (const l of Array.isArray(lines) ? lines : []) {
    if (
      !isRec(l) ||
      typeof l.id !== 'string' ||
      typeof l.transfer_id !== 'string' ||
      typeof l.from_item_id !== 'string'
    )
      continue;
    const arr = byTr.get(l.transfer_id) ?? [];
    arr.push({
      id: l.id,
      fromItemId: l.from_item_id,
      quantity: int(l.quantity),
      costPer1000: int(l.cost_per_1000),
    });
    byTr.set(l.transfer_id, arr);
  }
  const out: StockTransfer[] = [];
  for (const t of transfers) {
    if (!isRec(t) || typeof t.id !== 'string' || typeof t.number !== 'string' || !isTs(t.status))
      continue;
    out.push({
      id: t.id,
      number: t.number,
      fromStoreId: String(t.from_store_id ?? ''),
      toStoreId: String(t.to_store_id ?? ''),
      status: t.status,
      note: str(t.note),
      createdAt: String(t.created_at ?? ''),
      lines: byTr.get(t.id) ?? [],
    });
  }
  return out;
}
