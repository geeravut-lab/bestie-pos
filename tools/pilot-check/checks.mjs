// Pilot readiness checks — pure functions (no network), so they can be unit tested (functions/src/pilot-check.test.ts).
// The CLI (pilot-check.mjs) fetches the data and prints what these return.
// A result is { group, id, level, text } with level: 'ok' | 'fail' | 'warn' | 'info'.
//   fail = do not go live until fixed · warn = should be a conscious choice · info = FYI

const ok = (group, id, text) => ({ group, id, level: 'ok', text });
const fail = (group, id, text) => ({ group, id, level: 'fail', text });
const warn = (group, id, text) => ({ group, id, level: 'warn', text });
const info = (group, id, text) => ({ group, id, level: 'info', text });

/** One SQL statement (run through the Supabase management API) that returns a JSON array: one object per shop. */
export const SNAPSHOT_SQL = `
select coalesce(jsonb_agg(x order by x.name), '[]'::jsonb) as stores from (
  select s.id, s.name, s.profile, s.plan, s.vat_registered, s.vat_bps, s.branch_code, s.module_overrides,
         s.shift_required, s.qr_auto_send, s.qr_pay_device, s.printers, s.default_printer,
         le.name as legal_name, le.tax_id,
         (o.legal_sign_off ->> 'cryptoTopup') = 'true' as crypto_signed_off,
         coalesce((to_jsonb(o) ->> 'credit_terms_required')::boolean, false) as credit_terms_required,
         (select count(*) from public.menu_categories c where c.store_id = s.id and c.deleted_at is null) as categories,
         (select count(*) from public.menu_items i where i.store_id = s.id and i.deleted_at is null) as items,
         (select count(*) from public.menu_items i where i.store_id = s.id and i.deleted_at is null and i.station is null) as items_without_station,
         (select count(*) from public.modifier_groups g
            where g.store_id = s.id and g.deleted_at is null and g.min_select >
              (select count(*) from public.modifier_options m where m.group_id = g.id and m.deleted_at is null)) as groups_short,
         (select count(*) from public.resources r where r.store_id = s.id and r.deleted_at is null and r.active and r.kind in ('stylist', 'therapist')) as providers,
         (select count(*) from public.resources r where r.store_id = s.id and r.deleted_at is null and r.active and r.kind in ('room', 'bed', 'chair')) as places,
         (select count(*) from public.menu_items i where i.store_id = s.id and i.deleted_at is null and i.duration_min is not null) as timed_services,
         (select count(*) from public.dining_tables t where t.store_id = s.id and t.deleted_at is null and t.active) as tables,
         (select count(*) from public.devices d where d.store_id = s.id and d.active) as devices,
         (select count(*) from public.devices d where d.store_id = s.id and d.active and d.role = 'cashier') as cashier_devices,
         (select count(*) from public.devices d where d.store_id = s.id and d.active and d.role = 'kds') as kds_devices,
         (select count(*) from public.devices d where d.store_id = s.id and d.active and d.role <> 'kds' and d.revenue_pos_id is null) as devices_without_pos_id,
         (select count(*) from public.devices d where d.store_id = s.id and d.active and d.reader_id is not null) as devices_with_reader,
         (select count(*) from public.staff f where f.org_id = s.org_id and f.active and (f.store_id is null or f.store_id = s.id)) as staff,
         (select count(*) from public.staff f join public.roles r on r.id = f.role_id
            where f.org_id = s.org_id and f.active and r.built_in = 'owner') as owners,
         (select count(*) from public.staff f join public.roles r on r.id = f.role_id
            where f.org_id = s.org_id and f.active and (f.store_id is null or f.store_id = s.id)
              and r.built_in is distinct from 'owner'
              and not exists (select 1 from public.staff_pins p where p.staff_id = f.id)) as staff_without_pin
  from public.stores s
  join public.legal_entities le on le.id = s.legal_entity_id
  join public.orgs o on o.id = s.org_id
  where s.deleted_at is null
) x`;

const n = (v) => Number(v ?? 0);

/** The checks for ONE shop. `snap` is one element of the snapshot array. */
export function checkStore(snap) {
  const g = 'shop';
  const out = [];
  const mod = snap.module_overrides ?? {};

  // ── legal and tax ──
  if (/^[0-9]{13}$/.test(snap.tax_id ?? ''))
    out.push(ok('tax', 'tax_id', `เลขผู้เสียภาษี ${snap.tax_id} (${snap.legal_name})`));
  else if (snap.vat_registered)
    out.push(fail('tax', 'tax_id', 'ร้านจด VAT แต่ยังไม่มีเลขผู้เสียภาษี 13 หลักของนิติบุคคล — ใบเสร็จย่อไม่ครบ'));
  else out.push(warn('tax', 'tax_id', 'ยังไม่มีเลขผู้เสียภาษีของนิติบุคคล (ไม่จด VAT ก็ใช้ได้ แต่ควรใส่)'));

  if (snap.vat_registered) {
    if (n(snap.vat_bps) > 0) out.push(ok('tax', 'vat', `จด VAT อัตรา ${n(snap.vat_bps) / 100}%`));
    else out.push(fail('tax', 'vat', 'ตั้งว่าจด VAT แต่อัตรา VAT เป็น 0'));
    if (n(snap.devices_without_pos_id) === 0 && n(snap.devices) > 0)
      out.push(ok('tax', 'pos_id', 'ทุกเครื่องที่รับเงินมี POS ID กรมสรรพากร'));
    else if (n(snap.devices_without_pos_id) > 0)
      out.push(
        fail(
          'tax',
          'pos_id',
          `${snap.devices_without_pos_id} เครื่องยังไม่มี POS ID กรมสรรพากร (ใบเสร็จอย่างย่อต้องพิมพ์)`,
        ),
      );
  } else {
    out.push(info('tax', 'vat', 'ร้านไม่จด VAT — ใบเสร็จไม่คิด VAT'));
  }

  // ── menu ──
  if (n(snap.items) > 0)
    out.push(ok('menu', 'items', `เมนู ${snap.items} รายการใน ${snap.categories} หมวด`));
  else out.push(fail('menu', 'items', 'ยังไม่มีเมนู (กด "Load demo menu" ที่ /menu หรือเพิ่มเอง)'));
  if (['restaurant', 'cafe'].includes(snap.profile) && n(snap.items) > 0) {
    if (n(snap.items_without_station) === 0)
      out.push(ok('menu', 'stations', 'ทุกเมนูมีสถานี (ครัว/บาร์)'));
    else
      out.push(
        warn(
          'menu',
          'stations',
          `${snap.items_without_station} เมนูไม่มีสถานี — จะไม่ขึ้นจอครัวและไม่พิมพ์ใบสั่งครัว`,
        ),
      );
  }
  if (n(snap.groups_short) > 0)
    out.push(
      fail(
        'menu',
        'groups',
        `${snap.groups_short} กลุ่มตัวเลือกบังคับมีตัวเลือกน้อยกว่าขั้นต่ำ — แคชเชียร์ปิดรายการนั้นไม่ได้`,
      ),
    );
  if (snap.profile === 'restaurant') {
    if (n(snap.tables) > 0) out.push(ok('menu', 'tables', `โต๊ะ ${snap.tables} โต๊ะ`));
    else out.push(fail('menu', 'tables', 'ร้านอาหารแต่ยังไม่มีโต๊ะที่ /tables'));
  }

  // ── appointments (salon / spa) ──
  if (['salon', 'spa'].includes(snap.profile)) {
    if (n(snap.providers) > 0)
      out.push(ok('menu', 'providers', `ช่าง/ผู้ให้บริการ ${snap.providers} คน`));
    else out.push(fail('menu', 'providers', 'ยังไม่มีช่าง/หมอนวดที่ /resources — ลงนัดหมายในปฏิทินไม่ได้'));
    if (n(snap.timed_services) > 0)
      out.push(ok('menu', 'timed', `บริการที่ตั้งระยะเวลาแล้ว ${snap.timed_services} รายการ`));
    else
      out.push(warn('menu', 'timed', 'ยังไม่มีบริการที่ตั้งระยะเวลา (นาที) ในเมนู — ต้องใส่ความยาวทุกครั้งที่จอง'));
    if (snap.profile === 'spa' && n(snap.places) === 0)
      out.push(warn('menu', 'places', 'สปายังไม่มีห้อง/เตียงที่ /resources (เปิดโมดูล "ห้อง/เตียง" ก่อน)'));
  }

  // ── people ──
  if (n(snap.owners) >= 1) out.push(ok('people', 'owner', 'มีเจ้าของอย่างน้อย 1 คน'));
  else out.push(fail('people', 'owner', 'ไม่มีเจ้าของที่ใช้งานอยู่'));
  if (n(snap.staff_without_pin) === 0) out.push(ok('people', 'pins', 'ทุกคนที่ไม่ใช่เจ้าของมี PIN แล้ว'));
  else
    out.push(
      warn('people', 'pins', `${snap.staff_without_pin} คนยังไม่มี PIN — เข้าหน้าจอล็อกที่เครื่องร้านไม่ได้`),
    );

  // ── devices ──
  if (n(snap.devices) === 0) out.push(fail('devices', 'devices', 'ยังไม่ลงทะเบียนเครื่องที่ /devices'));
  else {
    out.push(ok('devices', 'devices', `เครื่องที่ใช้งาน ${snap.devices} เครื่อง`));
    if (n(snap.cashier_devices) === 0)
      out.push(fail('devices', 'cashier', 'ไม่มีเครื่องบทบาทแคชเชียร์ (รับเงินไม่ได้)'));
  }
  const kitchenViaScreen = n(snap.kds_devices) > 0;
  const kitchenViaPrinter = (snap.printers ?? []).some(
    (p) => Array.isArray(p.stations) && p.stations.length > 0,
  );
  if (snap.profile === 'restaurant' || snap.profile === 'cafe') {
    if (kitchenViaScreen || kitchenViaPrinter)
      out.push(ok('devices', 'kitchen', 'ครัวรับออเดอร์ได้ (จอ KDS หรือเครื่องพิมพ์ใบสั่ง)'));
    else
      out.push(
        warn('devices', 'kitchen', 'ยังไม่มีจอครัว (KDS) หรือเครื่องพิมพ์ใบสั่งครัว — ครัวจะไม่เห็นออเดอร์'),
      );
  }

  // ── printing ──
  const printers = snap.printers ?? [];
  if (printers.length === 0)
    out.push(
      warn(
        'printing',
        'printers',
        'ยังไม่ได้เพิ่มเครื่องพิมพ์ — ใบเสร็จจะเป็น PDF (เพิ่มที่ /settings/printers แล้วทดสอบหน้าทดสอบ)',
      ),
    );
  else {
    out.push(ok('printing', 'printers', `เครื่องพิมพ์ ${printers.length} เครื่อง`));
    if (!snap.default_printer)
      out.push(info('printing', 'default_printer', 'ยังไม่ได้เลือกเครื่องพิมพ์ค่าเริ่มต้นของร้าน'));
  }

  // ── payments and legal gates ──
  if (snap.qr_pay_device)
    out.push(info('payments', 'qr_pay', 'ลูกค้าจ่ายที่โต๊ะผ่าน QR ได้ (ให้นักบัญชียืนยันเครื่องที่ใช้ออกใบเสร็จ)'));
  if (mod['tender.gateway'] === true && n(snap.devices_with_reader) === 0)
    out.push(warn('payments', 'reader', 'เปิดรับบัตรแล้ว แต่ไม่มีเครื่องไหนผูกเครื่องอ่านบัตร Stripe (tmr_…)'));
  if (mod['tender.credit'] === true) {
    out.push(
      warn(
        'payments',
        'credit',
        'เปิด Bestie Credit แล้ว — ทนายอนุญาตให้ใช้ภายในนิติบุคคลเดียว (21 พ.ย. 2026); ให้ทนายอ่านข้อกำหนดใน docs/LEGAL-DRAFTS.md §7 ก่อนมีลูกค้าจริง',
      ),
    );
    if (snap.credit_terms_required === true)
      out.push(
        ok('payments', 'credit_terms', 'ต้องให้ลูกค้ายอมรับข้อกำหนด Credit ก่อนเติมเงินทุกครั้ง (เปิดอยู่)'),
      );
    else
      out.push(
        warn(
          'payments',
          'credit_terms',
          'ยังไม่บังคับให้ลูกค้ายอมรับข้อกำหนด Credit ก่อนเติมเงิน (คอลัมน์ credit_terms_required ปิดหรือยังไม่ได้รัน migration 68)',
        ),
      );
    if (!/^[0-9]{13}$/.test(snap.tax_id ?? ''))
      out.push(
        warn(
          'payments',
          'credit_entity',
          'นิติบุคคลที่ออก Credit ยังไม่มีเลขผู้เสียภาษี 13 หลัก — Credit ใช้ได้เฉพาะร้านของนิติบุคคลนี้',
        ),
      );
  } else out.push(ok('payments', 'credit', 'Bestie Credit ปิดอยู่ (ถูกต้องจนกว่าทนายยืนยัน)'));
  if (mod['credit.topup.crypto'] === true) {
    if (snap.crypto_signed_off)
      out.push(warn('payments', 'crypto', 'เปิดเติมเครดิตด้วยคริปโต (มี sign-off ของทนายแล้ว)'));
    else out.push(fail('payments', 'crypto', 'เปิดเติมเครดิตด้วยคริปโตทั้งที่ยังไม่มี legal sign-off — ต้องปิด'));
  } else out.push(ok('payments', 'crypto', 'เติมเครดิตด้วยคริปโตปิดอยู่'));
  if (snap.shift_required) out.push(info('payments', 'shift', 'ร้านบังคับเปิดกะก่อนรับเงิน'));

  return out.map((r) => ({ ...r, shop: snap.name, group: r.group ?? g }));
}

const REQUIRED_VERCEL = [
  ['SUPABASE_SERVICE_ROLE_KEY', 'fail'],
  ['SUPABASE_URL', 'fail'],
  ['VITE_SUPABASE_URL', 'fail'],
  ['VITE_SUPABASE_ANON_KEY', 'fail'],
  ['STRIPE_SECRET_KEY', 'fail'],
  ['STRIPE_WEBHOOK_SECRET', 'fail'],
  ['CRON_SECRET', 'fail'],
  ['LINE_CHANNEL_SECRET', 'warn'],
  ['LINE_CHANNEL_ACCESS_TOKEN', 'warn'],
  ['LINE_CODE_SECRET', 'warn'],
  ['LINE_BASIC_ID', 'warn'],
  ['AIVORA_APP_SLUG', 'warn'],
  ['VITE_AIVORA_APP_SLUG', 'warn'],
];

/**
 * Checks of the platform itself (not one shop). `auth` = Supabase Auth config (management API), or null when it could not be read;
 * `vercelEnvNames` = names of the Vercel project's environment variables for production, or null when not read.
 */
export function checkSystem({ auth, vercelEnvNames, siteUrl = 'https://bestie-pos.vercel.app' }) {
  const g = 'system';
  const out = [];
  if (!auth)
    out.push(
      info(g, 'auth', 'อ่านค่า Supabase Auth ไม่ได้ (ต้องมี SUPABASE_ACCESS_TOKEN) — ข้ามการตรวจล็อกอิน'),
    );
  else {
    if (auth.external_google_enabled && auth.external_google_client_id)
      out.push(ok(g, 'google', 'เปิดล็อกอิน Google ใน Supabase แล้ว (มี client id)'));
    else out.push(warn(g, 'google', 'ล็อกอิน Google ยังไม่ได้เปิดใน Supabase (ปุ่ม Google จะไม่ขึ้น)'));
    if ((auth.site_url ?? '').replace(/\/$/, '') === siteUrl)
      out.push(ok(g, 'site_url', `Site URL = ${siteUrl}`));
    else
      out.push(fail(g, 'site_url', `Site URL ใน Supabase คือ "${auth.site_url}" ไม่ใช่ ${siteUrl}`));
    if ((auth.uri_allow_list ?? '').split(',').some((u) => u.trim() === `${siteUrl}/**`))
      out.push(ok(g, 'redirects', 'Redirect URL ของเว็บจริงอยู่ในรายการอนุญาต'));
    else
      out.push(
        fail(
          g,
          'redirects',
          `Redirect URLs ใน Supabase ไม่มี ${siteUrl}/** (ล็อกอิน Google/LINE กลับมาไม่ได้)`,
        ),
      );
    if (auth.smtp_host) out.push(ok(g, 'smtp', `ส่งอีเมลยืนยันผ่าน SMTP ของตัวเอง (${auth.smtp_host})`));
    else
      out.push(
        warn(
          g,
          'smtp',
          'ยังใช้ตัวส่งอีเมลของ Supabase (จำกัดไม่กี่ฉบับต่อชั่วโมง) — ตั้ง SMTP ก่อนสมัครพร้อมกันหลายคน',
        ),
      );
    if (auth.mailer_autoconfirm)
      out.push(
        warn(
          g,
          'autoconfirm',
          'สมัครด้วยอีเมลแล้วใช้ได้ทันทีโดยไม่ต้องกดลิงก์ยืนยัน — ควรเปิดการยืนยันอีเมลก่อนรับร้านจริง',
        ),
      );
    else out.push(ok(g, 'autoconfirm', 'เปิดการยืนยันอีเมลแล้ว (ต้องกดลิงก์ก่อนเข้าใช้)'));
  }
  if (!vercelEnvNames)
    out.push(
      info(g, 'vercel', 'อ่านรายชื่อตัวแปรของ Vercel ไม่ได้ (ต้องมี VERCEL_TOKEN) — ข้ามการตรวจตัวแปร'),
    );
  else {
    const have = new Set(vercelEnvNames);
    for (const [name, level] of REQUIRED_VERCEL)
      if (have.has(name)) out.push(ok(g, `env:${name}`, `${name} ตั้งแล้ว`));
      else
        out.push({
          group: g,
          id: `env:${name}`,
          level,
          text: `${name} ยังไม่ได้ตั้งใน Vercel (production)`,
        });
    if (
      have.has('ANTHROPIC_API_KEY') ||
      have.has('GOOGLE_API_KEY') ||
      have.has('GOOGLE_AI_API_KEY')
    )
      out.push(ok(g, 'env:ai', 'มี AI key อย่างน้อย 1 ตัว'));
    else
      out.push(
        warn(g, 'env:ai', 'ไม่มี AI key (ANTHROPIC_API_KEY / GOOGLE_API_KEY) — ฟีเจอร์ AI จะปิด'),
      );
    if (have.has('VITE_AIVORA_APP_SLUG') !== have.has('AIVORA_APP_SLUG'))
      out.push(
        fail(
          g,
          'sso_pair',
          'ตั้ง slug ของ Aivora ไม่ครบคู่ (ต้องมีทั้ง VITE_AIVORA_APP_SLUG และ AIVORA_APP_SLUG) — ปุ่ม LINE ล็อกอินจะใช้ไม่ได้',
        ),
      );
    if (have.has('VITE_SITE_URL') && !have.has('SITE_HOST'))
      out.push(info(g, 'site_host', 'ไม่ได้ตั้ง SITE_HOST (ใช้ค่าเริ่มต้น bestie-pos.vercel.app)'));
  }
  return out;
}

/** What a script cannot see — printed at the end so nobody mistakes a green list for "ready". */
export const MANUAL_STEPS = [
  'ทดสอบ Stripe ใน test mode ครบ (PromptPay, บัตร, แยกจ่ายหลายคน, เติมเครดิต) — docs/ENVIRONMENT.md §6',
  'ทดลองพิมพ์ใบเสร็จ/ใบสั่งครัว/เปิดลิ้นชักกับเครื่องจริงรุ่นที่ร้านใช้ — docs/PILOT-CHECKLIST.md §1',
  'นักบัญชียืนยันค่า Billing (VAT, ค่าบริการ, ปัดเศษ) และใบเสร็จ 2 ชุดเลขต่อเครื่อง',
  'ทนายอ่านข้อกำหนด Bestie Credit (docs/LEGAL-DRAFTS.md §7) ก่อนมีลูกค้าจริง — ใช้ได้ภายในนิติบุคคลเดียว',
  'ล็อกอินจริงด้วย Google และด้วย LINE (Aivora) จากมือถือ 1 ครั้ง — สคริปต์ตรวจได้แค่การตั้งค่า ไม่ได้ลองล็อกอินแทนคน',
  'ตั้ง scheduler (cron-job.org) เรียก /api/notify/tick แล้วได้ 200',
];

export function summarize(results) {
  const c = { ok: 0, fail: 0, warn: 0, info: 0 };
  for (const r of results) c[r.level] += 1;
  return c;
}

const ICON = { ok: '✅', fail: '❌', warn: '⚠️ ', info: 'ℹ️ ' };
const GROUPS = {
  system: 'ระบบ (ล็อกอิน / ตัวแปร Vercel)',
  tax: 'ภาษี',
  menu: 'เมนูและโต๊ะ',
  people: 'คน',
  devices: 'เครื่อง',
  printing: 'เครื่องพิมพ์',
  payments: 'การจ่ายเงิน',
};

export function render(results, { quiet = false } = {}) {
  const lines = [];
  let shop = null;
  let group = null;
  for (const r of results) {
    if (quiet && r.level === 'ok') continue;
    if (r.shop && r.shop !== shop) {
      shop = r.shop;
      group = null;
      lines.push('', `━━ ร้าน: ${shop} ━━`);
    } else if (!r.shop && shop !== null) {
      shop = null;
      group = null;
    }
    if (r.group !== group) {
      group = r.group;
      lines.push(`\n[${GROUPS[group] ?? group}]`);
    }
    lines.push(`  ${ICON[r.level]} ${r.text}`);
  }
  const s = summarize(results);
  lines.push('', `สรุป: ผ่าน ${s.ok} · ต้องแก้ ${s.fail} · ควรตัดสินใจ ${s.warn} · แจ้งให้ทราบ ${s.info}`);
  lines.push(
    s.fail === 0 ? 'ผลอัตโนมัติ: ไม่มีข้อที่ต้องแก้ก่อนขึ้นร้าน' : 'ผลอัตโนมัติ: ยังมีข้อที่ต้องแก้ก่อนขึ้นร้านจริง (❌)',
  );
  lines.push('', 'สิ่งที่สคริปต์ตรวจแทนไม่ได้ (ต้องทำและติ๊กเอง):');
  for (const m of MANUAL_STEPS) lines.push(`  ☐ ${m}`);
  return lines.join('\n');
}
