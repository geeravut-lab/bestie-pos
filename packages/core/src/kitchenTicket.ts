import type { LineDoc } from './orders';
import type { Printer, TicketStation } from './printing';

/**
 * Kitchen / bar tickets: which printer prints which lines. The menu item's station is the routing rule (like the KDS): a line
 * without a station is never printed, a station with no printer prints nothing (the KDS screen still shows it).
 */
export type PrintTicket = { station: TicketStation; printer: Printer; lines: LineDoc[] };

export function ticketsFor(lines: readonly LineDoc[], printers: readonly Printer[]): PrintTicket[] {
  const out: PrintTicket[] = [];
  for (const station of ['kitchen', 'bar'] as const) {
    const mine = lines.filter((l) => l.station === station && l.status !== 'void');
    if (mine.length === 0) continue;
    for (const printer of printers)
      if (printer.stations?.includes(station)) out.push({ station, printer, lines: mine });
  }
  return out;
}

/** The lines of the latest send of an order (the same `sentAt`), for printing a ticket again. */
export function lastSentLines(lines: readonly LineDoc[]): LineDoc[] {
  const at = lines.reduce((m, l) => (l.sentAt && l.sentAt > m ? l.sentAt : m), '');
  return at === '' ? [] : lines.filter((l) => l.sentAt === at && l.status !== 'void');
}
