// The two deliveries of the growth tools, both run by the notification tick:
//  (1) promotional LINE messages to members who agreed (the database decides who: consent, LINE linked, not stopped, 14-day gap, monthly cap);
//  (2) signed webhooks to the addresses the owner registered (5 tries with growing gaps; an address failing 20 deliveries in a row is switched off).
import { createHmac } from 'node:crypto';
import { marketingText, webhookUrlOk } from '../../packages/core/src/growth.js';
import { callRpc } from './notify-deliver.js';
import { pushLine } from './line.js';
import type { LineConfig } from './line.js';

const obj = (x: unknown): Record<string, unknown> =>
  x && typeof x === 'object' ? (x as Record<string, unknown>) : {};
const rows = (x: unknown): Record<string, unknown>[] => (Array.isArray(x) ? x.map(obj) : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export type MarketingResult = { queued: number; claimed: number; sent: number; failed: number };

/** Queue today's promotional messages for active campaigns and push the due ones. Does nothing without the LINE credentials. */
export async function deliverMarketing(args: {
  supabaseUrl: string;
  serviceRoleKey: string;
  cfg: LineConfig | null;
  fetchImpl?: typeof fetch;
}): Promise<MarketingResult> {
  const { supabaseUrl, serviceRoleKey, cfg } = args;
  const f = args.fetchImpl ?? fetch;
  const out: MarketingResult = { queued: 0, claimed: 0, sent: 0, failed: 0 };
  if (!cfg) return out;
  const q = await callRpc(supabaseUrl, serviceRoleKey, 'marketing_run_all', {}, f).catch(() => 0);
  out.queued = typeof q === 'number' ? q : 0;
  const due = rows(
    await callRpc(supabaseUrl, serviceRoleKey, 'marketing_claim', { p_limit: 20 }, f).catch(
      () => [],
    ),
  );
  out.claimed = due.length;
  for (const d of due) {
    const id = str(d.id);
    const to = str(d.line_user_id);
    const th = str(d.th);
    if (!id || !to || !th) continue;
    const text = marketingText({ th, ...(str(d.en) ? { en: str(d.en) } : {}) });
    const outcome = await pushLine(cfg, to, { type: 'text', text }, id, f);
    const report = outcome === 'sent' ? 'sent' : outcome === 'blocked' ? 'blocked' : outcome;
    await callRpc(
      supabaseUrl,
      serviceRoleKey,
      'marketing_report',
      { p_id: id, p_outcome: report },
      f,
    ).catch(() => {});
    if (outcome === 'sent') out.sent += 1;
    else out.failed += 1;
    if (outcome === 'auth_failed' || outcome === 'rate_limited') break; // LINE says stop: the rest waits for the next tick
  }
  return out;
}

/** `t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body" with the endpoint's secret>`. */
export function signWebhook(secret: string, timestamp: number, body: string): string {
  const v1 = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

export type WebhookResult = { claimed: number; sent: number; failed: number };

export async function deliverWebhooks(args: {
  supabaseUrl: string;
  serviceRoleKey: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<WebhookResult> {
  const { supabaseUrl, serviceRoleKey } = args;
  const f = args.fetchImpl ?? fetch;
  const now = args.now ?? Date.now;
  const out: WebhookResult = { claimed: 0, sent: 0, failed: 0 };
  const due = rows(
    await callRpc(supabaseUrl, serviceRoleKey, 'webhook_claim', { p_limit: 20 }, f).catch(() => []),
  );
  out.claimed = due.length;
  for (const d of due) {
    const id = str(d.id);
    const url = str(d.url);
    const secret = str(d.secret);
    if (!id || !secret) continue;
    let ok = false;
    let status = 0;
    if (webhookUrlOk(url)) {
      const body = JSON.stringify(d.payload ?? {});
      try {
        const res = await f(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'BestiePOS-Webhook/1',
            'Bestie-Event': str(d.event),
            'Bestie-Signature': signWebhook(secret, Math.floor(now() / 1000), body),
          },
          body,
          redirect: 'manual', // a redirect could point inside the network: it counts as a failure
          signal: AbortSignal.timeout(8000),
        });
        status = res.status;
        ok = res.status >= 200 && res.status < 300;
      } catch {
        status = 0;
      }
    }
    await callRpc(
      supabaseUrl,
      serviceRoleKey,
      'webhook_report',
      { p_id: id, p_ok: ok, p_status: status },
      f,
    ).catch(() => {});
    if (ok) out.sent += 1;
    else out.failed += 1;
  }
  return out;
}
