// Vercel Function: GET|POST /api/notify/tick — the scheduled step that (1) writes the daily summary after closing time,
// (2) delivers the LINE queue, (3) tidies old rows. Called by a scheduler with `Authorization: Bearer <CRON_SECRET>`.
// Safe to call as often as every minute: everything it does is idempotent (dedupe keys, claim guard).
import { createHash, timingSafeEqual } from 'node:crypto';
import { readServerEnv } from './env.js';
import { sendGuestReminders } from './guest-reminders.js';
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
    // appointments starting within 90 minutes tell the provider's linked staff member (once each)
    const reminded = await callRpc(
      supabaseUrl,
      serviceRoleKey,
      'appointment_reminders',
      { p_minutes: 90 },
      f,
    ).catch(() => 0);
    const cfg = lineConfig(env);
    // guests who booked online and left a LINE / e-mail contact get one reminder shortly before the appointment
    const guests = await sendGuestReminders({
      supabaseUrl,
      serviceRoleKey,
      env,
      line: cfg,
      fetchImpl: f,
    }).catch(() => ({ due: 0, sent: 0 }));
    const delivery = cfg
      ? await deliverQueue({
          store: deps.store ?? createSupabaseNotifyStore(supabaseUrl, serviceRoleKey, f),
          cfg,
          fetchImpl: f,
        })
      : null; // LINE not configured yet: the in-app inbox still works, the queue just waits
    // tidy once an hour (minute 0..4 of the first tick); cheap and idempotent either way
    const tidyNow = new Date(now).getUTCMinutes() < 15; // the scheduler may be a few minutes late; the tidy-up is safe to repeat
    const tidied = tidyNow
      ? await callRpc(supabaseUrl, serviceRoleKey, 'notify_housekeeping', {}, f)
      : null;
    // contacts of finished / cancelled bookings are erased (they exist for the reminder only)
    const contactsErased = tidyNow
      ? await callRpc(supabaseUrl, serviceRoleKey, 'guest_contacts_cleanup', {}, f).catch(() => 0)
      : 0;
    // hair photos past their time (or of cancelled bookings) are erased; hourly, so no photo outlives its time by more than an hour
    const photosErased = tidyNow
      ? await callRpc(supabaseUrl, serviceRoleKey, 'hair_photos_cleanup', {}, f).catch(() => 0)
      : 0;
    // client photos older than their 12 months are erased
    const clientPhotosErased = tidyNow
      ? await callRpc(supabaseUrl, serviceRoleKey, 'client_photos_cleanup', {}, f).catch(() => 0)
      : 0;
    // health forms older than 24 months and passes unused for 36 months are erased (the retention in docs/LEGAL-DRAFTS.md §3)
    const healthErased = tidyNow
      ? await callRpc(supabaseUrl, serviceRoleKey, 'health_intakes_cleanup', {}, f).catch(() => 0)
      : 0;
    const passesErased = tidyNow
      ? await callRpc(supabaseUrl, serviceRoleKey, 'network_passes_cleanup', {}, f).catch(() => 0)
      : 0;
    // audit rows older than the retention (default 5 years) are removed in bulk; nothing else can delete audit rows
    const purged = tidyNow
      ? await callRpc(supabaseUrl, serviceRoleKey, 'audit_purge', {}, f)
      : null;
    return reply({
      summaries,
      reminders: typeof reminded === 'number' ? reminded : 0,
      guestReminders: guests,
      clientPhotosErased: typeof clientPhotosErased === 'number' ? clientPhotosErased : 0,
      hairPhotosErased: typeof photosErased === 'number' ? photosErased : 0,
      guestContactsErased: typeof contactsErased === 'number' ? contactsErased : 0,
      healthFormsErased: typeof healthErased === 'number' ? healthErased : 0,
      passesErased: typeof passesErased === 'number' ? passesErased : 0,
      line: cfg ? 'configured' : 'not_configured',
      delivery,
      tidied: typeof tidied === 'number' ? tidied : 0,
      auditPurged: typeof purged === 'number' ? purged : 0,
    });
  } catch {
    return reply({ error: 'server_error' }, 502);
  }
}
