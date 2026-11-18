import { readServerEnv } from './env.js';
import {
  createRateLimiter,
  handleLineWebhook,
  notifyLine,
  startLineLink,
  testNotice,
} from './line.js';
import type { LineConfig, LineStore, Reply } from './line.js';
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
  if (!cfg) return reply({ error: 'not_configured' }, 503);
  try {
    const { supabaseUrl, serviceRoleKey } = readServerEnv(env);
    const store =
      deps.store ?? createSupabaseLineStore(supabaseUrl, serviceRoleKey, deps.fetchImpl);
    const fetchImpl = deps.fetchImpl ?? fetch;
    const send: Reply = async (replyToken, text) => {
      await fetchImpl('https://api.line.me/v2/bot/message/reply', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.channelAccessToken}`,
        },
        body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
      });
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
    return reply(out.body, out.status);
  } catch (e) {
    console.error('[line] webhook failed', e instanceof Error ? e.message : 'unknown');
    return reply({ ok: true }); // never make LINE retry / disable the webhook over our own error
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
  const cfg = lineConfig(env);
  if (!cfg) return reply({ available: false });

  try {
    const { supabaseUrl, serviceRoleKey } = readServerEnv(env);
    const store = deps.store ?? createSupabaseLineStore(supabaseUrl, serviceRoleKey, fetchImpl);
    const op = new URL(request.url).searchParams.get('op');

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
