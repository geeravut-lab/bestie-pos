import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_PRINTERS,
  dotsFor,
  escposDrawerPulse,
  escposReceipt,
  imageToBits,
  newPrinterId,
  parsePrinters,
  printerProblems,
  printersToColumn,
  receiptPdf,
  resolvePrinter,
} from './printing';
import type { Printer } from './printing';

const usb: Printer = {
  id: 'counter',
  name: 'Counter',
  kind: 'usb',
  paperMm: 80,
  cutter: true,
  drawer: false,
};
const net: Printer = {
  id: 'kitchen',
  name: 'Kitchen',
  kind: 'network',
  paperMm: 58,
  cutter: false,
  drawer: false,
  bridgeUrl: 'http://192.168.1.50:9101',
};

describe('printer configuration', () => {
  it('dots across the paper are a multiple of 8', () => {
    expect(dotsFor(58)).toBe(384);
    expect(dotsFor(80)).toBe(576);
    expect(dotsFor(58) % 8).toBe(0);
  });
  it('reads the database shape, drops damaged or duplicate entries, caps the list', () => {
    const raw = [
      { id: 'counter', name: ' Counter ', kind: 'usb', paper: 80, cutter: true },
      { id: 'counter', name: 'Dup', kind: 'usb', paper: 80 },
      { id: 'x', name: '', kind: 'usb' },
      { id: 'net1', name: 'Net', kind: 'network', paper: 58, bridge_url: 'not a url' },
      { id: 'net2', name: 'Net', kind: 'network', paper: 58, bridge_url: 'http://10.0.0.5:9101' },
      { id: 'pdf', name: 'Fake', kind: 'usb' },
      { id: 'bad kind', name: 'Z', kind: 'laser' },
      'junk',
      null,
    ];
    const list = parsePrinters(raw);
    expect(list.map((p) => p.id)).toEqual(['counter', 'net2']);
    expect(list[0]!.name).toBe('Counter');
    expect(list[1]).toMatchObject({ bridgeUrl: 'http://10.0.0.5:9101', paperMm: 58 });
    expect(parsePrinters(null)).toEqual([]);
    expect(
      parsePrinters(Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, name: 'P', kind: 'usb' })))
        .length,
    ).toBe(10);
  });
  it('round-trips through the column shape', () => {
    expect(parsePrinters(printersToColumn([usb, net]))).toEqual([usb, net]);
  });
  it('validates: network needs a bridge URL, serial a sane baud, built-in ids are reserved', () => {
    expect(printerProblems({ ...net, bridgeUrl: undefined })).toContain('bridge');
    expect(printerProblems({ ...usb, kind: 'serial', baud: 5 })).toContain('baud');
    expect(printerProblems({ ...usb, kind: 'serial', baud: 115200 })).toEqual([]);
    expect(printerProblems({ ...usb, id: 'pdf' })).toContain('id');
    expect(printerProblems({ ...usb, name: ' ' })).toContain('name');
    expect(printerProblems({ ...usb, service: 'zzz' })).toContain('service');
  });
  it('new ids come from the name and never clash', () => {
    expect(newPrinterId('Front Counter 80mm', [])).toBe('front-counter-80mm');
    expect(newPrinterId('Front Counter 80mm', ['front-counter-80mm'])).toBe('front-counter-80mm-2');
    expect(newPrinterId('เครื่องพิมพ์', [])).toBe('printer');
    expect(newPrinterId('PDF', [])).toBe('pdf-2');
  });
});

describe('which printer a tablet uses', () => {
  const custom = [usb, net];
  it('its own choice first, then the shop default, then the PDF', () => {
    expect(resolvePrinter(custom, 'kitchen', 'counter').id).toBe('kitchen');
    expect(resolvePrinter(custom, null, 'counter').id).toBe('counter');
    expect(resolvePrinter(custom, null, null).id).toBe('pdf');
    expect(resolvePrinter([], null, null).id).toBe('pdf');
  });
  it('a choice that points at a deleted printer is ignored, never leaving the tablet without one', () => {
    expect(resolvePrinter([usb], 'gone', 'counter').id).toBe('counter');
    expect(resolvePrinter([usb], 'gone', 'also-gone').id).toBe('pdf');
  });
  it('PDF and the browser are always available', () => {
    expect(BUILT_IN_PRINTERS.map((p) => p.id)).toEqual(['pdf', 'browser']);
    expect(resolvePrinter([], 'browser', null).kind).toBe('browser');
  });
});

describe('imageToBits', () => {
  it('packs 8 dots per byte, black = 1, most significant bit on the left', () => {
    // 8x1: B W B W B W B W
    const px = [0, 255].flatMap((v) => [v, v, v, 255]);
    const rgba = Array.from({ length: 8 }, (_, i) => px.slice((i % 2) * 4, (i % 2) * 4 + 4)).flat();
    const bits = imageToBits(rgba, 8, 1);
    expect(bits.bytesPerRow).toBe(1);
    expect([...bits.data]).toEqual([0b10101010]);
  });
  it('pads rows to whole bytes and treats transparent pixels as white paper', () => {
    const rgba = Array.from({ length: 10 }, () => [0, 0, 0, 0]).flat(); // 10 transparent pixels
    const bits = imageToBits(rgba, 10, 1);
    expect(bits.bytesPerRow).toBe(2);
    expect([...bits.data]).toEqual([0, 0]);
  });
});

describe('escposReceipt', () => {
  const bits = { bytesPerRow: 2, data: new Uint8Array(2 * 300).fill(0xff) }; // 16 dots wide, 300 rows
  const bytes = escposReceipt(bits, 300, { cutter: true, drawer: true });
  it('starts with ESC @ and sends the picture in slices with the right sizes', () => {
    expect([...bytes.slice(0, 2)]).toEqual([0x1b, 0x40]);
    // first slice: GS v 0 m xL xH yL yH → 128 rows
    expect([...bytes.slice(2, 10)]).toEqual([0x1d, 0x76, 0x30, 0, 2, 0, 128, 0]);
    // three slices: 128 + 128 + 44 rows
    const heads: number[] = [];
    for (let i = 0; i < bytes.length - 8; i++)
      if (
        bytes[i] === 0x1d &&
        bytes[i + 1] === 0x76 &&
        bytes[i + 2] === 0x30 &&
        bytes[i + 3] === 0 &&
        bytes[i + 4] === 2
      )
        heads.push(bytes[i + 6]!);
    expect(heads.slice(0, 3)).toEqual([128, 128, 44]);
  });
  it('ends with a feed, a cut and a drawer pulse when asked, and nothing extra when not', () => {
    expect([...bytes.slice(-12)]).toEqual([
      0x1b, 0x64, 4, 0x1d, 0x56, 0x42, 0, 0x1b, 0x70, 0, 0x19, 0xfa,
    ]);
    const plain = escposReceipt(bits, 10, { cutter: false, drawer: false, feedLines: 2 });
    expect([...plain.slice(-3)]).toEqual([0x1b, 0x64, 2]);
  });
  it('the drawer pulse alone is a valid command', () => {
    expect([...escposDrawerPulse()]).toEqual([0x1b, 0x40, 0x1b, 0x70, 0, 0x19, 0xfa]);
  });
});

describe('receiptPdf', () => {
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
  const pdf = receiptPdf({
    jpeg,
    widthPx: 576,
    heightPx: 1152,
    paperMm: 80,
    title: 'Receipt A+000001',
  });
  const text = new TextDecoder('latin1').decode(pdf);
  it('is a one-page PDF whose page is the paper width and follows the picture’s height', () => {
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('/Count 1');
    expect(text).toContain('/MediaBox [0 0 226.77 453.54]'); // 80 mm = 226.77 pt, twice as tall
    expect(text).toContain('/Filter /DCTDecode');
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  });
  it('carries the JPEG bytes untouched', () => {
    let found = -1;
    for (let i = 0; i < pdf.length - jpeg.length; i++)
      if (jpeg.every((b, j) => pdf[i + j] === b)) found = i;
    expect(found).toBeGreaterThan(0);
  });
  it('the cross-reference table points at the real objects', () => {
    const start = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(start, start + 4)).toBe('xref');
    const entries = [...text.slice(start).matchAll(/(\d{10}) 00000 n /g)].map((m) => Number(m[1]));
    expect(entries).toHaveLength(6);
    entries.forEach((off, i) =>
      expect(text.slice(off, off + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`),
    );
  });
  it('a title with odd characters cannot break the file', () => {
    const odd = new TextDecoder('latin1').decode(
      receiptPdf({ jpeg, widthPx: 10, heightPx: 10, paperMm: 58, title: 'ใบเสร็จ (A) \\' }),
    );
    expect(odd).toContain('/Title ( A )');
  });
});
