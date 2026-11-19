/**
 * Receipt printing, the pure part (no DOM, no devices): what a printer is, which one a till uses, how a picture of the receipt
 * becomes ESC/POS bytes or a one-page PDF.
 *
 * Why a PICTURE and not text: thermal printers differ in Thai code pages, and a few cannot print Thai at all. A raster of the
 * receipt (drawn by the browser with the app's own Thai font) prints the same on every ESC/POS printer and as a PDF.
 *
 * Printers are DATA (docs/CLAUDE.md rule 5): the shop's list lives in `stores.printers`, the shop default in `stores.default_printer`,
 * and each tablet may pick its own default (kept on the tablet). Two printers always exist and need no setup: `pdf` (a PDF file —
 * the default when nothing else is chosen) and `browser` (the browser's print dialog).
 */

export const PRINTER_KINDS = ['usb', 'serial', 'bluetooth', 'network'] as const;
export type CustomPrinterKind = (typeof PRINTER_KINDS)[number];
export type PrinterKind = 'pdf' | 'browser' | CustomPrinterKind;
export const PAPER_MM = [58, 80] as const;
export type PaperMm = (typeof PAPER_MM)[number];

/** Kitchen stations a printer can print order tickets for (the menu item's station is the routing rule, like on the KDS). */
export const TICKET_STATIONS = ['kitchen', 'bar'] as const;
export type TicketStation = (typeof TICKET_STATIONS)[number];

export type Printer = {
  id: string;
  name: string;
  kind: PrinterKind;
  paperMm: PaperMm;
  /** Cut the paper after the receipt (a printer without a cutter ignores it). */
  cutter: boolean;
  /** Open the cash drawer connected to this printer after printing. */
  drawer: boolean;
  /** network: where the print bridge listens (browsers cannot open a raw TCP connection to a printer themselves). */
  bridgeUrl?: string;
  /** serial: baud rate (most receipt printers: 9600 or 115200). */
  baud?: number;
  /** bluetooth: GATT service of the printer (blank = look for a writable one). */
  service?: string;
  /** Kitchen / bar tickets printed here when staff send an order (absent or empty = a receipt printer only). */
  stations?: readonly TicketStation[];
};

export const BUILT_IN_PRINTERS: readonly Printer[] = [
  { id: 'pdf', name: 'PDF', kind: 'pdf', paperMm: 80, cutter: false, drawer: false },
  { id: 'browser', name: 'Browser', kind: 'browser', paperMm: 80, cutter: false, drawer: false },
];
export const DEFAULT_PRINTER_ID = 'pdf';
export const MAX_PRINTERS = 10;

/** Dots across the paper: 58 mm → 384, 80 mm → 576 (203 dpi, a multiple of 8 as ESC/POS rasters need). */
export const dotsFor = (paper: PaperMm): number => (paper === 58 ? 384 : 576);

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const UUIDISH = /^[0-9a-f]{4,8}(-[0-9a-f]{4}){0,4}$/i;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

export type PrinterProblem =
  'id' | 'name' | 'kind' | 'paper' | 'bridge' | 'baud' | 'service' | 'stations' | 'duplicate';

export function printerProblems(p: Printer): PrinterProblem[] {
  const out: PrinterProblem[] = [];
  if (!ID.test(p.id) || p.id === 'pdf' || p.id === 'browser') out.push('id');
  if (p.name.trim().length < 1 || p.name.length > 40) out.push('name');
  if (!(PRINTER_KINDS as readonly string[]).includes(p.kind)) out.push('kind');
  if (!(PAPER_MM as readonly number[]).includes(p.paperMm)) out.push('paper');
  if (p.kind === 'network' && !/^https?:\/\/[^\s]{1,190}$/.test(p.bridgeUrl ?? ''))
    out.push('bridge');
  if (
    p.kind === 'serial' &&
    p.baud !== undefined &&
    !(Number.isInteger(p.baud) && p.baud >= 1200 && p.baud <= 921600)
  )
    out.push('baud');
  if (p.service !== undefined && p.service !== '' && !UUIDISH.test(p.service)) out.push('service');
  if (
    p.stations !== undefined &&
    !p.stations.every((x) => (TICKET_STATIONS as readonly string[]).includes(x))
  )
    out.push('stations');
  return out;
}

/** Reads `stores.printers`: a damaged entry is dropped, never allowed to break the screen. */
export function parsePrinters(raw: unknown): Printer[] {
  if (!Array.isArray(raw)) return [];
  const out: Printer[] = [];
  const seen = new Set<string>();
  for (const e of raw.slice(0, MAX_PRINTERS)) {
    if (!isRecord(e)) continue;
    const p: Printer = {
      id: String(e.id ?? ''),
      name: String(e.name ?? '').trim(),
      kind: e.kind as PrinterKind,
      paperMm: e.paper === 58 ? 58 : 80,
      cutter: e.cutter !== false,
      drawer: e.drawer === true,
      ...(typeof e.bridge_url === 'string' ? { bridgeUrl: e.bridge_url } : {}),
      ...(typeof e.baud === 'number' ? { baud: e.baud } : {}),
      ...(typeof e.service === 'string' && e.service !== '' ? { service: e.service } : {}),
      ...(Array.isArray(e.stations) && e.stations.length > 0
        ? {
            stations: TICKET_STATIONS.filter((x) => (e.stations as unknown[]).includes(x)),
          }
        : {}),
    };
    if (printerProblems(p).length === 0 && !seen.has(p.id)) {
      seen.add(p.id);
      out.push(p);
    }
  }
  return out;
}

/** The column shape (what the database stores). */
export const printersToColumn = (list: readonly Printer[]): Record<string, unknown>[] =>
  list.map((p) => ({
    id: p.id,
    name: p.name.trim(),
    kind: p.kind,
    paper: p.paperMm,
    cutter: p.cutter,
    drawer: p.drawer,
    ...(p.bridgeUrl ? { bridge_url: p.bridgeUrl } : {}),
    ...(p.baud !== undefined ? { baud: p.baud } : {}),
    ...(p.service ? { service: p.service } : {}),
    ...(p.stations && p.stations.length > 0 ? { stations: [...p.stations] } : {}),
  }));

/** A new id from a name: letters / digits / dashes, unique among the given ids. */
export function newPrinterId(name: string, taken: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'printer';
  let id = base;
  for (let n = 2; taken.includes(id) || id === 'pdf' || id === 'browser'; n++) id = `${base}-${n}`;
  return id;
}

/** All printers a tablet can use: the two built-ins, then the shop's own. */
export const allPrinters = (custom: readonly Printer[]): Printer[] => [
  ...BUILT_IN_PRINTERS,
  ...custom,
];

/**
 * Which printer a tablet prints on: its own choice, else the shop's default, else the PDF. A choice that points at a printer that no
 * longer exists is ignored (a deleted printer must never leave a tablet unable to print).
 */
export function resolvePrinter(
  custom: readonly Printer[],
  tabletChoice: string | null,
  shopDefault: string | null,
): Printer {
  const list = allPrinters(custom);
  const find = (id: string | null) => (id ? list.find((p) => p.id === id) : undefined);
  return find(tabletChoice) ?? find(shopDefault) ?? list.find((p) => p.id === DEFAULT_PRINTER_ID)!;
}

// ── ESC/POS ─────────────────────────────────────────────────────────────────
/** 1 bit per dot, black = 1, rows padded to whole bytes. Transparent pixels count as white paper. */
export function imageToBits(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  threshold = 160,
): { bytesPerRow: number; data: Uint8Array } {
  const bytesPerRow = Math.ceil(width / 8);
  const data = new Uint8Array(bytesPerRow * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = (rgba[i + 3] ?? 255) / 255;
      const gray =
        0.299 * ((rgba[i] ?? 255) * a + 255 * (1 - a)) +
        0.587 * ((rgba[i + 1] ?? 255) * a + 255 * (1 - a)) +
        0.114 * ((rgba[i + 2] ?? 255) * a + 255 * (1 - a));
      if (gray < threshold) data[y * bytesPerRow + (x >> 3)]! |= 0x80 >> (x & 7);
    }
  }
  return { bytesPerRow, data };
}

const ESC = 0x1b;
const GS = 0x1d;
export const RASTER_CHUNK_ROWS = 128; // small slices: cheap printers have small buffers

/** Bytes that print one receipt picture: init, raster slices, feed, optional cut and drawer pulse. */
export function escposReceipt(
  bits: { bytesPerRow: number; data: Uint8Array },
  heightDots: number,
  opts: { cutter: boolean; drawer: boolean; feedLines?: number } = { cutter: true, drawer: false },
): Uint8Array {
  const parts: number[] = [ESC, 0x40]; // initialise
  for (let y = 0; y < heightDots; y += RASTER_CHUNK_ROWS) {
    const rows = Math.min(RASTER_CHUNK_ROWS, heightDots - y);
    parts.push(
      GS,
      0x76,
      0x30,
      0x00,
      bits.bytesPerRow & 0xff,
      bits.bytesPerRow >> 8,
      rows & 0xff,
      rows >> 8,
    );
    const slice = bits.data.subarray(y * bits.bytesPerRow, (y + rows) * bits.bytesPerRow);
    for (const b of slice) parts.push(b);
  }
  parts.push(ESC, 0x64, opts.feedLines ?? 4); // feed
  if (opts.cutter) parts.push(GS, 0x56, 0x42, 0x00); // partial cut
  if (opts.drawer) parts.push(ESC, 0x70, 0x00, 0x19, 0xfa); // pulse pin 2
  return Uint8Array.from(parts);
}

/** Bytes that only open the cash drawer. */
export const escposDrawerPulse = (): Uint8Array =>
  Uint8Array.from([ESC, 0x40, ESC, 0x70, 0x00, 0x19, 0xfa]);

// ── PDF ─────────────────────────────────────────────────────────────────────
const enc = new TextEncoder();
const concat = (chunks: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
};

/**
 * A one-page PDF whose page is exactly the receipt picture (a JPEG): page width = the paper width, height follows the picture.
 * Hand-written (no dependency): Catalog, Pages, Page, the image, its drawing instruction, a cross-reference table.
 */
export function receiptPdf(args: {
  jpeg: Uint8Array;
  widthPx: number;
  heightPx: number;
  paperMm: PaperMm;
  title?: string;
}): Uint8Array {
  const wPt = Math.round(((args.paperMm * 72) / 25.4) * 100) / 100;
  const hPt = Math.round(((wPt * args.heightPx) / args.widthPx) * 100) / 100;
  const content = enc.encode(`q ${wPt} 0 0 ${hPt} 0 0 cm /Im0 Do Q`);
  const title = (args.title ?? 'Receipt').replace(/[^\x20-\x7e]/g, '').replace(/[()\\]/g, '');
  const objects: Uint8Array[][] = [
    [enc.encode('<< /Type /Catalog /Pages 2 0 R >>')],
    [enc.encode('<< /Type /Pages /Kids [3 0 R] /Count 1 >>')],
    [
      enc.encode(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt} ${hPt}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`,
      ),
    ],
    [
      enc.encode(
        `<< /Type /XObject /Subtype /Image /Width ${args.widthPx} /Height ${args.heightPx} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${args.jpeg.length} >>\nstream\n`,
      ),
      args.jpeg,
      enc.encode('\nendstream'),
    ],
    [enc.encode(`<< /Length ${content.length} >>\nstream\n`), content, enc.encode('\nendstream')],
    [enc.encode(`<< /Title (${title}) /Producer (Bestie POS) >>`)],
  ];
  const out: Uint8Array[] = [enc.encode('%PDF-1.4\n')];
  const offsets: number[] = [];
  let pos = out[0]!.length;
  objects.forEach((parts, i) => {
    offsets.push(pos);
    const chunk = concat([enc.encode(`${i + 1} 0 obj\n`), ...parts, enc.encode('\nendobj\n')]);
    out.push(chunk);
    pos += chunk.length;
  });
  const xrefAt = pos;
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  out.push(enc.encode(xref));
  return concat(out);
}
