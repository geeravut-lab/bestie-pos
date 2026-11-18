import { bangkokDate } from './orders';
import { toCsv } from './csv';
import type { Satang } from './money';

/** What `sales_report()` returns. All money is integer satang, all dates are Bangkok business dates. */
export type SalesReport = {
  range: { from: string; to: string };
  totals: {
    bills: number;
    subtotal: Satang;
    serviceCharge: Satang;
    vat: Satang;
    rounding: Satang;
    payable: Satang;
    average: Satang;
  };
  byDay: { date: string; bills: number; payable: Satang }[];
  byHour: { hour: number; bills: number; payable: Satang }[];
  byTender: { tender: string; amount: Satang; bills: number }[];
  byItem: { nameTh: string; nameEn: string; quantity: number; revenue: Satang }[];
  byStaff: { staffId: string | null; name: string; bills: number; payable: Satang }[];
  byStore: { storeId: string; name: string; bills: number; payable: Satang }[];
};

export type ReportSection = 'days' | 'hours' | 'tenders' | 'items' | 'staff' | 'stores';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj) : []);
const int = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : 0;
};
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Reads the database's answer defensively: anything missing becomes zero / empty rather than a crash. */
export function parseSalesReport(raw: unknown): SalesReport {
  const r = obj(raw);
  const range = obj(r.range);
  const totals = obj(r.totals);
  return {
    range: { from: str(range.from), to: str(range.to) },
    totals: {
      bills: int(totals.bills),
      subtotal: int(totals.subtotal),
      serviceCharge: int(totals.service_charge),
      vat: int(totals.vat),
      rounding: int(totals.rounding),
      payable: int(totals.payable),
      average: int(totals.average),
    },
    byDay: list(r.by_day).map((x) => ({
      date: str(x.date),
      bills: int(x.bills),
      payable: int(x.payable),
    })),
    byHour: list(r.by_hour).map((x) => ({
      hour: int(x.hour),
      bills: int(x.bills),
      payable: int(x.payable),
    })),
    byTender: list(r.by_tender).map((x) => ({
      tender: str(x.tender),
      amount: int(x.amount),
      bills: int(x.bills),
    })),
    byItem: list(r.by_item).map((x) => ({
      nameTh: str(x.name_th),
      nameEn: str(x.name_en),
      quantity: int(x.quantity),
      revenue: int(x.revenue),
    })),
    byStaff: list(r.by_staff).map((x) => ({
      staffId: typeof x.staff_id === 'string' ? x.staff_id : null,
      name: str(x.name),
      bills: int(x.bills),
      payable: int(x.payable),
    })),
    byStore: list(r.by_store).map((x) => ({
      storeId: str(x.store_id),
      name: str(x.name),
      bills: int(x.bills),
      payable: int(x.payable),
    })),
  };
}

export type RangePreset = 'today' | 'yesterday' | 'last7' | 'last30' | 'month';

const DAY = 86_400_000;
/** Date presets in Bangkok calendar days (`nowMs` is any instant; the shop's day is what counts). */
export function presetRange(preset: RangePreset, nowMs: number): { from: string; to: string } {
  const today = bangkokDate(nowMs);
  const back = (days: number) => bangkokDate(nowMs - days * DAY);
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday':
      return { from: back(1), to: back(1) };
    case 'last7':
      return { from: back(6), to: today };
    case 'last30':
      return { from: back(29), to: today };
    case 'month':
      return { from: `${today.slice(0, 8)}01`, to: today };
  }
}

const baht = (satang: Satang): string => {
  const sign = satang < 0 ? '-' : '';
  const abs = Math.abs(satang);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
};

/** One section as CSV. Amounts are plain decimals in baht (no symbol), so a spreadsheet can add them up. */
export function reportCsv(report: SalesReport, section: ReportSection): string {
  switch (section) {
    case 'days':
      return toCsv(
        ['date', 'bills', 'payable_thb'],
        report.byDay.map((d) => [d.date, d.bills, baht(d.payable)]),
      );
    case 'hours':
      return toCsv(
        ['hour', 'bills', 'payable_thb'],
        report.byHour.map((h) => [
          `${String(h.hour).padStart(2, '0')}:00`,
          h.bills,
          baht(h.payable),
        ]),
      );
    case 'tenders':
      return toCsv(
        ['tender', 'bills', 'amount_thb'],
        report.byTender.map((x) => [x.tender, x.bills, baht(x.amount)]),
      );
    case 'items':
      return toCsv(
        ['item_th', 'item_en', 'quantity', 'revenue_thb'],
        report.byItem.map((x) => [x.nameTh, x.nameEn, x.quantity, baht(x.revenue)]),
      );
    case 'staff':
      return toCsv(
        ['staff', 'bills', 'payable_thb'],
        report.byStaff.map((x) => [x.name, x.bills, baht(x.payable)]),
      );
    case 'stores':
      return toCsv(
        ['shop', 'bills', 'payable_thb'],
        report.byStore.map((x) => [x.name, x.bills, baht(x.payable)]),
      );
  }
}
