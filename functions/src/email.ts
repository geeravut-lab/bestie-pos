// Sending one plain e-mail through Resend (https://resend.com). Server only. Not configured (no key / sender) = nothing is sent and
// the caller is told, so a reminder is never marked as sent by mistake. No customer data is ever put in a URL or header.
type Env = Record<string, string | undefined>;

export type EmailOutcome = 'sent' | 'not_configured' | 'failed' | 'rejected';

export async function sendEmail(
  args: { to: string; subject: string; text: string },
  env: Env = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<EmailOutcome> {
  const key = env.RESEND_API_KEY?.trim();
  const from = env.EMAIL_FROM?.trim();
  if (!key || !from) return 'not_configured';
  const valid = (a: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a);
  if (!valid(args.to)) return 'rejected';
  // TEST MODE: with EMAIL_REDIRECT_TO set, every e-mail goes to that one address instead (Resend's shared test sender may only
  // write to its owner), and the subject / text say who it was meant for. Remove the variable once a verified domain is used.
  const redirect = env.EMAIL_REDIRECT_TO?.trim();
  if (redirect && !valid(redirect)) return 'not_configured';
  const to = redirect || args.to;
  const subject = redirect ? `[TEST → ${args.to}] ${args.subject}` : args.subject;
  const text = redirect
    ? `(Test mode: this e-mail was meant for ${args.to})\n\n${args.text}`
    : args.text;
  try {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [to],
        subject: subject.slice(0, 200),
        text,
      }),
    });
    if (res.ok) return 'sent';
    return res.status >= 400 && res.status < 500 && res.status !== 429 ? 'rejected' : 'failed';
  } catch {
    return 'failed';
  }
}
