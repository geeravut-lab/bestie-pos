import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { MODULE_BY_ID } from './modules/registry';
import { folioBalance, parseFolioCharges, parseFolioRooms, parseStays, stayLabel } from './folio';
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
