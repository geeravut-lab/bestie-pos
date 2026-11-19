import { describe, expect, it } from 'vitest';
import {
  MANUAL_STEPS,
  SNAPSHOT_SQL,
  checkStore,
  checkSystem,
  render,
  summarize,
} from '../../tools/pilot-check/checks.mjs';
import type { CheckResult, StoreSnapshot } from '../../tools/pilot-check/checks.mjs';

const GOOD: StoreSnapshot = {
  name: 'Test Cafe',
  profile: 'cafe',
  legal_name: 'Test Co.',
  tax_id: '0105551234567',
  vat_registered: true,
  vat_bps: 700,
  module_overrides: {},
  crypto_signed_off: false,
  categories: 3,
  items: 10,
  items_without_station: 0,
  groups_short: 0,
  tables: 0,
  providers: 2,
  places: 1,
  timed_services: 5,
  devices: 2,
  cashier_devices: 1,
  kds_devices: 1,
  devices_without_pos_id: 0,
  devices_with_reader: 0,
  owners: 1,
  staff_without_pin: 0,
  printers: [{ id: 'p1', stations: ['kitchen'] }],
  default_printer: 'p1',
  qr_pay_device: null,
  shift_required: false,
};
const find = (rs: CheckResult[], id: string) => rs.find((r) => r.id === id);

describe('checkStore', () => {
  it('a fully prepared shop has nothing to fix', () => {
    const r = checkStore(GOOD);
    expect(summarize(r).fail).toBe(0);
    expect(summarize(r).warn).toBe(0);
    expect(r.every((x) => x.shop === 'Test Cafe')).toBe(true);
  });

  it('an empty new shop lists what is missing as FAIL', () => {
    const r = checkStore({
      ...GOOD,
      profile: 'restaurant',
      vat_registered: false,
      items: 0,
      categories: 0,
      devices: 0,
      cashier_devices: 0,
      kds_devices: 0,
      printers: [],
      tables: 0,
    });
    expect(find(r, 'items')?.level).toBe('fail');
    expect(find(r, 'tables')?.level).toBe('fail');
    expect(find(r, 'devices')?.level).toBe('fail');
    expect(find(r, 'kitchen')?.level).toBe('warn');
    expect(find(r, 'printers')?.level).toBe('warn');
  });

  it('a VAT shop needs a tax id, a rate and a POS ID on every till', () => {
    const r = checkStore({ ...GOOD, tax_id: null, vat_bps: 0, devices_without_pos_id: 2 });
    expect(find(r, 'tax_id')?.level).toBe('fail');
    expect(find(r, 'vat')?.level).toBe('fail');
    expect(find(r, 'pos_id')?.level).toBe('fail');
    // a shop that is not VAT registered only gets a reminder
    const nv = checkStore({ ...GOOD, vat_registered: false, tax_id: null });
    expect(find(nv, 'tax_id')?.level).toBe('warn');
    expect(find(nv, 'pos_id')).toBeUndefined();
  });

  it('menu problems: dishes without a station, option groups that can never be satisfied', () => {
    const r = checkStore({ ...GOOD, items_without_station: 4, groups_short: 1 });
    expect(find(r, 'stations')?.level).toBe('warn');
    expect(find(r, 'groups')?.level).toBe('fail');
  });

  it('legal gates: crypto on without a sign-off is a FAIL, Credit on is a conscious WARN', () => {
    const crypto = checkStore({ ...GOOD, module_overrides: { 'credit.topup.crypto': true } });
    expect(find(crypto, 'crypto')?.level).toBe('fail');
    const signed = checkStore({
      ...GOOD,
      crypto_signed_off: true,
      module_overrides: { 'credit.topup.crypto': true },
    });
    expect(find(signed, 'crypto')?.level).toBe('warn');
    expect(
      find(checkStore({ ...GOOD, module_overrides: { 'tender.credit': true } }), 'credit')?.level,
    ).toBe('warn');
  });

  it('card enabled but no reader linked, and staff without a PIN, are warned', () => {
    const r = checkStore({
      ...GOOD,
      module_overrides: { 'tender.gateway': true },
      staff_without_pin: 2,
    });
    expect(find(r, 'reader')?.level).toBe('warn');
    expect(find(r, 'pins')?.level).toBe('warn');
  });
});

describe('checkStore for salon / spa', () => {
  const salon = { ...GOOD, profile: 'salon', providers: 0, timed_services: 0, places: 0 };
  it('a salon with no stylist cannot take appointments (FAIL); no timed service is a WARN', () => {
    const r = checkStore(salon);
    expect(find(r, 'providers')?.level).toBe('fail');
    expect(find(r, 'timed')?.level).toBe('warn');
    expect(find(r, 'places')).toBeUndefined();
  });
  it('a spa also wants rooms or beds; a ready one has nothing to fix', () => {
    expect(find(checkStore({ ...salon, profile: 'spa' }), 'places')?.level).toBe('warn');
    const ok = checkStore({ ...GOOD, profile: 'spa' });
    expect(summarize(ok).fail).toBe(0);
    expect(summarize(ok).warn).toBe(0);
  });
  it('a cafe is not asked about stylists', () => {
    expect(find(checkStore({ ...GOOD, providers: 0 }), 'providers')).toBeUndefined();
  });
});

describe('checkSystem', () => {
  const auth = {
    external_google_enabled: true,
    external_google_client_id: 'abc',
    site_url: 'https://bestie-pos.vercel.app',
    uri_allow_list: 'https://bestie-pos.vercel.app/**,http://localhost:5173/**',
    smtp_host: 'smtp.resend.com',
    mailer_autoconfirm: false,
  };
  const names = [
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_URL',
    'VITE_SUPABASE_URL',
    'VITE_SUPABASE_ANON_KEY',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'CRON_SECRET',
    'LINE_CHANNEL_SECRET',
    'LINE_CHANNEL_ACCESS_TOKEN',
    'LINE_CODE_SECRET',
    'LINE_BASIC_ID',
    'AIVORA_APP_SLUG',
    'VITE_AIVORA_APP_SLUG',
    'GOOGLE_AI_API_KEY',
  ];

  it('e-mail sign-up without confirmation is a WARN, with confirmation it is fine', () => {
    expect(
      find(
        checkSystem({ auth: { ...auth, mailer_autoconfirm: true }, vercelEnvNames: names }),
        'autoconfirm',
      )?.level,
    ).toBe('warn');
    expect(find(checkSystem({ auth, vercelEnvNames: names }), 'autoconfirm')?.level).toBe('ok');
  });

  it('a complete setup has no FAIL or WARN', () => {
    const s = summarize(checkSystem({ auth, vercelEnvNames: names }));
    expect(s.fail).toBe(0);
    expect(s.warn).toBe(0);
  });

  it('login settings: Google off, wrong site URL, missing redirect', () => {
    const r = checkSystem({
      auth: {
        ...auth,
        external_google_enabled: false,
        site_url: 'http://localhost:3000',
        uri_allow_list: 'http://localhost:5173/**',
      },
      vercelEnvNames: names,
    });
    expect(find(r, 'google')?.level).toBe('warn');
    expect(find(r, 'site_url')?.level).toBe('fail');
    expect(find(r, 'redirects')?.level).toBe('fail');
  });

  it('missing production variables: secrets FAIL, optional integrations WARN, half an SSO pair FAIL', () => {
    const r = checkSystem({
      auth,
      vercelEnvNames: names.filter(
        (n) =>
          ![
            'CRON_SECRET',
            'LINE_CODE_SECRET',
            'VITE_AIVORA_APP_SLUG',
            'GOOGLE_AI_API_KEY',
          ].includes(n),
      ),
    });
    expect(find(r, 'env:CRON_SECRET')?.level).toBe('fail');
    expect(find(r, 'env:LINE_CODE_SECRET')?.level).toBe('warn');
    expect(find(r, 'env:ai')?.level).toBe('warn');
    expect(find(r, 'sso_pair')?.level).toBe('fail');
  });

  it('says so, instead of guessing, when it could not read a source', () => {
    const r = checkSystem({ auth: null, vercelEnvNames: null });
    expect(r.map((x) => x.level)).toEqual(['info', 'info']);
  });
});

describe('the report', () => {
  it('prints a summary and always lists what a script cannot check', () => {
    const text = render([
      ...checkSystem({ auth: null, vercelEnvNames: null }),
      ...checkStore(GOOD),
    ]);
    expect(text).toContain('สรุป: ผ่าน');
    for (const m of MANUAL_STEPS) expect(text).toContain(m);
    expect(render(checkStore(GOOD), { quiet: true })).not.toContain('✅');
  });

  it('only reads: the snapshot query is a single select', () => {
    expect(SNAPSHOT_SQL.trim().toLowerCase().startsWith('select')).toBe(true);
    expect(SNAPSHOT_SQL).not.toMatch(/\b(insert|update|delete|drop|alter|truncate)\b/i);
  });
});
