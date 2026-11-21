// Stripe test-mode run: the RULES that decide, from what Stripe and the database say, whether each step of docs/ENVIRONMENT.md §6 worked.
// Pure functions (no network, no clock) so they are unit-tested from functions/src/stripe-check.test.ts; stripe-check.mjs does the talking.

/** @typedef {'ok'|'fail'|'warn'|'info'} Level */

const ok = (id, text) => ({ id, level: 'ok', text });
const fail = (id, text) => ({ id, level: 'fail', text });
const warn = (id, text) => ({ id, level: 'warn', text });
const info = (id, text) => ({ id, level: 'info', text });

export const REQUIRED_EVENTS = [
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
];
export const WEBHOOK_PATH = '/api/stripe/webhook';

/** The steps in the order a person does them. `wait` = what the person must do before the check runs. */
export const STEPS = [
  {
    id: 'promptpay',
    title: 'PromptPay QR จ่ายสำเร็จ แล้วบิลปิดเอง',
    wait: 'เปิดบิลที่แท็บเล็ต → รับเงิน → PromptPay QR → กดอนุมัติการจ่ายทดสอบใน Stripe (Authorize test payment) แล้วรอจนหน้าจอขึ้นใบเสร็จ',
  },
  {
    id: 'cancel',
    title: 'ยกเลิก QR แล้วใบเสร็จไม่ข้ามเลข',
    wait: 'เปิดบิลใหม่ → PromptPay QR → กดยกเลิก → สร้าง QR ใหม่ในบิลเดิมแล้วจ่ายให้สำเร็จ',
  },
  {
    id: 'cash',
    title: 'จ่ายเงินสดต่อหลังยกเลิก ใบเสร็จชุด A-',
    wait: 'เปิดบิลใหม่ → PromptPay QR → ยกเลิก → จ่ายเงินสดจนจบ',
  },
  {
    id: 'mismatch',
    title: 'ยอดไม่ตรง → needs_review บิลไม่ปิด',
    wait: 'เปิดบิล → PromptPay QR → (ขณะ QR ค้าง) เพิ่มรายการในบิล → อนุมัติการจ่ายทดสอบ → บิลต้องไม่ปิดและมีเตือน',
  },
  {
    id: 'card',
    title: 'เครื่องรูดบัตร (ถ้ามี)',
    wait: 'รับเงิน → บัตร → ส่งยอดไปเครื่องอ่าน → แตะบัตรทดสอบ',
    optional: true,
  },
  {
    id: 'guest',
    title: 'ลูกค้าจ่าย PromptPay จากหน้า QR โต๊ะ',
    wait: 'เปิด /t/<รหัส> บนมือถือ → สั่ง → พนักงานส่งครัว → กดจ่าย PromptPay → อนุมัติการจ่ายทดสอบ',
    optional: true,
  },
  {
    id: 'shares',
    title: 'จ่ายหลายส่วน (PromptPay หลายครั้งในบิลเดียว)',
    wait: 'แท็บ Split: แบ่งเป็น 2 ส่วน PromptPay → จ่ายส่วนแรก → จ่ายส่วนสุดท้าย',
    optional: true,
  },
];

// ── preflight: Stripe's own account and webhook settings ──────────────────────────────────────
/**
 * @param {{ secretKey?: string, account?: any, webhooks?: any[] | null, readers?: any[] | null, siteUrl: string, health?: { ok: boolean, status?: number } | null }} p
 */
export function checkPreflight(p) {
  const out = [];
  const key = p.secretKey ?? '';
  if (!key) {
    out.push(
      info(
        'key',
        'ไม่ได้ส่ง STRIPE_SECRET_KEY ให้สคริปต์ — ข้ามการถาม Stripe โดยตรง (ตัวตรวจฝั่งฐานข้อมูลยังทำงานปกติ)',
      ),
    );
  } else if (key.startsWith('sk_live_') || key.startsWith('rk_live_')) {
    out.push(fail('key', 'นี่คือคีย์ LIVE (เงินจริง) — หยุดทันที ใช้คีย์ทดสอบ sk_test_… เท่านั้น'));
    return out;
  } else if (key.startsWith('sk_test_') || key.startsWith('rk_test_')) {
    out.push(ok('key', 'ใช้คีย์โหมดทดสอบ (sk_test_…)'));
  } else {
    out.push(fail('key', 'รูปแบบคีย์ไม่ถูกต้อง (ต้องขึ้นต้น sk_test_)'));
    return out;
  }
  if (p.account) {
    const a = p.account;
    if (a.country === 'TH') out.push(ok('country', 'บัญชี Stripe ประเทศไทย (TH)'));
    else
      out.push(
        warn('country', `บัญชี Stripe เป็นประเทศ ${a.country ?? '?'} — PromptPay ใช้ได้เฉพาะบัญชีไทย`),
      );
    const pp = a.capabilities?.promptpay_payments;
    if (pp === 'active')
      out.push(ok('promptpay', 'เปิด PromptPay แล้ว (promptpay_payments = active)'));
    else
      out.push(
        fail(
          'promptpay',
          `PromptPay ยังไม่เปิด (สถานะ: ${pp ?? 'ไม่มี'}) — Stripe → Settings → Payment methods`,
        ),
      );
    if (a.charges_enabled === false)
      out.push(fail('charges', 'บัญชีรับเงินยังไม่ได้ (charges_enabled = false)'));
  }
  if (p.webhooks) {
    const want = p.siteUrl.replace(/\/$/, '') + WEBHOOK_PATH;
    const ep = p.webhooks.find((w) => String(w.url).replace(/\/$/, '') === want);
    if (!ep) out.push(fail('webhook', `ไม่มี webhook ที่ชี้ ${want} — Stripe → Developers → Webhooks`));
    else {
      if (ep.status && ep.status !== 'enabled')
        out.push(fail('webhook', `webhook ปิดอยู่ (สถานะ ${ep.status})`));
      const events = ep.enabled_events ?? [];
      const missing = events.includes('*')
        ? []
        : REQUIRED_EVENTS.filter((e) => !events.includes(e));
      if (missing.length)
        out.push(fail('webhook-events', `webhook ยังไม่ได้ติ๊ก event: ${missing.join(', ')}`));
      else out.push(ok('webhook', 'webhook ชี้ถูกที่และฟัง event ครบ'));
    }
  }
  if (p.readers) {
    if (p.readers.length === 0)
      out.push(info('readers', 'ยังไม่มีเครื่องอ่านบัตร (Terminal reader) — ข้ามขั้น "บัตร" ได้'));
    else
      out.push(
        ok(
          'readers',
          `พบเครื่องอ่านบัตร ${p.readers.length} เครื่อง (${p.readers.map((r) => r.id).join(', ')})`,
        ),
      );
  }
  if (p.health) {
    if (p.health.ok) out.push(ok('health', `${p.siteUrl}/api/health ตอบปกติ`));
    else if (p.health.status === undefined)
      out.push(
        warn(
          'health',
          `เปิด ${p.siteUrl}/api/health จากเครื่องนี้ไม่ได้ (ไม่มีสัญญาณหรือเครือข่ายบล็อก) — ลองเปิดในเบราว์เซอร์เอง`,
        ),
      );
    else out.push(fail('health', `${p.siteUrl}/api/health ตอบผิดปกติ (สถานะ ${p.health.status})`));
  }
  return out;
}

// ── database checks ───────────────────────────────────────────────────────────────────────────
const PLUS = /^[A-Z]{1,2}\+[0-9]{6,9}$/;
const MINUS = /^[A-Z]{1,2}-[0-9]{6,9}$/;
const seqOf = (n) => Number(String(n).replace(/^[A-Z]{1,2}[-+]/, '')) || 0;

/**
 * Consecutive numbers per device and series: a cancelled or failed attempt must never use up a number.
 * `receipts` = [{ device_id, number }] for ONE series.
 */
export function gapsIn(receipts) {
  const byDev = new Map();
  for (const r of receipts) {
    const k = r.device_id ?? '?';
    byDev.set(k, [...(byDev.get(k) ?? []), seqOf(r.number)]);
  }
  const gaps = [];
  for (const [dev, nums] of byDev) {
    const s = [...nums].sort((a, b) => a - b);
    for (let i = 1; i < s.length; i++)
      if (s[i] !== s[i - 1] + 1) gaps.push({ device: dev, from: s[i - 1], to: s[i] });
  }
  return gaps;
}

const receiptOf = (snap, orderId) => (snap.receipts ?? []).find((r) => r.order_id === orderId);
const paymentsOf = (snap, orderId) => (snap.payments ?? []).filter((p) => p.order_id === orderId);
const attemptsOf = (snap, orderId) => (snap.attempts ?? []).filter((a) => a.order_id === orderId);
const none = (id, text) => [warn(id, text)];

/** Step 1: a PromptPay attempt that Stripe confirmed closed its bill by itself. */
export function checkPromptPay(snap) {
  const done = (snap.attempts ?? []).filter(
    (a) => a.tender === 'promptpay' && a.status === 'succeeded' && !a.partial,
  );
  if (done.length === 0)
    return none('promptpay', 'ยังไม่พบ PromptPay ที่จ่ายสำเร็จในช่วงเวลานี้ — ทำขั้นนี้แล้วรันใหม่');
  const out = [];
  for (const a of done) {
    const tag = `บิล ${a.order_number}`;
    const r = receiptOf(snap, a.order_id);
    const pays = paymentsOf(snap, a.order_id).filter((p) => p.tender === 'promptpay');
    if (a.order_status !== 'paid')
      out.push(fail('promptpay', `${tag}: Stripe ยืนยันแล้วแต่บิลยังไม่ปิด (สถานะ ${a.order_status})`));
    else if (!r) out.push(fail('promptpay', `${tag}: บิลปิดแต่ไม่มีใบเสร็จ`));
    else if (!PLUS.test(r.number))
      out.push(fail('promptpay', `${tag}: เลขใบเสร็จ ${r.number} ไม่ใช่ชุดออนไลน์ (A+000001)`));
    else if (pays.length !== 1)
      out.push(fail('promptpay', `${tag}: ควรมีรายการชำระ PromptPay 1 รายการ แต่พบ ${pays.length}`));
    else if (Number(pays[0].amount) !== Number(a.amount))
      out.push(
        fail('promptpay', `${tag}: ยอดที่บันทึก ${pays[0].amount} ไม่เท่ายอดที่เรียกเก็บ ${a.amount}`),
      );
    else if (pays[0].reference !== a.provider_ref)
      out.push(fail('promptpay', `${tag}: รหัสอ้างอิง Stripe ในรายการชำระไม่ตรงกับคำขอ`));
    else
      out.push(
        ok(
          'promptpay',
          `${tag}: จ่ายสำเร็จ บิลปิดเอง ใบเสร็จ ${r.number} ยอด ${(a.amount / 100).toFixed(2)}`,
        ),
      );
  }
  const ev = (snap.events ?? []).filter((e) => e.type === 'payment_intent.succeeded');
  if (ev.length === 0)
    out.push(
      fail(
        'events',
        'ตาราง payment_events ไม่มี payment_intent.succeeded เลย — webhook ไม่เคยถึงเซิร์ฟเวอร์',
      ),
    );
  else out.push(ok('events', `webhook ถึงเซิร์ฟเวอร์แล้ว ${ev.length} ครั้ง`));
  return out;
}

/** Step 2: a cancelled QR; the same bill later paid; the online receipt numbers have no hole. */
export function checkCancel(snap) {
  const cancelled = (snap.attempts ?? []).filter((a) => a.status === 'canceled');
  if (cancelled.length === 0) return none('cancel', 'ยังไม่พบ QR ที่ถูกยกเลิก — ทำขั้นนี้แล้วรันใหม่');
  const out = [];
  for (const c of cancelled) {
    const later = attemptsOf(snap, c.order_id).filter((a) => a.created_at > c.created_at);
    if (later.length === 0)
      out.push(warn('cancel', `บิล ${c.order_number}: ยกเลิกแล้วแต่ยังไม่ได้สร้าง QR ใหม่ในบิลเดิม`));
    else
      out.push(ok('cancel', `บิล ${c.order_number}: ยกเลิกแล้วสร้างคำขอใหม่ได้ (${later.length} ครั้ง)`));
  }
  const gaps = gapsIn((snap.receipts ?? []).filter((r) => PLUS.test(r.number)));
  if (gaps.length)
    out.push(
      fail(
        'gaps',
        `เลขใบเสร็จชุดออนไลน์ข้าม: ${gaps.map((g) => `${g.from}→${g.to}`).join(', ')} (คำขอที่ยกเลิกต้องไม่กินเลข)`,
      ),
    );
  else if ((snap.receipts ?? []).some((r) => PLUS.test(r.number)))
    out.push(ok('gaps', 'เลขใบเสร็จชุดออนไลน์เรียงต่อกัน ไม่ข้าม'));
  return out;
}

/** Step 3: cash after a cancelled QR uses the offline series. */
export function checkCash(snap) {
  const cancelledOrders = new Set(
    (snap.attempts ?? []).filter((a) => a.status === 'canceled').map((a) => a.order_id),
  );
  const cash = [...cancelledOrders]
    .map((id) => ({ id, r: receiptOf(snap, id), pays: paymentsOf(snap, id) }))
    .filter((x) => x.r && x.pays.some((p) => p.tender === 'cash'));
  if (cash.length === 0) return none('cash', 'ยังไม่พบบิลที่ยกเลิก QR แล้วจ่ายเงินสด — ทำขั้นนี้แล้วรันใหม่');
  return cash.map((x) =>
    MINUS.test(x.r.number)
      ? ok('cash', `ใบเสร็จเงินสด ${x.r.number} (ชุด A- เหมือนเดิม)`)
      : fail('cash', `ใบเสร็จเงินสด ${x.r.number} ควรเป็นชุด A-000001`),
  );
}

/** Step 4: the amount changed while the QR was open → parked for a person, the bill stays open, an audit line exists. */
export function checkMismatch(snap) {
  const rev = (snap.attempts ?? []).filter((a) => a.status === 'needs_review');
  if (rev.length === 0) return none('mismatch', 'ยังไม่พบรายการ needs_review — ทำขั้นนี้แล้วรันใหม่');
  const out = [];
  for (const a of rev) {
    const tag = `บิล ${a.order_number}`;
    if (a.order_status === 'paid')
      out.push(fail('mismatch', `${tag}: ยอดไม่ตรงแต่บิลถูกปิด — ต้องค้างไว้ให้คนตรวจ`));
    else
      out.push(
        ok('mismatch', `${tag}: ค้างเป็น needs_review บิลยังเปิด (${a.error ?? 'ไม่มีเหตุผลบันทึก'})`),
      );
    const au = (snap.audit ?? []).find(
      (x) => x.entity_id === a.id && x.action === 'payment.tender' && x.detail?.review === true,
    );
    out.push(
      au
        ? ok('audit', `${tag}: มีบันทึกตรวจสอบ payment.tender review=true`)
        : fail('audit', `${tag}: ไม่พบบันทึกตรวจสอบ payment.tender review=true`),
    );
  }
  const n = (snap.notices ?? []).filter((x) => x.kind === 'payment.review').length;
  out.push(
    n > 0
      ? ok('notice', `ผู้จัดการได้รับแจ้งเตือนด่วน ${n} รายการ`)
      : warn('notice', 'ไม่พบการแจ้งเตือน payment.review ในกล่องแจ้งเตือน'),
  );
  return out;
}

/** Step 5 (optional): card reader. */
export function checkCard(snap) {
  const card = (snap.attempts ?? []).filter(
    (a) => a.tender === 'gateway' && a.status === 'succeeded' && !a.partial,
  );
  if (card.length === 0) return none('card', 'ยังไม่พบการจ่ายบัตรที่สำเร็จ (ข้ามได้ถ้าไม่มีเครื่องอ่าน)');
  return card.map((a) => {
    const r = receiptOf(snap, a.order_id);
    return a.order_status === 'paid' && r && PLUS.test(r.number)
      ? ok('card', `บิล ${a.order_number}: จ่ายบัตรสำเร็จ ใบเสร็จ ${r.number}`)
      : fail('card', `บิล ${a.order_number}: จ่ายบัตรสำเร็จแต่บิล/ใบเสร็จไม่ถูกต้อง`);
  });
}

/** Step 6 (optional): the guest paid from the table page (guest bills are QR001…). */
export function checkGuest(snap) {
  const g = (snap.attempts ?? []).filter(
    (a) =>
      a.tender === 'promptpay' &&
      a.status === 'succeeded' &&
      /^QR[0-9]+$/.test(a.order_number ?? ''),
  );
  if (g.length === 0) return none('guest', 'ยังไม่พบการจ่ายของลูกค้าจากหน้า QR โต๊ะ (ข้ามได้)');
  return g.map((a) => {
    const r = receiptOf(snap, a.order_id);
    return a.order_status === 'paid' && r && PLUS.test(r.number)
      ? ok('guest', `บิล ${a.order_number}: ลูกค้าจ่ายเอง ใบเสร็จ ${r.number}`)
      : fail('guest', `บิล ${a.order_number}: ลูกค้าจ่ายแล้วแต่บิล/ใบเสร็จไม่ถูกต้อง`);
  });
}

/** Step 7 (optional): several PromptPay shares on one bill; each held, then one receipt with every share. */
export function checkShares(snap) {
  const byOrder = new Map();
  for (const p of snap.partials ?? [])
    byOrder.set(p.order_id, [...(byOrder.get(p.order_id) ?? []), p]);
  if (byOrder.size === 0) return none('shares', 'ยังไม่พบการจ่ายหลายส่วน (ข้ามได้)');
  const out = [];
  for (const [orderId, shares] of byOrder) {
    const a = attemptsOf(snap, orderId)[0];
    const tag = `บิล ${a?.order_number ?? orderId.slice(0, 8)}`;
    const r = receiptOf(snap, orderId);
    const open = shares.filter((s) => s.status === 'held');
    if (r && open.length === 0 && shares.every((s) => s.status === 'applied')) {
      const sum = paymentsOf(snap, orderId).reduce((t, p) => t + Number(p.amount), 0);
      if (sum === Number(r.payable))
        out.push(ok('shares', `${tag}: ${shares.length} ส่วน ถูกรวมในใบเสร็จ ${r.number} ยอดรวมตรง`));
      else out.push(fail('shares', `${tag}: ผลรวมรายการชำระ ${sum} ไม่เท่ายอดสุทธิ ${r.payable}`));
    } else if (!r && open.length > 0) {
      out.push(
        info('shares', `${tag}: จ่ายแล้ว ${open.length} ส่วน ยังรอส่วนสุดท้าย (บิลถูกล็อกอยู่ตามที่ออกแบบ)`),
      );
    } else {
      out.push(fail('shares', `${tag}: สถานะส่วนที่จ่ายไม่สอดคล้องกับใบเสร็จ`));
    }
  }
  return out;
}

export const CHECKS = {
  promptpay: checkPromptPay,
  cancel: checkCancel,
  cash: checkCash,
  mismatch: checkMismatch,
  card: checkCard,
  guest: checkGuest,
  shares: checkShares,
};

/** The read-only question sent to the database: everything the checks above need, for the last `since` minutes. */
export const probeSql = (since) => {
  const mins = Math.max(1, Math.min(1440, Math.trunc(Number(since) || 60)));
  return `
with w as (select now() - make_interval(mins => ${mins}) as t0),
att as (
  select a.id, a.order_id, a.device_id, a.tender, a.status, a.amount, a.provider_ref, a.error,
         coalesce((a.snapshot ->> 'partial')::boolean, false) as partial,
         a.created_at, o.number as order_number, o.status as order_status
    from public.payment_attempts a join public.orders o on o.id = a.order_id, w
   where a.created_at >= w.t0 and a.provider = 'stripe'
)
select jsonb_build_object(
  'attempts', coalesce((select jsonb_agg(to_jsonb(att) order by att.created_at) from att), '[]'),
  'receipts', coalesce((select jsonb_agg(jsonb_build_object('order_id', r.order_id, 'number', r.number, 'device_id', r.device_id, 'payable', r.payable, 'issued_at', r.issued_at) order by r.issued_at)
                          from public.receipts r where r.device_id in (select device_id from att) and r.issued_at >= (select t0 from w) - interval '1 day'), '[]'),
  'payments', coalesce((select jsonb_agg(jsonb_build_object('order_id', p.order_id, 'tender', p.tender, 'amount', p.amount, 'reference', p.reference, 'status', p.status))
                          from public.payments p where p.order_id in (select order_id from att)), '[]'),
  'partials', coalesce((select jsonb_agg(jsonb_build_object('order_id', x.order_id, 'status', x.status, 'amount', x.amount))
                          from public.order_partial_payments x where x.order_id in (select order_id from att)), '[]'),
  'events', coalesce((select jsonb_agg(jsonb_build_object('type', e.type)) from public.payment_events e where e.received_at >= (select t0 from w)), '[]'),
  'audit', coalesce((select jsonb_agg(jsonb_build_object('entity_id', l.entity_id, 'action', l.action, 'detail', l.detail))
                       from public.audit_log l where l.action = 'payment.tender' and l.created_at >= (select t0 from w)), '[]'),
  'notices', coalesce((select jsonb_agg(jsonb_build_object('kind', n.kind)) from public.app_notifications n where n.kind = 'payment.review' and n.created_at >= (select t0 from w)), '[]')
) as snap`;
};

const ICON = { ok: '✅', fail: '❌', warn: '⚠️', info: 'ℹ️' };
export const summarize = (results) =>
  results.reduce((a, r) => ({ ...a, [r.level]: (a[r.level] ?? 0) + 1 }), {
    ok: 0,
    fail: 0,
    warn: 0,
    info: 0,
  });
export const render = (results) => results.map((r) => `  ${ICON[r.level]} ${r.text}`).join('\n');
