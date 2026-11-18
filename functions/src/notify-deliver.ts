/**
 * Deliver the LINE queue (docs/LINE-NOTIFICATIONS-KNOWLEDGE.md). The database decides WHAT is due (`notify_claim`: halt,
 * monthly cap with a reserve for urgent notices, stale notices skipped) and records the outcome (`notify_report`);
 * this file only pushes and reports. LINE and the database are injected so the loop is unit-tested.
 */
import { buildFlexMessage, parseNotice } from '../../packages/core/src/flex.js';
import { LINE_MESSAGES } from './line-messages.js';
import type { Lang } from './line-messages.js';
import { pushLine } from './line.js';
import type { LineConfig, PushOutcome } from './line.js';

export type QueueItem = {
  id: string;
  user_id: string;
  kind: string;
  title: string;
  body: string;
  href: string | null;
  urgent: boolean;
  attempts: number;
  address: string | null;
  lang: Lang;
};

export interface NotifyStore {
  claim(limit: number): Promise<QueueItem[]>;
  report(id: string, outcome: PushOutcome | 'no_channel'): Promise<void>;
}

export type DeliverResult = {
  claimed: number;
  sent: number;
  failed: number;
  skipped: number;
  halted: boolean;
};

export async function deliverQueue(args: {
  store: NotifyStore;
  cfg: Pick<LineConfig, 'channelAccessToken' | 'siteUrl'>;
  limit?: number;
  fetchImpl?: typeof fetch;
}): Promise<DeliverResult> {
  const { store, cfg } = args;
  const items = await store.claim(args.limit ?? 20);
  const out: DeliverResult = {
    claimed: items.length,
    sent: 0,
    failed: 0,
    skipped: 0,
    halted: false,
  };
  for (const it of items) {
    if (!it.address) {
      await store.report(it.id, 'no_channel');
      out.skipped++;
      continue;
    }
    const message = buildFlexMessage({
      notice: parseNotice(it.title, it.body),
      openLabel: LINE_MESSAGES.openApp[it.lang === 'en' ? 'en' : 'th'],
      siteUrl: cfg.siteUrl,
      path: it.href ?? undefined,
    });
    // the retry key is the queue row id: if a report is lost and the row is sent again, LINE answers 409 = already delivered
    const outcome = await pushLine(cfg, it.address, message, it.id, args.fetchImpl);
    await store.report(it.id, outcome);
    if (outcome === 'sent') out.sent++;
    else out.failed++;
    if (outcome === 'auth_failed') {
      out.halted = true; // our token is dead: stop now, the database halts the queue for 6 hours
      break;
    }
    if (outcome === 'rate_limited') break; // LINE asked us to slow down
  }
  return out;
}

/** `NotifyStore` over Supabase REST with the service-role key. Server only. */
export function createSupabaseNotifyStore(
  supabaseUrl: string,
  serviceRoleKey: string,
  fetchImpl: typeof fetch = fetch,
): NotifyStore {
  const call = async (fn: string, args: Record<string, unknown>): Promise<unknown> => {
    const res = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`rpc ${fn} ${res.status}`);
    return res.json().catch(() => null);
  };
  return {
    async claim(limit) {
      const rows = await call('notify_claim', { p_limit: limit });
      return Array.isArray(rows) ? (rows as QueueItem[]) : [];
    },
    async report(id, outcome) {
      await call('notify_report', { p_id: id, p_outcome: outcome });
    },
  };
}

/** Run one database function with no arguments (daily summary, housekeeping). */
export async function callRpc(
  supabaseUrl: string,
  serviceRoleKey: string,
  fn: string,
  args: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const res = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`rpc ${fn} ${res.status}`);
  return res.json().catch(() => null);
}
