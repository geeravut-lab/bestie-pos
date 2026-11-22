import { PERMISSIONS } from './types';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MODULE_BY_ID, PLAN_RANK } from './modules/registry';
import { KARAOKE_GUEST_QUEUE_MAX, KARAOKE_REPEAT_MINUTES, KARAOKE_STEPS } from './karaoke';
import { DEFAULT_KARAOKE_BOOKING } from './karaokeBooking';
import { DELIVERY_CODES, MAX_COMMISSION_BPS } from './delivery';
import { SPA_RULES_VERSION, SPA_TAGS } from './spaAdvisor';

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
  it('packages: same default profiles and plan tiers', () => {
    const pkgSql = readFileSync(
      new URL(readdirSync(dir).find((f) => f.endsWith('_packages.sql')) ?? '', dir),
      'utf8',
    );
    const m = /-- registry:packages profiles=([a-z,]+) plan=([a-z,]+)/.exec(pkgSql);
    expect(m).not.toBeNull();
    expect(m![1]!.split(',').sort()).toEqual([...MODULE_BY_ID.packages.defaultProfiles].sort());
    const allowedPlans = (Object.keys(PLAN_RANK) as (keyof typeof PLAN_RANK)[]).filter(
      (p) => PLAN_RANK[p] >= PLAN_RANK[MODULE_BY_ID.packages.plan],
    );
    expect(m![2]!.split(',').sort()).toEqual(allowedPlans.sort());
  });
  it('booking.online: off for every profile, same plan tiers, same dependency', () => {
    const sql = readFileSync(
      new URL(readdirSync(dir).find((f) => f.endsWith('_online_booking.sql')) ?? '', dir),
      'utf8',
    );
    const m =
      /-- registry:booking\.online profiles=([a-z,]*) plan=([a-z,]+) depends=([a-z.]+)/.exec(sql);
    expect(m).not.toBeNull();
    expect(MODULE_BY_ID['booking.online'].defaultProfiles).toEqual([]);
    expect(m![1]).toBe('');
    const allowedPlans = (Object.keys(PLAN_RANK) as (keyof typeof PLAN_RANK)[]).filter(
      (p) => PLAN_RANK[p] >= PLAN_RANK[MODULE_BY_ID['booking.online'].plan],
    );
    expect(m![2]!.split(',').sort()).toEqual(allowedPlans.sort());
    expect(MODULE_BY_ID['booking.online'].dependsOn).toEqual([m![3]]);
    // the database's list of known module ids must include it
    expect(sql).toContain("'booking.online'");
  });
});

describe('spa advisor SQL mirror', () => {
  const dir = new URL('../../../supabase/migrations/', import.meta.url);
  it('the rules version, the module and its gate match the code', () => {
    const sql = readFileSync(
      new URL(readdirSync(dir).find((f) => f.endsWith('_spa_advisor.sql')) ?? '', dir),
      'utf8',
    );
    expect(/spa_rules_version\(\) returns integer[^;]*select (\d+)/.exec(sql)?.[1]).toBe(
      String(SPA_RULES_VERSION),
    );
    expect(MODULE_BY_ID['advisor.spa'].defaultProfiles).toEqual([]);
    expect(MODULE_BY_ID['advisor.spa'].dependsOn).toEqual(['booking.online']);
    expect(MODULE_BY_ID['advisor.spa'].plan).toBe('pro');
    expect(sql).toContain("'advisor.spa'");
    expect(sql).toContain('booking_online_enabled');
    // the database accepts exactly the tags the code knows
    for (const tag of SPA_TAGS) expect(sql).toContain(`'${tag}'`);
  });

  it('ai.translate and the shift figures: registry and SQL agree', () => {
    const dir = new URL('../../../supabase/migrations/', import.meta.url);
    const sql = readFileSync(
      new URL(readdirSync(dir).find((f) => f.endsWith('_shift_summary_translate.sql')) ?? '', dir),
      'utf8',
    );
    expect(MODULE_BY_ID['ai.translate'].defaultProfiles).toEqual([]);
    expect(MODULE_BY_ID['ai.translate'].plan).toBe('pro');
    expect(sql).toContain("(s.module_overrides ->> 'ai.translate')::boolean, false");
    expect(sql).toContain("s.plan in ('pro', 'resort')");
    expect(sql).toContain("has_permission(sh.org_id, 'report.view')");
    expect(sql).toContain('ask_shop_enabled(sh.store_id)');
  });

  it('ai.hair: registry and SQL agree and the photo reaches a model only after a separate consent', () => {
    const dir = new URL('../../../supabase/migrations/', import.meta.url);
    const sql = readFileSync(
      new URL(readdirSync(dir).find((f) => f.endsWith('_hair_ai.sql')) ?? '', dir),
      'utf8',
    );
    expect(MODULE_BY_ID['ai.hair'].defaultProfiles).toEqual([]);
    expect(MODULE_BY_ID['ai.hair'].dependsOn).toEqual(['booking.online']);
    expect(MODULE_BY_ID['ai.hair'].plan).toBe('pro');
    expect(sql).toContain("(s.module_overrides ->> 'ai.hair')::boolean, false");
    expect(sql).toContain("s.plan in ('pro', 'resort')");
    expect(sql).toContain('ph.ai_consent_at is null');
    for (const v of [
      'short',
      'medium',
      'long',
      'straight',
      'wavy',
      'curly',
      'fine',
      'thick',
      'dry_damaged',
    ])
      expect(sql).toContain(`'${v}'`);
  });

  it('karaoke: the module mirrors and the arithmetic live in migration 70', () => {
    const dir = new URL('../../../supabase/migrations/', import.meta.url);
    const sql = readFileSync(
      new URL(readdirSync(dir).find((f) => f.endsWith('_karaoke.sql')) ?? '', dir),
      'utf8',
    );
    expect(MODULE_BY_ID['karaoke.rooms'].defaultProfiles).toEqual(['karaoke']);
    expect(MODULE_BY_ID['karaoke.songs'].dependsOn).toEqual(['karaoke.rooms']);
    expect(sql).toContain("'karaoke.rooms','karaoke.songs'");
    expect(sql).toContain("s.profile = 'karaoke'");
    expect(sql).toContain("s.plan in ('pro', 'resort')");
    // the rules of the queue are the ones the page tells the guest
    expect(sql).toContain(`interval '${KARAOKE_REPEAT_MINUTES} minutes'`);
    expect(sql).toContain(`'guest', ${KARAOKE_GUEST_QUEUE_MAX})`);
    // the database accepts exactly the steps the screen offers
    expect(sql).toContain(`step_minutes in (${KARAOKE_STEPS.join(', ')})`);
  });

  it('karaoke online booking: the module mirror, the defaults and the deposit rule live in migration 75', () => {
    const dir = new URL('../../../supabase/migrations/', import.meta.url);
    const sql = readFileSync(
      new URL(readdirSync(dir).find((f) => f.endsWith('_karaoke_online_booking.sql')) ?? '', dir),
      'utf8',
    );
    expect(MODULE_BY_ID['karaoke.booking'].dependsOn).toEqual(['karaoke.rooms']);
    expect(MODULE_BY_ID['karaoke.booking'].defaultProfiles).toEqual([]);
    expect(MODULE_BY_ID['karaoke.booking'].plan).toBe('pro');
    expect(sql).toContain("'karaoke.booking'");
    expect(sql).toContain("s.plan in ('pro', 'resort')");
    const d = DEFAULT_KARAOKE_BOOKING;
    expect(sql).toContain(`'${d.open}'`);
    expect(sql).toContain(`'${d.close}'`);
    expect(sql).toContain(
      `'step_min',    coalesce((p_settings ->> 'step_min')::integer, ${d.stepMin})`,
    );
    expect(sql).toContain(
      `'lead_min',    coalesce((p_settings ->> 'lead_min')::integer, ${d.leadMin})`,
    );
    expect(sql).toContain(
      `'max_days',    coalesce((p_settings ->> 'max_days')::integer, ${d.maxDays})`,
    );
    expect(sql).toContain(
      `'deposit_pct', coalesce((p_settings ->> 'deposit_pct')::integer, ${d.depositPct})`,
    );
    expect(sql).toContain(
      `'hold_min',    coalesce((p_settings ->> 'hold_min')::integer, ${d.holdMin})`,
    );
    // the deposit is the same half-up percentage on both sides
    expect(sql).toContain('(p_price::bigint * greatest(least(p_pct, 100), 0) + 50) / 100');
  });

  it('delivery: the module mirror, the commission arithmetic and the tender live in migration 77', () => {
    const dir = new URL('../../../supabase/migrations/', import.meta.url);
    const sql = readFileSync(
      new URL(readdirSync(dir).find((f) => f.endsWith('_delivery.sql')) ?? '', dir),
      'utf8',
    );
    expect(MODULE_BY_ID.delivery.plan).toBe('pro');
    expect(MODULE_BY_ID.delivery.defaultProfiles).toEqual([]);
    expect(sql).toContain("s.plan in ('pro', 'resort')");
    expect(sql).toContain("(s.module_overrides ->> 'delivery')::boolean");
    // the commission is half up on the payable, the same as deliveryCommission()
    expect(sql).toContain('v_comm := (v_payable * d.commission_bps + 5000) / 10000;');
    expect(sql).toContain(`commission_bps between 0 and ${MAX_COMMISSION_BPS}`);
    for (const c of DELIVERY_CODES) expect(sql).toContain(`'${c}'`);
    expect(sql).toContain("'room', 'platform'");
  });

  it('business manager: the module mirror lives in migration 84', () => {
    const dir = new URL('../../../supabase/migrations/', import.meta.url);
    const sql = readFileSync(
      new URL(readdirSync(dir).find((f) => f.endsWith('_smart_ops.sql')) ?? '', dir),
      'utf8',
    );
    expect(MODULE_BY_ID['ai.business_manager'].plan).toBe('pro');
    expect(MODULE_BY_ID['ai.business_manager'].defaultProfiles).toEqual([]);
    expect(sql).toContain("s.plan in ('pro', 'resort')");
    expect(sql).toContain("(s.module_overrides ->> 'ai.business_manager')::boolean");
    expect(sql).toContain("'guest.concierge','ai.business_manager'];");
  });

  it('growth tools: the module mirrors live in migration 85', () => {
    const dir = new URL('../../../supabase/migrations/', import.meta.url);
    const sql = readFileSync(
      new URL(readdirSync(dir).find((f) => f.endsWith('_growth_tools.sql')) ?? '', dir),
      'utf8',
    );
    expect(MODULE_BY_ID.marketing).toMatchObject({ plan: 'pro', defaultProfiles: [] });
    expect(MODULE_BY_ID['integration.hub']).toMatchObject({ plan: 'pro', defaultProfiles: [] });
    expect(MODULE_BY_ID.stamps).toMatchObject({ plan: 'basic', defaultProfiles: ['cafe'] });
    expect(MODULE_BY_ID['slots.booking']).toMatchObject({
      plan: 'pro',
      defaultProfiles: ['tours'],
    });
    expect(sql).toContain("(s.module_overrides ->> 'marketing')::boolean, false");
    expect(sql).toContain("(s.module_overrides ->> 'integration.hub')::boolean, false");
    expect(sql).toContain("(s.module_overrides ->> 'stamps')::boolean, s.profile = 'cafe'");
    expect(sql).toContain("(s.module_overrides ->> 'slots.booking')::boolean, s.profile = 'tours'");
    expect(sql).toContain("'ai.business_manager','marketing','integration.hub','stamps'];");
  });

  it('tours online: the module mirror lives in migration 88 and the shops column list knows it', () => {
    const dir = new URL('../../../supabase/migrations/', import.meta.url);
    const sql = readFileSync(
      new URL(readdirSync(dir).find((f) => f.endsWith('_tours_online.sql')) ?? '', dir),
      'utf8',
    );
    expect(MODULE_BY_ID['tours.online'].dependsOn).toEqual(['slots.booking']);
    expect(MODULE_BY_ID['tours.online'].defaultProfiles).toEqual([]);
    expect(MODULE_BY_ID['tours.online'].plan).toBe('pro');
    expect(sql).toContain("(s.module_overrides ->> 'tours.online')::boolean, false");
    expect(sql).toContain("'waitlist','timeclock','tours.online'];");
  });

  it('ops tools: the module mirrors live in migration 86', () => {
    const dir = new URL('../../../supabase/migrations/', import.meta.url);
    const sql = readFileSync(
      new URL(readdirSync(dir).find((f) => f.endsWith('_ops_tools.sql')) ?? '', dir),
      'utf8',
    );
    expect(MODULE_BY_ID.waitlist).toMatchObject({
      plan: 'basic',
      defaultProfiles: ['restaurant', 'cafe'],
    });
    expect(MODULE_BY_ID.timeclock).toMatchObject({ plan: 'basic', defaultProfiles: [] });
    expect(sql).toContain(
      "(s.module_overrides ->> 'waitlist')::boolean, s.profile in ('restaurant', 'cafe')",
    );
    expect(sql).toContain("(s.module_overrides ->> 'timeclock')::boolean, false");
    expect(sql).toContain("'integration.hub','stamps','waitlist','timeclock'];");
  });

  it('kiosk: the module mirror and the rules that make a kiosk differ from a table live in migration 78', () => {
    const dir = new URL('../../../supabase/migrations/', import.meta.url);
    const sql = readFileSync(
      new URL(readdirSync(dir).find((f) => f.endsWith('_kiosk.sql')) ?? '', dir),
      'utf8',
    );
    expect(MODULE_BY_ID.kiosk.plan).toBe('pro');
    expect(MODULE_BY_ID.kiosk.defaultProfiles).toEqual([]);
    expect(sql).toContain("s.plan in ('pro', 'resort')");
    expect(sql).toContain("(s.module_overrides ->> 'kiosk')::boolean");
    // a kiosk order is its own takeaway bill KS001…, at the takeaway prices, never auto-sent
    expect(sql).toContain("'takeaway'");
    expect(sql).toContain("'KS'");
    // kiosk and online-order pages never auto-send and never join an earlier bill (the flag `v_k`)
    expect(sql).toContain('(s.qr_auto_send and not v_k)');
    expect(sql).toContain('not v_k and ord.table_id = t.id');
  });
});
