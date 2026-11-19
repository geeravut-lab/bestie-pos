import { localizedName } from '@bestie/core';
import type { LineDoc, OrderDoc, TicketStation } from '@bestie/core';
import { dict, fmt } from '@bestie/i18n';
import type { ReceiptRow } from './rows';

const CLOCK = new Intl.DateTimeFormat('th-TH', {
  timeZone: 'Asia/Bangkok',
  hour: '2-digit',
  minute: '2-digit',
});

/**
 * One kitchen / bar ticket as rows. Always THAI (the kitchen reads Thai, CLAUDE.md rule 8): station, bill, table / channel, the
 * time it was sent, then each line big, with its options, seat and note. No prices.
 */
export function buildTicketRows(p: {
  station: TicketStation;
  order: OrderDoc;
  lines: readonly LineDoc[];
  tableName?: string | null;
  sentAt?: string | null;
}): ReceiptRow[] {
  const d = dict.th;
  const channelKey = `ticketChannel_${p.order.channel.replace('-', '_')}`;
  const where = p.tableName
    ? fmt(d.ticketTable, { name: p.tableName })
    : ((d as Record<string, string>)[channelKey] ?? p.order.channel);
  const rows: ReceiptRow[] = [
    {
      kind: 'center',
      text: (d as Record<string, string>)[`ticketTitle_${p.station}`] ?? p.station,
      strong: true,
      big: true,
    },
    { kind: 'center', text: fmt(d.ticketOrder, { number: p.order.number }), strong: true },
    { kind: 'center', text: where, strong: true, big: true },
  ];
  const at = p.sentAt ?? p.lines.find((l) => l.sentAt)?.sentAt ?? null;
  if (at)
    rows.push({ kind: 'center', text: fmt(d.ticketTime, { time: CLOCK.format(new Date(at)) }) });
  rows.push({ kind: 'rule' });
  for (const l of p.lines) {
    const subs: string[] = [];
    if (l.modifiers.length > 0)
      subs.push(l.modifiers.map((m) => localizedName(m.name, 'th')).join(', '));
    if (l.seat) subs.push(fmt(d.ticketSeat, { n: l.seat }));
    if (l.note) subs.push(fmt(d.ticketNote, { note: l.note }));
    rows.push({
      kind: 'row',
      left: `${l.quantity} × ${localizedName(l.name, 'th')}`,
      right: '',
      strong: true,
      ...(subs.length > 0 ? { sub: subs.join(' · ') } : {}),
    });
  }
  rows.push({ kind: 'rule' });
  return rows;
}
