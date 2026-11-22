// Reminders to GUESTS who booked online: a bilingual text by LINE (if they sent their booking code to the Official Account) and / or
// e-mail (if they typed an address), sent once, shortly before the appointment. Called by the notification tick.
import { sendEmail } from './email.js';
import type { EmailOutcome } from './email.js';
import { LINE_MESSAGES } from './line-messages.js';
import { callRpc } from './notify-deliver.js';
import { pushLine } from './line.js';
import type { LineConfig } from './line.js';

type Env = Record<string, string | undefined>;

export type DueReminder = {
  id: string;
  starts_at: string;
  guest_name: string;
  service_name: { th?: string; en?: string } | null;
  shop_name: string;
  provider_name: string | null;
  guest_email: string | null;
  guest_line_user_id: string | null;
};

/** The reminder, in both languages (the guest's language is not known). */
export function reminderText(r: DueReminder): { subject: string; text: string } {
  const when = new Date(r.starts_at);
  const fmt = (locale: string) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: 'full',
      timeStyle: 'short',
      timeZone: 'Asia/Bangkok',
    }).format(when);
  const svcTh = r.service_name?.th ?? '';
  const svcEn = r.service_name?.en ?? svcTh;
  const who = r.provider_name ? ` / ${r.provider_name}` : '';
  const th = `${LINE_MESSAGES.guestReminder.th}: ${r.shop_name}\n${svcTh}${who}\n${fmt('th-TH')}\n${LINE_MESSAGES.guestReminderCancel.th}`;
  const en = `${LINE_MESSAGES.guestReminder.en}: ${r.shop_name}\n${svcEn}${who}\n${fmt('en-GB')}\n${LINE_MESSAGES.guestReminderCancel.en}`;
  return { subject: `${r.shop_name} · ${fmt('en-GB')}`, text: `${th}\n\n${en}` };
}

/** Sends every due reminder once. A reminder is marked done when it reached at least one channel (or no channel can ever work for it). */
export async function sendGuestReminders(args: {
  supabaseUrl: string;
  serviceRoleKey: string;
  env: Env;
  line: LineConfig | null;
  fetchImpl?: typeof fetch;
  minutes?: number;
}): Promise<{ due: number; sent: number }> {
  const f = args.fetchImpl ?? fetch;
  const due = (await callRpc(
    args.supabaseUrl,
    args.serviceRoleKey,
    'guest_reminders_due',
    { p_minutes: args.minutes ?? 180 },
    f,
  ).catch(() => [])) as DueReminder[];
  if (!Array.isArray(due)) return { due: 0, sent: 0 };
  let sent = 0;
  for (const r of due) {
    const { subject, text } = reminderText(r);
    let delivered = false;
    let retry = false;
    if (r.guest_line_user_id && args.line) {
      // the booking id is a UUID: LINE's retry key, so a lost answer can never cause a second message
      const out = await pushLine(args.line, r.guest_line_user_id, { type: 'text', text }, r.id, f);
      if (out === 'sent') delivered = true;
      else if (out === 'retry' || out === 'rate_limited') retry = true;
    } else if (r.guest_line_user_id) retry = true; // LINE is not configured yet: try again once it is
    if (r.guest_email) {
      const out: EmailOutcome = await sendEmail({ to: r.guest_email, subject, text }, args.env, f);
      if (out === 'sent') delivered = true;
      else if (out === 'failed' || out === 'not_configured') retry = true;
    }
    if (delivered || !retry) {
      await callRpc(
        args.supabaseUrl,
        args.serviceRoleKey,
        'guest_reminder_done',
        { p_id: r.id },
        f,
      ).catch(() => {});
      if (delivered) sent += 1;
    }
  }
  return { due: due.length, sent };
}

export type DueTourReminder = {
  id: string;
  starts_at: string;
  guest_name: string;
  title: { th?: string; en?: string } | null;
  shop_name: string;
  seats: number;
  guest_email: string | null;
  guest_line_user_id: string | null;
};

/** The tour reminder, in both languages (the guest's language is not known). */
export function tourReminderText(r: DueTourReminder): { subject: string; text: string } {
  const when = new Date(r.starts_at);
  const fmt = (locale: string) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: 'full',
      timeStyle: 'short',
      timeZone: 'Asia/Bangkok',
    }).format(when);
  const th = `${LINE_MESSAGES.tourReminder.th}: ${r.shop_name}\n${r.title?.th ?? ''} × ${r.seats}\n${fmt('th-TH')}\n${LINE_MESSAGES.tourReminderCancel.th}`;
  const en = `${LINE_MESSAGES.tourReminder.en}: ${r.shop_name}\n${r.title?.en ?? r.title?.th ?? ''} × ${r.seats}\n${fmt('en-GB')}\n${LINE_MESSAGES.tourReminderCancel.en}`;
  return { subject: `${r.shop_name} · ${fmt('en-GB')}`, text: `${th}\n\n${en}` };
}

/** Sends every due tour reminder once (a day ahead by default), the same rules as the appointment reminders. */
export async function sendTourReminders(args: {
  supabaseUrl: string;
  serviceRoleKey: string;
  env: Env;
  line: LineConfig | null;
  fetchImpl?: typeof fetch;
  minutes?: number;
}): Promise<{ due: number; sent: number }> {
  const f = args.fetchImpl ?? fetch;
  const due = (await callRpc(
    args.supabaseUrl,
    args.serviceRoleKey,
    'guest_tour_reminders_due',
    { p_minutes: args.minutes ?? 1440 },
    f,
  ).catch(() => [])) as DueTourReminder[];
  if (!Array.isArray(due)) return { due: 0, sent: 0 };
  let sent = 0;
  for (const r of due) {
    const { subject, text } = tourReminderText(r);
    let delivered = false;
    let retry = false;
    if (r.guest_line_user_id && args.line) {
      const out = await pushLine(args.line, r.guest_line_user_id, { type: 'text', text }, r.id, f);
      if (out === 'sent') delivered = true;
      else if (out === 'retry' || out === 'rate_limited') retry = true;
    } else if (r.guest_line_user_id) retry = true;
    if (r.guest_email) {
      const out: EmailOutcome = await sendEmail({ to: r.guest_email, subject, text }, args.env, f);
      if (out === 'sent') delivered = true;
      else if (out === 'failed' || out === 'not_configured') retry = true;
    }
    if (delivered || !retry) {
      await callRpc(
        args.supabaseUrl,
        args.serviceRoleKey,
        'guest_tour_reminder_done',
        { p_id: r.id },
        f,
      ).catch(() => {});
      if (delivered) sent += 1;
    }
  }
  return { due: due.length, sent };
}
