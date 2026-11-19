#!/usr/bin/env node
// Pilot readiness check: reads one or every shop's setup (and the platform's login / environment settings) and prints a
// pass / fix list in Thai. READ ONLY — it never changes anything.
//
//   SUPABASE_ACCESS_TOKEN=sbp_…  [VERCEL_TOKEN=…]  node tools/pilot-check/pilot-check.mjs [--store "ชื่อร้าน"] [--quiet] [--json]
//
// SUPABASE_ACCESS_TOKEN: a personal access token (Supabase dashboard → Account → Access Tokens); never the service_role key.
// VERCEL_TOKEN (optional): lets it check that the production variables exist (names only, never values).
// Exit code 1 when something marked ❌ is left, so it can also run in a script.
import { SNAPSHOT_SQL, checkStore, checkSystem, render, summarize } from './checks.mjs';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : (process.argv[i + 1] ?? '');
};
const flag = (name) => process.argv.includes(name);

const ref = process.env.SUPABASE_PROJECT_REF || 'pqomylchauwecpgqxoad';
const supabaseToken = process.env.SUPABASE_ACCESS_TOKEN;
const vercelToken = process.env.VERCEL_TOKEN;
const vercelProject = process.env.VERCEL_PROJECT || 'bestie-pos';
const siteUrl = (process.env.SITE_URL || 'https://bestie-pos.vercel.app').replace(/\/$/, '');

async function json(url, token, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`${new URL(url).host} ตอบ ${res.status}`);
  return res.json();
}

async function main() {
  if (!supabaseToken) {
    console.error('ต้องตั้ง SUPABASE_ACCESS_TOKEN (personal access token ของ Supabase) — ดูหัวไฟล์นี้');
    process.exit(2);
  }
  let auth = null;
  let vercelEnvNames = null;
  try {
    auth = await json(`https://api.supabase.com/v1/projects/${ref}/config/auth`, supabaseToken);
  } catch (e) {
    console.error(`(อ่านค่า Auth ไม่ได้: ${e.message})`);
  }
  if (vercelToken) {
    try {
      const d = await json(
        `https://api.vercel.com/v9/projects/${encodeURIComponent(vercelProject)}/env`,
        vercelToken,
      );
      vercelEnvNames = d.envs
        .filter((e) => (e.target ?? []).includes('production'))
        .map((e) => e.key);
    } catch (e) {
      console.error(`(อ่านตัวแปร Vercel ไม่ได้: ${e.message})`);
    }
  }
  const rows = await json(
    `https://api.supabase.com/v1/projects/${ref}/database/query`,
    supabaseToken,
    {
      method: 'POST',
      body: JSON.stringify({ query: SNAPSHOT_SQL }),
    },
  );
  let stores = rows?.[0]?.stores ?? [];
  const want = arg('--store');
  if (want) {
    const q = want.toLowerCase();
    stores = stores.filter((s) => s.id === want || s.name.toLowerCase().includes(q));
    if (stores.length === 0) {
      console.error(`ไม่พบร้านที่ตรงกับ "${want}"`);
      process.exit(2);
    }
  }
  const results = [
    ...checkSystem({ auth, vercelEnvNames, siteUrl }),
    ...stores.flatMap((s) => checkStore(s)),
  ];
  if (flag('--json'))
    console.log(JSON.stringify({ summary: summarize(results), results }, null, 2));
  else console.log(render(results, { quiet: flag('--quiet') }));
  process.exit(summarize(results).fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('ผิดพลาด:', e.message);
  process.exit(2);
});
