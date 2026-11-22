import { parseDeliveryReport } from './delivery.js';
import type { DeliveryReportRow } from './delivery.js';
import { parseTurnover } from './growth.js';
import type { TurnoverRow } from './growth.js';
import { parseKpi } from './kpi.js';
import type { Kpi } from './kpi.js';
import type { Satang } from './money.js';

/**
 * "Ask my shop" and the newer modules: besides sales, the owner can ask about promotions, stamp cards, tables, delivery, tours, waste and speed.
 * Every figure still comes from SQL (the report functions read with the person's own token); this file only reads their answers into a
 * second figures section and lists the numbers it holds, so the answer checker (`unverifiedNumbers`) covers it too.
 * A section whose module is off (the report function answers an error) is simply left out.
 */
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export type PromotionUseRow = { name: string; bills: number; lines: number; given: Satang };
export function parsePromotionUse(v: unknown): PromotionUseRow[] {
  if (!Array.isArray(v)) return [];
  return v.map(obj).map((o) => ({
    name: str(o.name),
    bills: num(o.bills),
    lines: num(o.lines),
    given: num(o.given),
  }));
}
export type StampsFigures = {
  stampsGiven: number;
  rewardsUsed: number;
  rewardValue: Satang;
  passesSold: number;
  passesActive: number;
};
export function parseStampsFigures(v: unknown): StampsFigures {
  const o = obj(v);
  return {
    stampsGiven: num(o.stamps_given),
    rewardsUsed: num(o.rewards_used),
    rewardValue: num(o.reward_value),
    passesSold: num(o.passes_sold),
    passesActive: num(o.passes_active),
  };
}
export type ToursFigures = {
  bookings: number;
  seats: number;
  online: number;
  noShows: number;
  cancelled: number;
  depositDue: Satang;
  depositReceived: Satang;
};
/** Tour bookings made in the period (rows of `tour_bookings`, as the shop's staff may read them). */
export function parseToursFigures(v: unknown): ToursFigures {
  const rows = Array.isArray(v) ? v.map(obj) : [];
  const live = rows.filter((r) => r.status !== 'cancelled');
  return {
    bookings: live.length,
    seats: live.reduce((a, r) => a + num(r.seats), 0),
    online: live.filter((r) => r.source === 'online').length,
    noShows: rows.filter((r) => r.status === 'no_show').length,
    cancelled: rows.filter((r) => r.status === 'cancelled').length,
    depositDue: live.reduce((a, r) => a + num(r.deposit_due), 0),
    depositReceived: live.reduce((a, r) => a + num(r.deposit), 0),
  };
}

export type OpsInput = {
  kpi: unknown;
  promotions: unknown;
  stamps: unknown;
  turnover: unknown;
  delivery: unknown;
  tours: unknown;
};
export type OpsFigures = { text: string; allowed: number[] };

const baht = (s: Satang): string => {
  const sign = s < 0 ? '-' : '';
  const a = Math.abs(s);
  const whole = Math.floor(a / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = a % 100;
  return `${sign}${whole}${frac === 0 ? '' : `.${String(frac).padStart(2, '0')}`}`;
};
const min1 = (sec: number): number => Math.round((sec / 60) * 10) / 10;
const bpsPct = (b: number): number => Math.round(b) / 100;

/** `null` for a report that could not be read (module off / no right): that section is left out. */
export function buildOpsFigures(p: Partial<Record<keyof OpsInput, unknown>>): OpsFigures {
  const allowed: number[] = [];
  const addN = (n: number) => void allowed.push(Math.round(n * 100) / 100);
  const addB = (s: Satang) => addN(s / 100);
  const lines: string[] = [];

  if (p.kpi != null) {
    const k: Kpi = parseKpi(p.kpi);
    const parts: string[] = [];
    if (k.orderToKitchenSec != null) {
      parts.push(
        `average time from opening a bill to the first send to the kitchen ${min1(k.orderToKitchenSec)} minutes`,
      );
      addN(min1(k.orderToKitchenSec));
    }
    if (k.prepSec != null) {
      parts.push(`average preparation time ${min1(k.prepSec)} minutes`);
      addN(min1(k.prepSec));
    }
    parts.push(`waste cost ${baht(k.wasteCost)} THB`);
    addB(k.wasteCost);
    parts.push(`${k.stockouts} stock items at or below zero`);
    addN(k.stockouts);
    if (k.noShowRateBps != null) {
      parts.push(`appointment no-show rate ${bpsPct(k.noShowRateBps)}%`);
      addN(bpsPct(k.noShowRateBps));
    }
    if (k.repeatRateBps != null) {
      parts.push(`members who came back ${bpsPct(k.repeatRateBps)}% of identified customers`);
      addN(bpsPct(k.repeatRateBps));
    }
    if (k.feedbackResolutionSec != null) {
      parts.push(`average time to answer a bad feedback ${min1(k.feedbackResolutionSec)} minutes`);
      addN(min1(k.feedbackResolutionSec));
    }
    lines.push(`Operations: ${parts.join('; ')}.`);
  }

  const promos = p.promotions != null ? parsePromotionUse(p.promotions) : null;
  if (promos) {
    lines.push(
      promos.length === 0
        ? 'Promotions: none used in this period.'
        : `Promotions used (discount given):\n${promos
            .slice(0, 8)
            .map((r) => {
              addN(r.bills);
              addN(r.lines);
              addB(r.given);
              return `  - ${r.name}: ${r.bills} bills, ${r.lines} lines, ${baht(r.given)} THB given`;
            })
            .join('\n')}`,
    );
  }

  if (p.stamps != null) {
    const s = parseStampsFigures(p.stamps);
    lines.push(
      `Stamp cards and passes: ${s.stampsGiven} stamps given, ${s.rewardsUsed} free items given (value ${baht(s.rewardValue)} THB), ${s.passesSold} day passes sold, ${s.passesActive} passes active now.`,
    );
    [s.stampsGiven, s.rewardsUsed, s.passesSold, s.passesActive].forEach(addN);
    addB(s.rewardValue);
  }

  const turn: TurnoverRow[] | null = p.turnover != null ? parseTurnover(p.turnover) : null;
  if (turn) {
    lines.push(
      turn.length === 0
        ? 'Tables: no table bills in this period.'
        : `Tables by revenue (average minutes a bill stays open):\n${turn
            .slice(0, 8)
            .map((r) => {
              addN(r.seats);
              addN(r.bills);
              addN(r.avgMin);
              addB(r.revenue);
              addB(r.perHour);
              return `  - ${r.name} (${r.seats} seats): ${r.bills} bills, ${r.avgMin} minutes each, ${baht(r.revenue)} THB, ${baht(r.perHour)} THB per hour`;
            })
            .join('\n')}`,
    );
  }

  const del: DeliveryReportRow[] | null =
    p.delivery != null ? parseDeliveryReport(p.delivery) : null;
  if (del && del.length > 0) {
    lines.push(
      `Delivery platforms:\n${del
        .map((r) => {
          addN(r.bills);
          addB(r.gross);
          addB(r.commission);
          addB(r.net);
          addB(r.owed);
          addN(bpsPct(r.commissionBps));
          return `  - ${r.name}: ${r.bills} bills, sold ${baht(r.gross)} THB, platform kept ${baht(r.commission)} THB (${bpsPct(r.commissionBps)}% commission), shop's share ${baht(r.net)} THB, still owed by the platform (all time) ${baht(r.owed)} THB`;
        })
        .join('\n')}`,
    );
  }

  if (p.tours != null) {
    const t = parseToursFigures(p.tours);
    if (t.bookings + t.cancelled + t.noShows > 0) {
      lines.push(
        `Tour bookings made in this period: ${t.bookings} bookings with ${t.seats} seats (${t.online} of them online), ${t.cancelled} cancelled, ${t.noShows} no-shows; deposits due ${baht(t.depositDue)} THB, received ${baht(t.depositReceived)} THB.`,
      );
      [t.bookings, t.seats, t.online, t.cancelled, t.noShows].forEach(addN);
      addB(t.depositDue);
      addB(t.depositReceived);
    }
  }

  return { text: lines.join('\n'), allowed };
}
