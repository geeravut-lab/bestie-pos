import { allPrinters, lastSentLines, parsePrinters, ticketsFor } from '@bestie/core';
import type { LineDoc, OrderDoc, Printer } from '@bestie/core';
import type { PageContext } from '@bestie/auth';
import { browserDeps } from './browser';
import type { PrintDeps } from './print';
import { printPicture } from './print';
import { buildTicketRows } from './ticketRows';
import type { ReceiptRow } from './rows';

export type TicketResult = { printer: Printer; ok: boolean };

const cacheKey = (storeId: string) => `bestie-printers:${storeId}`;
type Cache = { printers?: unknown; default_printer?: string | null };
const readCache = (storeId: string): Cache => {
  try {
    return (
      (JSON.parse(globalThis.localStorage?.getItem(cacheKey(storeId)) ?? 'null') as Cache | null) ??
      {}
    );
  } catch {
    return {};
  }
};

/** The shop's printers that print kitchen / bar tickets: read now when online (and remembered), else the last good copy. */
export async function ticketPrinters(client: PageContext['client'], storeId: string) {
  let raw: unknown;
  try {
    const r = await client.from('stores').select('printers').eq('id', storeId).maybeSingle();
    if (!r.error && r.data) {
      raw = (r.data as { printers?: unknown }).printers;
      if (raw !== undefined)
        try {
          globalThis.localStorage?.setItem(
            cacheKey(storeId),
            JSON.stringify({ ...readCache(storeId), printers: raw }),
          );
        } catch {
          /* storage unavailable: nothing to remember */
        }
    }
  } catch {
    /* offline */
  }
  if (raw === undefined) raw = readCache(storeId).printers;
  return allPrinters(parsePrinters(raw)).filter((p) => (p.stations?.length ?? 0) > 0);
}

/**
 * Print one ticket per station for the given lines on the shop's ticket printers. Never throws: a printer that fails is reported
 * (`ok: false`) so the order is never held up by a paper jam. The cash drawer is never opened for a ticket.
 */
export async function printTickets(p: {
  order: OrderDoc;
  lines: readonly LineDoc[];
  printers: readonly Printer[];
  tableName?: string | null;
  deps?: (rows: ReceiptRow[]) => PrintDeps;
}): Promise<TicketResult[]> {
  const results: TicketResult[] = [];
  for (const t of ticketsFor(p.lines, p.printers)) {
    const rows = buildTicketRows({
      station: t.station,
      order: p.order,
      lines: t.lines,
      tableName: p.tableName,
    });
    try {
      await printPicture(
        { ...t.printer, drawer: false },
        `ticket-${p.order.number}-${t.station}`,
        (p.deps ?? browserDeps)(rows),
      );
      results.push({ printer: t.printer, ok: true });
    } catch {
      results.push({ printer: t.printer, ok: false });
    }
  }
  return results;
}

/** The lines of the latest send, for "print the ticket again". */
export const latestTicketLines = (order: OrderDoc): LineDoc[] => lastSentLines(order.lines);
