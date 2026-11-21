import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { MODULE_BY_ID } from './modules/registry';
import {
  folioBalance,
  folioNights,
  parseFolioCharges,
  parseFolioRooms,
  parseStays,
  statementLines,
  stayLabel,
} from './folio';
import { DEFAULT_ROUNDING } from './rounding';

describe('folio helpers', () => {
  it('reads rooms in numeric order', () => {
    const r = parseFolioRooms([
      { id: 'b', store_id: 's', name: '102', sort: 0 },
      { id: 'a', store_id: 's', name: '9', sort: 0 },
      { name: 'no id' },
    ]);
    expect(r.map((x) => x.name)).toEqual(['9', '102']);
  });
  it('reads stays and drops broken rows', () => {
    const s = parseStays([
      { id: '1', room_id: 'r', guest_name: 'Anna', status: 'open', check_in_at: 'x' },
      { id: '2' },
    ]);
    expect(s).toHaveLength(1);
    expect(stayLabel('101', s[0]!)).toBe('101 · Anna');
  });
  it('sums only the charges that were not taken off', () => {
    const c = parseFolioCharges([
      { id: 'a', folio_id: 'f', amount: 21000, created_at: '2026-01-01T10:00:00Z' },
      { id: 'b', folio_id: 'f', amount: '9000', created_at: '2026-01-01T11:00:00Z' },
      {
        id: 'c',
        folio_id: 'f',
        amount: 5000,
        voided_at: '2026-01-01T12:00:00Z',
        void_reason: 'wrong room',
        created_at: '2026-01-01T12:00:00Z',
      },
      { id: 'd', folio_id: 'f', amount: 0 },
    ]);
    expect(c.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(folioBalance(c)).toBe(30000);
  });
  it('knows the room tender and keeps the module on the Resort plan', () => {
    expect(DEFAULT_ROUNDING.room).toBe('none');
    expect(MODULE_BY_ID.folio.plan).toBe('resort');
    expect(MODULE_BY_ID.folio.defaultProfiles).toEqual(['resort']);
    const dir = new URL('../../../supabase/migrations/', import.meta.url);
    const sql = readFileSync(new URL('20261119029000_folio.sql', dir), 'utf8');
    expect(sql).toContain("s.plan = 'resort'");
    expect(sql).toContain("'room')");
  });
});

describe('folio v2: nights and returns', () => {
  const base = { folio_id: 'f1', store_id: 's', created_at: '2026-11-20T00:00:00Z' };
  it('reads night, bill and return lines and drops impossible ones', () => {
    const lines = parseFolioCharges([
      { ...base, id: 'n', kind: 'night', night_date: '2026-11-19', amount: 150000 },
      { ...base, id: 'b', kind: 'bill', order_id: 'o1', amount: 21000 },
      { ...base, id: 'r', kind: 'return', amount: -21000 },
      { ...base, id: 'bad1', kind: 'return', amount: 5 },
      { ...base, id: 'bad2', kind: 'night', amount: -5 },
      { ...base, id: 'zero', kind: 'bill', amount: 0 },
    ]);
    expect(lines.map((l) => l.id).sort()).toEqual(['b', 'n', 'r']);
    expect(folioBalance(lines)).toBe(150000);
    expect(folioNights(lines)).toBe(1);
  });
  it('orders a statement: nights by date, then bills and returns as they happened', () => {
    const lines = parseFolioCharges([
      {
        ...base,
        id: 'b',
        kind: 'bill',
        order_id: 'o',
        amount: 1,
        created_at: '2026-11-19T05:00:00Z',
      },
      { ...base, id: 'n2', kind: 'night', night_date: '2026-11-19', amount: 5 },
      {
        ...base,
        id: 'n1',
        kind: 'night',
        night_date: '2026-11-18',
        amount: 5,
        created_at: '2026-11-21T00:00:00Z',
      },
      { ...base, id: 'r', kind: 'return', amount: -1, created_at: '2026-11-19T06:00:00Z' },
    ]);
    expect(statementLines(lines).map((l) => l.id)).toEqual(['n1', 'n2', 'b', 'r']);
  });
  it('does not count a night that was taken off', () => {
    const lines = parseFolioCharges([
      {
        ...base,
        id: 'n',
        kind: 'night',
        night_date: '2026-11-19',
        amount: 5,
        voided_at: '2026-11-20T00:00:00Z',
        void_reason: 'moved',
      },
    ]);
    expect(folioNights(lines)).toBe(0);
    expect(folioBalance(lines)).toBe(0);
  });
  it('reads the rate of a room and a stay', () => {
    expect(parseFolioRooms([{ id: 'r', name: '1', night_rate: 90000 }])[0]!.nightRate).toBe(90000);
    expect(parseFolioRooms([{ id: 'r', name: '1' }])[0]!.nightRate).toBeNull();
    expect(
      parseStays([{ id: 's', room_id: 'r', guest_name: 'A', night_rate: 5 }])[0]!.nightRate,
    ).toBe(5);
  });
});
