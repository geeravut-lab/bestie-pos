/** A kitchen / bar ticket queued by the server (guest QR orders it sent to the kitchen itself), read defensively. */
export type PrintJobLine = {
  quantity: number;
  nameTh: string;
  modifiers: string[];
  seat: number | null;
  note: string | null;
};
export type PrintJob = {
  id: string;
  station: 'kitchen' | 'bar';
  printerId: string;
  orderNumber: string;
  tableName: string | null;
  sentAt: string;
  lines: PrintJobLine[];
};

const isRec = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

export function parsePrintJobs(raw: unknown): PrintJob[] {
  if (!Array.isArray(raw)) return [];
  const out: PrintJob[] = [];
  for (const j of raw.slice(0, 50)) {
    if (!isRec(j) || typeof j.id !== 'string' || typeof j.printer_id !== 'string') continue;
    if (j.station !== 'kitchen' && j.station !== 'bar') continue;
    const lines: PrintJobLine[] = (Array.isArray(j.lines) ? j.lines : [])
      .filter(isRec)
      .map((l) => ({
        quantity: typeof l.quantity === 'number' && l.quantity > 0 ? Math.round(l.quantity) : 1,
        nameTh: typeof l.name_th === 'string' ? l.name_th.slice(0, 120) : '',
        modifiers: Array.isArray(l.modifiers)
          ? l.modifiers.filter((m): m is string => typeof m === 'string' && m !== '').slice(0, 20)
          : [],
        seat: typeof l.seat === 'number' ? l.seat : null,
        note: typeof l.note === 'string' && l.note !== '' ? l.note.slice(0, 200) : null,
      }));
    if (lines.length === 0) continue;
    out.push({
      id: j.id,
      station: j.station,
      printerId: j.printer_id,
      orderNumber: typeof j.order_number === 'string' ? j.order_number : '',
      tableName: typeof j.table_name === 'string' && j.table_name !== '' ? j.table_name : null,
      sentAt: typeof j.sent_at === 'string' ? j.sent_at : '',
      lines,
    });
  }
  return out;
}
