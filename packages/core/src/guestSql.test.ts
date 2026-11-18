import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MODULE_BY_ID, PLAN_RANK } from './modules/registry';

/**
 * The database decides on its own whether a table QR may take orders (the guest has no account and the module registry
 * is TypeScript). This test fails if the registry entry for `order.qr` and the SQL copy ever drift apart.
 */
describe('order.qr in the database mirrors the registry', () => {
  const dir = new URL('../../../supabase/migrations/', import.meta.url);
  const file = readdirSync(dir).find((f) => f.endsWith('_guest_ordering.sql')) ?? '';
  const sql = readFileSync(new URL(file, dir), 'utf8');
  const marker = /-- registry:order\.qr profiles=([a-z,]+) plan=([a-z,]+)/.exec(sql);
  const m = MODULE_BY_ID['order.qr'];

  it('has the marker', () => expect(marker).not.toBeNull());
  it('same default profiles', () => {
    expect(marker![1]!.split(',').sort()).toEqual([...m.defaultProfiles].sort());
  });
  it('same plan tiers (the minimum tier and everything above it)', () => {
    const allowed = (Object.keys(PLAN_RANK) as (keyof typeof PLAN_RANK)[]).filter(
      (p) => PLAN_RANK[p] >= PLAN_RANK[m.plan],
    );
    expect(marker![2]!.split(',').sort()).toEqual(allowed.sort());
  });
});
