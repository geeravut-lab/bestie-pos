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

/** Same idea for Bestie Credit: the database decides on its own, so the SQL copy of the registry entry is checked here. */
describe('tender.credit in the database mirrors the registry', () => {
  const dir = new URL('../../../supabase/migrations/', import.meta.url);
  const file = readdirSync(dir).find((f) => f.endsWith('_credit_ledger.sql')) ?? '';
  const sql = readFileSync(new URL(file, dir), 'utf8');
  const marker = /-- registry:tender\.credit profiles=([a-z,]*) plan=([a-z,]+)/.exec(sql);
  const m = MODULE_BY_ID['tender.credit'];

  it('is off for every profile by default (the lawyer has not confirmed the structure)', () => {
    expect(m.defaultProfiles).toEqual([]);
    expect(marker![1]).toBe('');
  });
  it('same plan tiers', () => {
    const allowed = (Object.keys(PLAN_RANK) as (keyof typeof PLAN_RANK)[]).filter(
      (p) => PLAN_RANK[p] >= PLAN_RANK[m.plan],
    );
    expect(marker![2]!.split(',').sort()).toEqual(allowed.sort());
  });
  it('has no cash-out and no crypto funding in the ledger definition', () => {
    expect(sql).not.toMatch(/'cash_out'|'refund'|'crypto'/);
  });
});

/** And for the crypto top-up: module switch + Credit + the lawyer's sign-off are all enforced in SQL. */
describe('credit.topup.crypto in the database mirrors the registry', () => {
  const dir = new URL('../../../supabase/migrations/', import.meta.url);
  const file = readdirSync(dir).find((f) => f.endsWith('_crypto_topup.sql')) ?? '';
  const sql = readFileSync(new URL(file, dir), 'utf8');
  const marker =
    /-- registry:credit\.topup\.crypto profiles=([a-z,]*) plan=([a-z,]+) legal=([A-Za-z]+) depends=([a-z.]+)/.exec(
      sql,
    );
  const m = MODULE_BY_ID['credit.topup.crypto'];

  it("is off for every profile, behind the lawyer's sign-off, and depends on Credit", () => {
    expect(m.defaultProfiles).toEqual([]);
    expect(marker![1]).toBe('');
    expect(marker![3]).toBe(m.legalGate);
    expect(m.dependsOn).toEqual([marker![4]]);
    expect(sql).toMatch(/legal_sign_off ->> 'cryptoTopup'/);
  });
  it('same plan tiers', () => {
    const allowed = (Object.keys(PLAN_RANK) as (keyof typeof PLAN_RANK)[]).filter(
      (p) => PLAN_RANK[p] >= PLAN_RANK[m.plan],
    );
    expect(marker![2]!.split(',').sort()).toEqual(allowed.sort());
  });
  it('no migration anywhere defines a cash-out of Credit or a crypto exchange / withdrawal', () => {
    for (const f of readdirSync(dir)) {
      const text = readFileSync(new URL(f, dir), 'utf8');
      expect(text, f).not.toMatch(/'cash_out'\s*[,)]\s*'(?!x)/);
      expect(text, f).not.toMatch(
        /create (or replace )?function public\.(credit_cash_out|crypto_withdraw|crypto_send|crypto_refund)/i,
      );
    }
  });
});
