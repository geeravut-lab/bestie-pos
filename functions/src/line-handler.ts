import { readServerEnv } from './env.js';
import {
  createRateLimiter,
  handleLineWebhook,
  notifyLine,
  startLineLink,
  testNotice,
} from './line.js';
import type { LineConfig, LineStore, Reply } from './line.js';
import { evaluateDiagnosis } from './line-diagnose.js';
import { createSupabaseLineStore } from './line-store.js';

type Env = Record<string, string | undefined>;
const HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: HEADERS });

export function lineConfig(env: Env): LineConfig | null {
  const channelSecret = env.LINE_CHANNEL_SECRET?.trim();
  const channelAccessToken = env.LINE_CHANNEL_ACCESS_TOKEN?.trim();
  const codeSecret = env.LINE_CODE_SECRET?.trim();
  const basicId = env.LINE_BASIC_ID?.trim();
  if (!channelSecret || !channelAccessToken || !codeSecret || !basicId) return null; // not configured: the channel is simply "unavailable"
  return {
    channelSecret,
    channelAccessToken,
    codeSecret,
    basicId,
    siteUrl: env.VITE_SITE_URL?.trim() || 'https://bestie-pos.vercel.app',
  };
}

const allowBind = createRateLimiter(10, 10 * 60_000); // per LINE account: slows guessing codes
const allowStart = createRateLimiter(10, 60 * 60_000); // per Bestie user: asking for codes
const allowTest = createRateLimiter(5, 60 * 60_000);

export type LineDeps = { fetchImpl?: typeof fetch; store?: LineStore };

/** POST /api/line/webhook — LINE Platform → us. Raw body first, signature second, JSON last. */
export async function lineWebhookResponse(
  request: Request,
  env: Env = process.env,
  deps: LineDeps = {},
): Promise<Response> {
  const cfg = lineConfig(env);
  if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
  const fetchImpl = deps.fetchImpl ?? fetch;
  if (!cfg) {
    await logWebhook(env, fetchImpl, 'not_configured', 0);
    return reply({ error: 'not_configured' }, 503);
  }
  try {
    const { supabaseUrl, serviceRoleKey } = readServerEnv(env);
    const store =
      deps.store ??
      createSupabaseLineStore(
        supabaseUrl,
        serviceRoleKey,
        deps.fetchImpl,
        env.LINE_ISLAND_NETWORK?.trim() || 'koh-phangan',
      );
    let replyFailed: number | null = null; // LINE refused our answer (a bad access token shows up here): the user would see nothing
    const send: Reply = async (replyToken, text) => {
      const res = await fetchImpl('https://api.line.me/v2/bot/message/reply', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.channelAccessToken}`,
        },
        body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
      });
      if (!res.ok) {
        replyFailed = res.status;
        throw new Error(`reply ${res.status}`);
      }
    };
    const rawBody = await request.text(); // BEFORE any JSON parsing: the signature is over the exact bytes
    const out = await handleLineWebhook({
      rawBody,
      signature: request.headers.get('x-line-signature'),
      cfg,
      store,
      reply: send,
      allow: allowBind,
    });
    const events = countEvents(rawBody);
    const outcome =
      out.status === 401
        ? 'bad_signature'
        : out.status !== 200
          ? 'bad_request'
          : replyFailed !== null
            ? `reply_failed_${replyFailed}`
            : events === 0
              ? 'ok_empty' // LINE's own "verify" / test call carries no events
              : 'ok';
    await logWebhook(env, fetchImpl, outcome, events);
    return reply(out.body, out.status);
  } catch (e) {
    console.error('[line] webhook failed', e instanceof Error ? e.message : 'unknown');
    return reply({ ok: true }); // never make LINE retry / disable the webhook over our own error
  }
}

/** How many events a webhook body carries (0 when it cannot be read). */
function countEvents(rawBody: string): number {
  try {
    const e = (JSON.parse(rawBody) as { events?: unknown }).events;
    return Array.isArray(e) ? e.length : 0;
  } catch {
    return 0;
  }
}

/** Leaves one row per webhook call (outcome + event count, never text or ids) so a silent bot can be diagnosed. Never throws. */
async function logWebhook(
  env: Env,
  fetchImpl: typeof fetch,
  outcome: string,
  events: number,
): Promise<void> {
  try {
    const { supabaseUrl, serviceRoleKey } = readServerEnv(env);
    await fetchImpl(`${supabaseUrl}/rest/v1/rpc/log_line_webhook`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_outcome: outcome, p_events: events }),
    });
  } catch {
    /* diagnostics must never get in the way of the webhook */
  }
}

async function userIdFrom(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  const token = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
  if (!token || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  try {
    const res = await fetchImpl(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const u = (await res.json()) as { id?: string };
    return typeof u.id === 'string' ? u.id : null;
  } catch {
    return null;
  }
}

/**
 * /api/line/link — for the signed-in user:  GET = status · POST = new code · DELETE = disconnect · POST ?op=test = test card.
 * The browser never sees the LINE userId or any hash: only `status`, expiry and `last_error`.
 */
export async function lineLinkResponse(
  request: Request,
  env: Env = process.env,
  deps: LineDeps = {},
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const userId = await userIdFrom(request, env, fetchImpl);
  if (!userId) return reply({ error: 'forbidden' }, 403);
  const op = new URL(request.url).searchParams.get('op');
  if (op === 'diagnose' && request.method === 'GET')
    return lineDiagnoseResponse(userId, env, fetchImpl);
  const cfg = lineConfig(env);
  if (!cfg) return reply({ available: false });

  try {
    const { supabaseUrl, serviceRoleKey } = readServerEnv(env);
    const store = deps.store ?? createSupabaseLineStore(supabaseUrl, serviceRoleKey, fetchImpl);

    if (request.method === 'GET')
      return reply({ available: true, basicId: cfg.basicId, channel: await store.status(userId) });
    if (request.method === 'DELETE') return reply({ ok: await store.remove(userId) });
    if (request.method === 'POST' && op === 'test') {
      if (!allowTest(`line:test:${userId}`)) return reply({ error: 'rate_limited' }, 429);
      const lang = await store.ownerLang(userId);
      const outcome = await notifyLine({
        store,
        cfg,
        userId,
        notice: testNotice(lang),
        path: '/account',
        kind: 'test',
        retryKey: crypto.randomUUID(),
        fetchImpl,
      });
      return reply({ outcome });
    }
    if (request.method === 'POST') {
      if (!allowStart(`line:start:${userId}`)) return reply({ error: 'rate_limited' }, 429);
      return reply({ available: true, ...(await startLineLink(store, userId, cfg)) });
    }
    return reply({ error: 'method_not_allowed' }, 405);
  } catch (e) {
    console.error('[line] link failed', e instanceof Error ? e.message : 'unknown');
    return reply({ error: 'server_error' }, 500);
  }
}

const LINE_ENV = [
  'LINE_CHANNEL_SECRET',
  'LINE_CHANNEL_ACCESS_TOKEN',
  'LINE_CODE_SECRET',
  'LINE_BASIC_ID',
] as const;

/**
 * GET /api/line/link?op=diagnose — the platform admin's "check the LINE connection": LINE's own view of the bot next to what reached us.
 * Only the checks' ids, levels and short facts go back (never a token, a secret or any message text).
 */
async function lineDiagnoseResponse(
  userId: string,
  env: Env,
  fetchImpl: typeof fetch,
): Promise<Response> {
  try {
    const { supabaseUrl, serviceRoleKey } = readServerEnv(env);
    const svc = {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
    };
    const admin = await fetchImpl(
      `${supabaseUrl}/rest/v1/platform_admins?user_id=eq.${userId}&select=user_id`,
      { headers: svc },
    );
    const isAdmin = admin.ok && ((await admin.json().catch(() => [])) as unknown[]).length > 0;
    if (!isAdmin) return reply({ error: 'forbidden' }, 403);

    const siteUrl = (env.VITE_SITE_URL?.trim() || 'https://bestie-pos.vercel.app').replace(
      /\/$/,
      '',
    );
    const expectedWebhook = `${siteUrl}/api/line/webhook`;
    const missingEnv = LINE_ENV.filter((n) => !env[n]?.trim());
    const rpcJson = async (fn: string): Promise<unknown> => {
      try {
        const r = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/${fn}`, {
          method: 'POST',
          headers: svc,
          body: '{}',
        });
        return r.ok ? await r.json() : null;
      } catch {
        return null;
      }
    };
    const recent = ((await rpcJson('line_webhook_summary')) ?? {}) as Record<string, number>;
    const pendingLinks = Number((await rpcJson('line_pending_links')) ?? 0) || 0;

    const call = async <T>(
      url: string,
      init: RequestInit = {},
    ): Promise<({ status: number } & T) | null> => {
      try {
        const r = await fetchImpl(url, {
          ...init,
          headers: {
            Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN?.trim() ?? ''}`,
            'Content-Type': 'application/json',
          },
        });
        const body = (await r.json().catch(() => ({}))) as T;
        return { status: r.status, ...body };
      } catch {
        return null;
      }
    };
    const ready = missingEnv.length === 0;
    const info = ready
      ? await call<{ basicId?: string; displayName?: string }>('https://api.line.me/v2/bot/info')
      : null;
    const endpoint = ready
      ? await call<{ endpoint?: string; active?: boolean }>(
          'https://api.line.me/v2/bot/channel/webhook/endpoint',
        )
      : null;
    const test = ready
      ? await call<{ success?: boolean; statusCode?: number; reason?: string }>(
          'https://api.line.me/v2/bot/channel/webhook/test',
          {
            method: 'POST',
            body: JSON.stringify({ endpoint: expectedWebhook }),
          },
        )
      : null;
    return reply({
      checks: evaluateDiagnosis({
        missingEnv: [...missingEnv],
        expectedWebhook,
        configuredBasicId: env.LINE_BASIC_ID?.trim() ?? '',
        info,
        endpoint,
        test,
        recent,
        pendingLinks,
      }),
      expectedWebhook,
    });
  } catch (e) {
    console.error('[line] diagnose failed', e instanceof Error ? e.message : 'unknown');
    return reply({ error: 'server_error' }, 500);
  }
}
