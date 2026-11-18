// Vercel Function: GET|POST /api/notify/tick — the scheduled step that (1) writes the daily summary after closing time,
// (2) delivers the LINE queue, (3) tidies old rows. Called by a scheduler with `Authorization: Bearer <CRON_SECRET>`.
// Safe to call as often as every minute: everything it does is idempotent (dedupe keys, claim guard).
import { createHash, timingSafeEqual } from 'node:crypto';
import { readServerEnv } from './env.js';
import { lineConfig } from './line-handler.js';
import { callRpc, createSupabaseNotifyStore, deliverQueue } from './notify-deliver.js';
import type { NotifyStore } from './notify-deliver.js';

type Env = Record<string, string | undefined>;
const reply = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

const sameSecret = (a: string, b: string): boolean =>
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

/** Bangkok wall clock of an instant. */
export function bangkokParts(ms: number): { date: string; hour: number } {
  const d = new Date(ms + 7 * 3_600_000);
  return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
}

export const SUMMARY_FROM_HOUR = 21; // the daily summary is written from 21:00 Bangkok time on

export type NotifyDeps = {
  store?: NotifyStore;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

export async function notifyTickResponse(
  request: Request,
  env: Env = process.env,
  deps: NotifyDeps = {},
): Promise<Response> {
  const secret = env.CRON_SECRET?.trim();
  const given = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1] ?? '';
  if (!secret || !sameSecret(given, secret)) return reply({ error: 'forbidden' }, 403);
  const f = deps.fetchImpl ?? fetch;
  try {
    const { supabaseUrl, serviceRoleKey } = readServerEnv(env);
    const now = (deps.now ?? Date.now)();
    const { date, hour } = bangkokParts(now);
    let summaries = 0;
    if (hour >= SUMMARY_FROM_HOUR) {
      const n = await callRpc(
        supabaseUrl,
        serviceRoleKey,
        'notify_daily_summary',
        { p_date: date },
        f,
      );
      summaries = typeof n === 'number' ? n : 0;
    }
    const cfg = lineConfig(env);
    const delivery = cfg
      ? await deliverQueue({
          store: deps.store ?? createSupabaseNotifyStore(supabaseUrl, serviceRoleKey, f),
          cfg,
          fetchImpl: f,
        })
      : null; // LINE not configured yet: the in-app inbox still works, the queue just waits
    // tidy once an hour (minute 0..4 of the first tick); cheap and idempotent either way
    const tidied =
      new Date(now).getUTCMinutes() < 5
        ? await callRpc(supabaseUrl, serviceRoleKey, 'notify_housekeeping', {}, f)
        : null;
    return reply({
      summaries,
      line: cfg ? 'configured' : 'not_configured',
      delivery,
      tidied: typeof tidied === 'number' ? tidied : 0,
    });
  } catch {
    return reply({ error: 'server_error' }, 502);
  }
}
