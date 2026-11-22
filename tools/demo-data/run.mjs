#!/usr/bin/env node
// Demo data for showing Bestie POS to a company owner: accounts for every role, four shops, a catalogue, customers, bookings and
// 37 paid bills made by the real database functions AS each person (RLS and permission checks apply). Everything is tagged
// "[DEMO]" / the e-mail domain below, and `cleanup` removes all of it before go-live.
//
//   DEMO_PASSWORD='…' SUPABASE_ACCESS_TOKEN=sbp_… node tools/demo-data/run.mjs remote setup simulate
//   node tools/demo-data/run.mjs remote cleanup                     (add --yes to really delete)
//   LOCAL_PSQL="psql -h /tmp/devpg -p 54998 -U postgres -d demo" node tools/demo-data/run.mjs local setup simulate
//
// steps: setup (accounts, shops, catalogue …) · simulate (shifts, bills, bookings …) · cleanup (delete everything demo)
// The password is NOT in this repository: pass it with DEMO_PASSWORD. Never use these accounts or that password for real people.
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const [target, ...rest] = process.argv.slice(2);
const steps = rest.filter((a) => !a.startsWith('--'));
const yes = rest.includes('--yes');
if (!['local', 'remote'].includes(target) || steps.length === 0) {
  console.error(
    'usage: run.mjs <local|remote> <setup|simulate|retail|network|phase4|extras|growth|cleanup>… [--yes]',
  );
  process.exit(2);
}
const ref = process.env.SUPABASE_PROJECT_REF || 'pqomylchauwecpgqxoad';
const token = process.env.SUPABASE_ACCESS_TOKEN;
let password = process.env.DEMO_PASSWORD;

const files = (prefix) =>
  readdirSync(join(here, 'sql'))
    .filter((f) => f.endsWith('.sql') && f.startsWith(prefix))
    .sort();
const STEP_FILES = {
  setup: () => ['00_helpers.sql', ...files('1')],
  simulate: () => ['00_helpers.sql', ...files('2')],
  // an extra shop (Retail) with sales and product returns, added to an existing demo; safe to run again (it skips what exists)
  retail: () => ['00_helpers.sql', '20_sim_helpers.sql', ...files('3')],
  // the island network: a second business, Tourist Passes, Points earned at one business and spent at the other (needs migration 63; safe to run again)
  network: () => ['00_helpers.sql', '20_sim_helpers.sql', ...files('4')],
  // a karaoke shop (needs migrations 70 + 73) and a resort with room charges (needs migration 74); safe to run again
  phase4: () => ['00_helpers.sql', '20_sim_helpers.sql', ...files('5')],
  // the newest modules (delivery, tax invoice, kiosk, folio nights, split to a room, karaoke online booking; needs migrations 75–81 and the phase4 step); safe to run again
  extras: () => ['00_helpers.sql', '20_sim_helpers.sql', ...files('6')],
  // sets A–D and tours online (needs migrations 82–88 and the setup step); safe to run again
  growth: () => ['00_helpers.sql', '20_sim_helpers.sql', ...files('7')],
  cleanup: () => ['00_helpers.sql', ...files('9')],
};

async function exec(sql, name) {
  if (target === 'local') {
    const cmd = (process.env.LOCAL_PSQL || '').split(' ').filter(Boolean);
    if (cmd.length === 0) throw new Error('set LOCAL_PSQL');
    const out = execFileSync(cmd[0], [...cmd.slice(1), '-v', 'ON_ERROR_STOP=1', '-q', '-At'], {
      input: sql,
      encoding: 'utf8',
      maxBuffer: 1 << 26,
    });
    return out.trim();
  }
  if (!token) throw new Error('set SUPABASE_ACCESS_TOKEN (personal access token)');
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${name}: ${res.status} ${text.slice(0, 600)}`);
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

// the demo menu pictures (tools/demo-data/images, drawn by make-images.mjs), saved as the owner would upload them
async function seedImages() {
  const manifest = JSON.parse(readFileSync(join(here, 'images', 'manifest.json'), 'utf8'));
  const owner = 'owner.demo@bestiedemo.example';
  for (let i = 0; i < manifest.length; i += 8) {
    const sql = manifest
      .slice(i, i + 8)
      .map((m) => {
        const b64 = readFileSync(join(here, 'images', m.file)).toString('base64');
        const lit = (x) => `'${x.replaceAll("'", "''")}'`;
        return `do $$ begin if (select image_v from public.menu_items where id = demo.item(${lit(m.store)}, ${lit(m.item)})) is null then
  perform demo.val(${lit(owner)}, format($q$select public.save_menu_image(%L, 'image/jpeg', %L)::text$q$, demo.item(${lit(m.store)}, ${lit(m.item)}), ${lit(b64)}));
end if; end $$;`;
      })
      .join('\n');
    await exec(sql, `images ${i}`);
  }
  console.log(`▶ setup/images … ok (${manifest.length} pictures)`);
}

async function main() {
  for (const step of steps) {
    if (!STEP_FILES[step]) throw new Error(`unknown step ${step}`);
    if ((step === 'setup' || step === 'retail') && !password)
      throw new Error('set DEMO_PASSWORD (the password every demo account gets)');
    if (step === 'network' && !password) {
      // only the two accounts of the second business are new: without the shared demo password they get a random one nobody knows (set a password for them in Supabase Auth, or run this step again after cleanup with DEMO_PASSWORD)
      password = randomBytes(18).toString('base64url');
      console.log(
        '▶ network: DEMO_PASSWORD is not set — the two new Palm Beach accounts get a random password (not shown)',
      );
    }
    if (step === 'cleanup' && !yes) {
      console.log(
        'cleanup is DESTRUCTIVE (deletes the demo organisation, its accounts and every record). Re-run with --yes to do it.',
      );
      continue;
    }
    for (const f of STEP_FILES[step]()) {
      const raw = readFileSync(join(here, 'sql', f), 'utf8');
      const sql = raw.replaceAll('__DEMO_PASSWORD__', (password ?? '').replaceAll("'", "''"));
      const t0 = Date.now();
      process.stdout.write(`▶ ${step}/${f} … `);
      const out = await exec(sql, f);
      console.log(`ok (${((Date.now() - t0) / 1000).toFixed(1)}s)${out ? `\n${out}` : ''}`);
    }
    if (step === 'setup') await seedImages();
  }
}
// the helpers (demo.*) can act as any demo user: they must not outlive the run, whatever happened
const dropHelpers = () =>
  exec('drop schema if exists demo cascade', 'drop helpers').catch(() => {});

main()
  .then(dropHelpers)
  .catch(async (e) => {
    await dropHelpers();
    console.error('\n✖', e.message);
    process.exit(1);
  });
