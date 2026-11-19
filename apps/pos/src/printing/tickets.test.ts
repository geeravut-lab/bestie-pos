import { describe, expect, it, vi } from 'vitest';
import { addLine, newOrder, sendNew } from '@bestie/core';
import type { Printer } from '@bestie/core';
import { printTickets } from './kitchenPrint';
import type { Picture } from './print';
import { buildTicketRows } from './ticketRows';

const order = () => {
  let o = newOrder({
    id: 'o1',
    orgId: 'org',
    storeId: 'st',
    number: 'A012',
    channel: 'dine-in',
    tableId: 't1',
    now: Date.parse('2026-11-19T05:00:00Z'),
  });
  const item = (id: string, th: string, station: 'kitchen' | 'bar') => ({
    id,
    name: { th, en: th },
    prices: { base: 8000 },
    station,
  });
  o = addLine(o, {
    lineId: 'l1',
    item: item('i1', 'ผัดไทย', 'kitchen'),
    groups: [
      {
        id: 'g',
        name: { th: 'ไข่' },
        min: 0,
        max: 1,
        options: [{ id: 'o', name: { th: 'ไข่ดาว' }, priceDelta: 1000, channelDelta: {} }],
      },
    ],
    selected: ['o'],
    quantity: 2,
    note: 'ไม่เผ็ด',
    seat: 3,
  });
  o = addLine(o, {
    lineId: 'l2',
    item: item('i2', 'ชาเย็น', 'bar'),
    groups: [],
    selected: [],
    quantity: 1,
  });
  return sendNew(o, Date.parse('2026-11-19T05:00:00Z'));
};
const net = (id: string, stations: Printer['stations']): Printer => ({
  id,
  name: id,
  kind: 'network',
  paperMm: 80,
  cutter: true,
  drawer: true,
  bridgeUrl: `http://10.0.0.${id === 'bar' ? 9 : 4}:9101/print`,
  stations,
});
const pic = (): Picture => ({
  width: 576,
  height: 8,
  rgba: () => new Uint8Array(576 * 8 * 4),
  jpeg: async () => new Uint8Array(),
});

describe('buildTicketRows', () => {
  it('is Thai, shows bill, table, time, big lines with options, seat and note, and no price', () => {
    const { order: o, sent } = order();
    const rows = buildTicketRows({
      station: 'kitchen',
      order: o,
      lines: sent.filter((l) => l.station === 'kitchen'),
      tableName: 'T1',
      sentAt: '2026-11-19T05:00:00.000Z',
    });
    const text = JSON.stringify(rows);
    expect(text).toContain('ครัว');
    expect(text).toContain('บิล A012');
    expect(text).toContain('โต๊ะ T1');
    expect(text).toContain('12:00'); // Bangkok time of 05:00 UTC is 12:00
    expect(text).toContain('2 × ผัดไทย');
    expect(text).toContain('ไข่ดาว');
    expect(text).toContain('ที่นั่ง 3');
    expect(text).toContain('หมายเหตุ: ไม่เผ็ด');
    expect(text).not.toContain('฿');
    expect(text).not.toContain('ชาเย็น'); // the bar line is on the bar ticket
  });
  it('a counter bill says its channel instead of a table', () => {
    const { order: o, sent } = order();
    const rows = buildTicketRows({
      station: 'bar',
      order: { ...o, channel: 'takeaway', tableId: null },
      lines: sent.filter((l) => l.station === 'bar'),
    });
    expect(JSON.stringify(rows)).toContain('ซื้อกลับ');
  });
});

describe('printTickets', () => {
  it('prints one ticket per station on its printer, never opens the drawer, and reports a failing printer without throwing', async () => {
    const { order: o, sent } = order();
    const posted: { url: string; body: Uint8Array }[] = [];
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes('10.0.0.9')) return { ok: false } as Response; // the bar printer refuses
      posted.push({ url: String(url), body: init!.body as Uint8Array });
      return { ok: true } as Response;
    });
    const res = await printTickets({
      order: o,
      lines: sent,
      printers: [net('hot', ['kitchen']), net('bar', ['bar'])],
      tableName: 'T1',
      deps: () => ({
        draw: async () => pic(),
        savePdf: vi.fn(),
        env: { navigator: {}, fetch: fetchImpl as never },
      }),
    });
    expect(res.map((r) => [r.printer.id, r.ok])).toEqual([
      ['hot', true],
      ['bar', false],
    ]);
    expect(posted).toHaveLength(1);
    const bytes = posted[0]!.body;
    // ESC p (open drawer) must not be in a kitchen ticket
    const hasPulse = bytes.some((b, i) => b === 0x1b && bytes[i + 1] === 0x70);
    expect(hasPulse).toBe(false);
  });
  it('nothing to print without a ticket printer', async () => {
    const { order: o, sent } = order();
    expect(await printTickets({ order: o, lines: sent, printers: [] })).toEqual([]);
  });
});
