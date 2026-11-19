import { PERMISSIONS } from './types';
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

/** The guest menu assistant: off for every profile, Pro and up, needs QR ordering — the SQL copy must say the same. */
describe('ai.guest in the database mirrors the registry', () => {
  const dir = new URL('../../../supabase/migrations/', import.meta.url);
  const file = readdirSync(dir).find((f) => f.endsWith('_food_tags.sql')) ?? '';
  const sql = readFileSync(new URL(file, dir), 'utf8');
  const marker = /-- registry:ai\.guest profiles=([a-z,]*) plan=([a-z,]+) depends=([a-z.]+)/.exec(
    sql,
  );
  const m = MODULE_BY_ID['ai.guest'];

  it('has the marker, is off by default and depends on the same module', () => {
    expect(marker).not.toBeNull();
    expect(m.defaultProfiles).toEqual([]);
    expect(marker![1]).toBe('');
    expect(m.dependsOn).toEqual([marker![3]]);
  });
  it('same plan tiers', () => {
    const allowed = (Object.keys(PLAN_RANK) as (keyof typeof PLAN_RANK)[]).filter(
      (p) => PLAN_RANK[p] >= PLAN_RANK[m.plan],
    );
    expect(marker![2]!.split(',').sort()).toEqual(allowed.sort());
  });
});

/** PromptPay / card switches: the database refuses a switched-off method, so its copy of the registry entries is checked here. */
describe('tender.promptpay and tender.gateway in the database mirror the registry', () => {
  const dir = new URL('../../../supabase/migrations/', import.meta.url);
  const file = readdirSync(dir).find((f) => f.endsWith('_credit_online_topup.sql')) ?? '';
  const sql = readFileSync(new URL(file, dir), 'utf8');
  const marker = (id: string) =>
    new RegExp(`-- registry:${id.replace('.', '\\.')} profiles=([a-z,]*) plan=([a-z,]+)`).exec(sql);

  it('PromptPay is on for every profile, card for none', () => {
    expect(MODULE_BY_ID['tender.promptpay'].defaultProfiles.length).toBeGreaterThan(1);
    expect(marker('tender.promptpay')![1]).toBe('all');
    expect(MODULE_BY_ID['tender.gateway'].defaultProfiles).toEqual([]);
    expect(marker('tender.gateway')![1]).toBe('');
    expect(sql).toMatch(/p_tender = 'promptpay'/);
  });
  it('same plan tiers (basic and up)', () => {
    for (const id of ['tender.promptpay', 'tender.gateway'] as const) {
      const allowed = (Object.keys(PLAN_RANK) as (keyof typeof PLAN_RANK)[]).filter(
        (p) => PLAN_RANK[p] >= PLAN_RANK[MODULE_BY_ID[id].plan],
      );
      expect(marker(id)![2]!.split(',').sort()).toEqual(allowed.sort());
    }
  });
});

/** "Ask my shop" (owner assistant): off for every profile, Pro and up, no dependencies — the SQL copy must say the same. */
describe('ai.assistant in the database mirrors the registry', () => {
  const dir = new URL('../../../supabase/migrations/', import.meta.url);
  const file = readdirSync(dir).find((f) => f.endsWith('_ask_shop.sql')) ?? '';
  const sql = readFileSync(new URL(file, dir), 'utf8');
  const marker = /-- registry:ai\.assistant profiles=([a-z,]*) plan=([a-z,]+)/.exec(sql);
  const m = MODULE_BY_ID['ai.assistant'];

  it('has the marker, is off by default and has no dependencies', () => {
    expect(marker).not.toBeNull();
    expect(m.defaultProfiles).toEqual([]);
    expect(marker![1]).toBe('');
    expect(m.dependsOn).toEqual([]);
  });
  it('same plan tiers', () => {
    const allowed = (Object.keys(PLAN_RANK) as (keyof typeof PLAN_RANK)[]).filter(
      (p) => PLAN_RANK[p] >= PLAN_RANK[m.plan],
    );
    expect(marker![2]!.split(',').sort()).toEqual(allowed.sort());
  });
});

/** The permission list the database accepts for custom roles is the same list the app offers. */
describe('known_permissions() in the database mirrors PERMISSIONS', () => {
  const dir = new URL('../../../supabase/migrations/', import.meta.url);
  // the LAST migration that (re)defines the list wins, as in the database
  const file =
    readdirSync(dir)
      .sort()
      .filter((f) =>
        readFileSync(new URL(f, dir), 'utf8').includes('function public.known_permissions()'),
      )
      .at(-1) ?? '';
  const sql = readFileSync(new URL(file, dir), 'utf8');
  it('lists exactly the same permissions', () => {
    const body = /select array\[([\s\S]*?)\]::text\[\]/.exec(sql)![1]!;
    const sqlList = [...body.matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]!).sort();
    expect(sqlList).toEqual([...PERMISSIONS].sort());
  });
});

/** Appointments and resources: the database decides whether a booking is allowed, so its copy of the registry entries is checked here. */
describe('appointments and resources in the database mirror the registry', () => {
  const dir = new URL('../../../supabase/migrations/', import.meta.url);
  const file = readdirSync(dir).find((f) => f.endsWith('_appointments.sql')) ?? '';
  const sql = readFileSync(new URL(file, dir), 'utf8');
  const billingSql = readFileSync(
    new URL(readdirSync(dir).find((f) => f.endsWith('_appointment_billing.sql')) ?? '', dir),
    'utf8',
  );
  const allowed = (id: 'appointments' | 'resources' | 'deposits') =>
    (Object.keys(PLAN_RANK) as (keyof typeof PLAN_RANK)[]).filter(
      (p) => PLAN_RANK[p] >= PLAN_RANK[MODULE_BY_ID[id].plan],
    );

  it('appointments: same default profiles and plan tiers', () => {
    const m = /-- registry:appointments profiles=([a-z,]+) plan=([a-z,]+)/.exec(sql);
    expect(m).not.toBeNull();
    expect(m![1]!.split(',').sort()).toEqual([...MODULE_BY_ID.appointments.defaultProfiles].sort());
    expect(m![2]!.split(',').sort()).toEqual(allowed('appointments').sort());
  });
  it('resources: same default profiles, plan tiers and dependency', () => {
    const m = /-- registry:resources profiles=([a-z,]+) plan=([a-z,]+) depends=([a-z.]+)/.exec(sql);
    expect(m).not.toBeNull();
    expect(m![1]!.split(',').sort()).toEqual([...MODULE_BY_ID.resources.defaultProfiles].sort());
    expect(m![2]!.split(',').sort()).toEqual(allowed('resources').sort());
    expect(MODULE_BY_ID.resources.dependsOn).toEqual([m![3]]);
  });
  it('deposits: same default profiles, plan tiers and dependency', () => {
    const m = /-- registry:deposits profiles=([a-z,]+) plan=([a-z,]+) depends=([a-z.]+)/.exec(
      billingSql,
    );
    expect(m).not.toBeNull();
    expect(m![1]!.split(',').sort()).toEqual([...MODULE_BY_ID.deposits.defaultProfiles].sort());
    expect(m![2]!.split(',').sort()).toEqual(allowed('deposits').sort());
    expect(MODULE_BY_ID.deposits.dependsOn).toEqual([m![3]]);
  });
  it('commission: same default profiles and plan tiers', () => {
    const tipsSql = readFileSync(
      new URL(readdirSync(dir).find((f) => f.endsWith('_commission_tips.sql')) ?? '', dir),
      'utf8',
    );
    const m = /-- registry:commission profiles=([a-z,]+) plan=([a-z,]+)/.exec(tipsSql);
    expect(m).not.toBeNull();
    expect(m![1]!.split(',').sort()).toEqual([...MODULE_BY_ID.commission.defaultProfiles].sort());
    const allowedPlans = (Object.keys(PLAN_RANK) as (keyof typeof PLAN_RANK)[]).filter(
      (p) => PLAN_RANK[p] >= PLAN_RANK[MODULE_BY_ID.commission.plan],
    );
    expect(m![2]!.split(',').sort()).toEqual(allowedPlans.sort());
  });
});
