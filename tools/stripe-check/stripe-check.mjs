#!/usr/bin/env node
// Stripe TEST-MODE run, step by step, with a checker after each step (docs/ENVIRONMENT.md §6).
// READ ONLY: it asks Stripe (test key) and the database (SELECT only) and tells you in Thai what worked. It never pays, refunds or edits.
//
//   SUPABASE_ACCESS_TOKEN=sbp_…  [STRIPE_SECRET_KEY=sk_test_…]  node tools/stripe-check/stripe-check.mjs [--guided] [--step promptpay|cancel|cash|mismatch|card|guest|shares|all] [--since 90]
//
//   --guided   walks you through every step: it prints what to do on the tablet, waits for Enter, then checks (s = skip a step).
//   (default)  checks every step against what already happened in the last --since minutes (default 90) — run it after you did the steps.
//   --json     machine-readable output.
// A LIVE key (sk_live_…) is refused. Exit code 1 when something is ❌.
import { createInterface } from 'node:readline/promises';
import { CHECKS, STEPS, checkPreflight, probeSql, render, summarize } from './checks.mjs';

const arg = (name, d = null) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? d : (process.argv[i + 1] ?? d);
};
const flag = (name) => process.argv.includes(name);

const ref = process.env.SUPABASE_PROJECT_REF || 'pqomylchauwecpgqxoad';
const supabaseToken = process.env.SUPABASE_ACCESS_TOKEN;
const stripeKey = process.env.STRIPE_SECRET_KEY || '';
const siteUrl = (process.env.SITE_URL || 'https://bestie-pos.vercel.app').replace(/\/$/, '');
const since = Number(arg('--since', '90')) || 90;

async function stripeGet(path) {
  const res = await fetch(`https://api.stripe.com${path}`, {
    headers: { Authorization: `Bearer ${stripeKey}` },
  });
  if (!res.ok) throw new Error(`stripe ${path} ตอบ ${res.status}`);
  return res.json();
}
async function probe() {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${supabaseToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: probeSql(since) }),
  });
  if (!res.ok) throw new Error(`supabase ตอบ ${res.status}`);
  const rows = await res.json();
  return rows?.[0]?.snap ?? {};
}

async function preflight() {
  let account = null;
  let webhooks = null;
  let readers = null;
  if (stripeKey && !stripeKey.startsWith('sk_live_') && !stripeKey.startsWith('rk_live_')) {
    try {
      account = await stripeGet('/v1/account');
    } catch (e) {
      console.error(`(${e.message})`);
    }
    try {
      webhooks = (await stripeGet('/v1/webhook_endpoints?limit=100')).data;
    } catch (e) {
      console.error(`(${e.message})`);
    }
    try {
      readers = (await stripeGet('/v1/terminal/readers?limit=100')).data;
    } catch {
      readers = null;
    }
  }
  let health;
  try {
    const r = await fetch(`${siteUrl}/api/health`);
    health = { ok: r.ok, status: r.status };
  } catch {
    health = { ok: false };
  }
  return checkPreflight({ secretKey: stripeKey, account, webhooks, readers, siteUrl, health });
}

async function main() {
  if (!supabaseToken) {
    console.error('ต้องตั้ง SUPABASE_ACCESS_TOKEN (personal access token ของ Supabase) — ดูหัวไฟล์นี้');
    process.exit(2);
  }
  const want = arg('--step', 'all');
  const steps = want === 'all' ? STEPS : STEPS.filter((s) => s.id === want);
  if (want !== 'all' && want !== 'preflight' && steps.length === 0) {
    console.error(`ไม่มีขั้นชื่อ "${want}" (มี: ${STEPS.map((s) => s.id).join(', ')}, preflight, all)`);
    process.exit(2);
  }
  const all = [];
  const json = flag('--json');
  const say = (s = '') => {
    if (!json) console.log(s);
  };

  say('━━ 0. ตรวจการตั้งค่า Stripe และเว็บ (ก่อนเริ่ม)');
  const pre = await preflight();
  say(render(pre));
  all.push(...pre);
  if (pre.some((r) => r.level === 'fail' && r.id === 'key')) {
    say('\nหยุด: แก้เรื่องคีย์ก่อน');
    return finish(all, json);
  }
  if (want === 'preflight') return finish(all, json);

  const rl =
    flag('--guided') && process.stdin.isTTY
      ? createInterface({ input: process.stdin, output: process.stdout })
      : null;
  let n = 0;
  for (const step of steps) {
    n += 1;
    say(`\n━━ ${n}. ${step.title}${step.optional ? '  (ไม่บังคับ)' : ''}`);
    if (rl) {
      say(`   ทำ: ${step.wait}`);
      const a = (await rl.question('   เสร็จแล้วกด Enter เพื่อตรวจ (พิมพ์ s แล้ว Enter เพื่อข้าม): '))
        .trim()
        .toLowerCase();
      if (a === 's') {
        say('   ข้ามขั้นนี้');
        continue;
      }
    }
    const snap = await probe();
    const res = CHECKS[step.id](snap);
    say(render(res));
    all.push(...res);
  }
  rl?.close();
  return finish(all, json);
}

function finish(all, json) {
  const s = summarize(all);
  if (json) console.log(JSON.stringify({ summary: s, results: all }, null, 2));
  else {
    console.log(`\nสรุป: ✅ ${s.ok}  ❌ ${s.fail}  ⚠️ ${s.warn}  ℹ️ ${s.info}`);
    console.log(
      s.fail > 0
        ? 'ยังมีข้อ ❌ — แก้แล้วรันใหม่ (ถ้าเป็นความต่างของ Stripe ให้แก้ functions/src/stripe.ts)'
        : 'ไม่มีข้อ ❌ ในขั้นที่ทดสอบแล้ว (⚠️ = ขั้นที่ยังไม่ได้ทำหรือควรดู)',
    );
    console.log('ข้อควรจำ: สคริปต์นี้ตรวจจากฐานข้อมูล ไม่ได้ทดสอบเครื่องพิมพ์ ลิ้นชัก หรือหน้าจอจริง');
  }
  process.exit(s.fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('ผิดพลาด:', e.message);
  process.exit(2);
});
