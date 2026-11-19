import { describe, expect, it } from 'vitest';
import { lastSentLines, ticketsFor } from './kitchenTicket';
import type { LineDoc } from './orders';
import { parsePrinters, printerProblems, printersToColumn } from './printing';
import type { Printer } from './printing';

const line = (id: string, station: LineDoc['station'], over: Partial<LineDoc> = {}): LineDoc => ({
  id,
  itemId: null,
  name: { th: id },
  unitPrice: 1000,
  quantity: 1,
  modifiers: [],
  note: null,
  station,
  status: 'sent',
  seat: null,
  voidReason: null,
  sentAt: '2026-11-19T05:00:00.000Z',
  createdBy: null,
  ...over,
});
const pr = (id: string, stations?: Printer['stations']): Printer => ({
  id,
  name: id,
  kind: 'network',
  paperMm: 80,
  cutter: true,
  drawer: false,
  bridgeUrl: 'http://192.168.1.9:9101',
  ...(stations ? { stations } : {}),
});

describe('ticketsFor', () => {
  it('one ticket per station that has a printer, with only that station’s lines', () => {
    const t = ticketsFor(
      [line('a', 'kitchen'), line('b', 'bar'), line('c', 'kitchen')],
      [pr('hot', ['kitchen']), pr('drinks', ['bar'])],
    );
    expect(t.map((x) => [x.printer.id, x.station, x.lines.map((l) => l.id)])).toEqual([
      ['hot', 'kitchen', ['a', 'c']],
      ['drinks', 'bar', ['b']],
    ]);
  });
  it('a line without a station is never printed, a station without a printer prints nothing, a receipt printer is skipped', () => {
    expect(ticketsFor([line('a', null)], [pr('hot', ['kitchen'])])).toEqual([]);
    expect(ticketsFor([line('a', 'bar')], [pr('hot', ['kitchen'])])).toEqual([]);
    expect(ticketsFor([line('a', 'kitchen')], [pr('counter')])).toEqual([]);
  });
  it('two printers for one station both print; voided lines never do', () => {
    const t = ticketsFor(
      [line('a', 'kitchen'), line('v', 'kitchen', { status: 'void' })],
      [pr('one', ['kitchen']), pr('two', ['kitchen', 'bar'])],
    );
    expect(t.map((x) => x.printer.id)).toEqual(['one', 'two']);
    expect(t[0]!.lines.map((l) => l.id)).toEqual(['a']);
  });
});

describe('lastSentLines', () => {
  it('is the latest send only', () => {
    const lines = [
      line('old', 'kitchen', { sentAt: '2026-11-19T04:00:00.000Z' }),
      line('new1', 'kitchen'),
      line('new2', 'bar'),
      line('unsent', 'kitchen', { status: 'new', sentAt: null }),
    ];
    expect(lastSentLines(lines).map((l) => l.id)).toEqual(['new1', 'new2']);
    expect(lastSentLines([line('u', 'kitchen', { sentAt: null })])).toEqual([]);
  });
});

describe('printer stations are data', () => {
  it('round-trip through the column shape; unknown stations are dropped', () => {
    const col = printersToColumn([pr('hot', ['kitchen', 'bar'])]);
    expect(col[0]!.stations).toEqual(['kitchen', 'bar']);
    expect(parsePrinters(col)[0]!.stations).toEqual(['kitchen', 'bar']);
    const parsed = parsePrinters([{ ...col[0]!, stations: ['bar', 'freezer'] }]);
    expect(parsed[0]!.stations).toEqual(['bar']);
    expect(parsePrinters([{ ...col[0]!, stations: [] }])[0]!.stations).toBeUndefined();
    expect(printerProblems({ ...pr('x'), stations: ['freezer' as never] })).toContain('stations');
  });
});
