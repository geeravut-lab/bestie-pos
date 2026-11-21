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
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(args.to)) return 'rejected';
  try {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [args.to],
        subject: args.subject.slice(0, 200),
        text: args.text,
      }),
    });
    if (res.ok) return 'sent';
    return res.status >= 400 && res.status < 500 && res.status !== 429 ? 'rejected' : 'failed';
  } catch {
    return 'failed';
  }
}
