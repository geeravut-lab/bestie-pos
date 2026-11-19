import { toCsv } from './csv';
import type { Satang } from './money';
import type { SalesReport } from './reportRead';

export * from './reportRead';

export type ReportSection = 'days' | 'hours' | 'tenders' | 'items' | 'staff' | 'stores';

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
