import { parsePrintJobs } from '@bestie/core';
import type { Printer } from '@bestie/core';
import type { PageContext } from '@bestie/auth';
import { browserDeps } from './browser';
import type { PrintDeps } from './print';
import { printPicture } from './print';
import type { ReceiptRow } from './rows';
import { buildJobTicketRows } from './ticketRows';

export type StationResult = { jobId: string; orderNumber: string; printer: Printer; ok: boolean };

/**
 * One round of a "print station" screen: claim the tickets queued for the printers this screen serves, print each on its printer, and
 * report the result (failed ones go back to the queue, 3 tries). Never throws: a failing printer or a lost connection is a result.
 */
export async function printStationTick(p: {
  client: PageContext['client'];
  storeId: string;
  served: readonly Printer[];
  deps?: (rows: ReceiptRow[]) => PrintDeps;
}): Promise<StationResult[]> {
  if (p.served.length === 0) return [];
  let jobs;
  try {
    const r = await p.client.rpc('claim_print_jobs', {
      p_store: p.storeId,
      p_printers: p.served.map((x) => x.id),
      p_limit: 5,
    });
    if (r.error) return [];
    jobs = parsePrintJobs(r.data);
  } catch {
    return [];
  }
  const out: StationResult[] = [];
  for (const job of jobs) {
    const printer = p.served.find((x) => x.id === job.printerId);
    if (!printer) continue;
    let ok: boolean;
    try {
      await printPicture(
        { ...printer, drawer: false },
        `ticket-${job.orderNumber}-${job.station}`,
        (p.deps ?? browserDeps)(buildJobTicketRows(job)),
      );
      ok = true;
    } catch {
      ok = false;
    }
    try {
      await p.client.rpc('report_print_job', { p_job: job.id, p_ok: ok });
    } catch {
      /* the claim expires after 60 s and the job comes back */
    }
    out.push({ jobId: job.id, orderNumber: job.orderNumber, printer, ok });
  }
  return out;
}
