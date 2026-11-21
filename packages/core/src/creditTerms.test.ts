import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CREDIT_TERMS_VERSION,
  creditGroups,
  creditLiabilityCsv,
  parseCreditEntities,
  parseCreditLiability,
} from './creditTerms';

describe('credit terms', () => {
  it('the version equals the database function', () => {
    const dir = new URL('../../../supabase/migrations/', import.meta.url);
    const sql = readFileSync(
      new URL(readdirSync(dir).find((f) => f.endsWith('_credit_terms.sql')) ?? '', dir),
      'utf8',
    );
    expect(/credit_terms_version\(\) returns integer[^;]*select (\d+)/.exec(sql)?.[1]).toBe(
      String(CREDIT_TERMS_VERSION),
    );
  });
  it('groups the shops with Credit on by company', () => {
    const rows = parseCreditEntities([
      {
        store_id: 's1',
        store: 'Cafe',
        entity_id: 'e1',
        entity: 'Island Co',
        tax_id_set: true,
        credit_on: true,
      },
      {
        store_id: 's2',
        store: 'Spa',
        entity_id: 'e1',
        entity: 'Island Co',
        tax_id_set: true,
        credit_on: true,
      },
      {
        store_id: 's3',
        store: 'Shop',
        entity_id: 'e2',
        entity: 'Other Co',
        tax_id_set: false,
        credit_on: true,
      },
      {
        store_id: 's4',
        store: 'Bar',
        entity_id: 'e2',
        entity: 'Other Co',
        tax_id_set: false,
        credit_on: false,
      },
      { nope: 1 },
    ]);
    expect(creditGroups(rows)).toEqual([
      { entity: 'Island Co', taxIdSet: true, shops: ['Cafe', 'Spa'] },
      { entity: 'Other Co', taxIdSet: false, shops: ['Shop'] },
    ]);
  });
  it('reads the liability and writes a CSV in plain baht, with the crypto share on its own column', () => {
    const rows = parseCreditLiability([
      {
        legal_entity_id: 'e1',
        name: '=Island Co',
        tax_id: '0105560123456',
        topped_up: 150000,
        topped_up_cash: 100000,
        topped_up_psp: 30000,
        topped_up_crypto: 20000,
        spent: 40000,
        adjusted: -1000,
        outstanding: 109000,
        customers: 3,
      },
    ]);
    expect(rows[0]).toMatchObject({ outstanding: 109000, crypto: 20000, customers: 3 });
    const csv = creditLiabilityCsv(rows, '2026-11-21');
    const [head, line] = csv.split('\r\n');
    expect(head).toContain('topped_up_crypto');
    expect(line).toContain("'=Island Co"); // formula injection neutralised
    expect(line).toContain('1090.00');
    expect(line).toContain('200.00');
  });
});
