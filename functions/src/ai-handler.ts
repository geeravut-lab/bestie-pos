/**
 * Platform-admin AI endpoints (one function, `?op=`):
 *   GET  status  → which providers have a key (never the key itself)
 *   POST test    → send "Reply with the single word: OK" to one provider+model
 *   POST review  → gate 1 (code screener) + gate 2 (AI reviewer, fails closed) for a prompt addition
 * Every call is authenticated with the caller's Supabase JWT and requires `is_platform_admin()`.
 */
import {
  PROVIDERS,
  PROVIDER_IDS,
  isProviderId,
  isTaskId,
  parseAiSettings,
  validModelId,
} from '../../packages/core/src/ai.js';
import type { AiSettings, ProviderId } from '../../packages/core/src/ai.js';
import { reviewPromptAddition, screenPromptAddition } from '../../packages/core/src/aiPrompts.js';
import { createAnthropicAdapter, createGoogleAdapter } from './ai-adapters.js';
import type { ProviderAdapter } from './ai-adapters.js';
import { runAiWith } from './ai-run.js';

type Env = Record<string, string | undefined>;
const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
const reply = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: JSON_HEADERS });

export const keysFrom = (env: Env): Partial<Record<ProviderId, string>> => {
  const out: Partial<Record<ProviderId, string>> = {};
  for (const id of PROVIDER_IDS) {
    const def: { envKey: string; envKeyAliases?: readonly string[] } = PROVIDERS[id];
    const v = [def.envKey, ...(def.envKeyAliases ?? [])].map((n) => env[n]?.trim()).find(Boolean);
    if (v) out[id] = v;
  }
  return out;
};

export type AiDeps = { fetchImpl?: typeof fetch; adapters?: Record<ProviderId, ProviderAdapter> };

async function isPlatformAdmin(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  const token = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!token || !url || !key) return false;
  try {
    const res = await fetchImpl(`${url}/rest/v1/rpc/is_platform_admin`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    return res.ok && (await res.json()) === true;
  } catch {
    return false;
  }
}

async function loadSettings(env: Env, fetchImpl: typeof fetch): Promise<AiSettings> {
  try {
    const res = await fetchImpl(
      `${env.SUPABASE_URL}/rest/v1/ai_settings?select=route_overrides,model_overrides&id=eq.true`,
      {
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY ?? '',
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY ?? ''}`,
        },
      },
    );
    const rows = (await res.json()) as { route_overrides?: unknown; model_overrides?: unknown }[];
    return parseAiSettings(rows[0]?.route_overrides, rows[0]?.model_overrides);
  } catch {
    return parseAiSettings(null, null); // unreadable settings = code defaults, never a crash
  }
}

export async function aiHandler(
  request: Request,
  env: Env = process.env,
  deps: AiDeps = {},
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const adapters = deps.adapters ?? {
    anthropic: createAnthropicAdapter(fetchImpl),
    google: createGoogleAdapter(fetchImpl),
  };
  const op = new URL(request.url).searchParams.get('op');

  if (!(await isPlatformAdmin(request, env, fetchImpl))) return reply({ error: 'forbidden' }, 403);
  const keys = keysFrom(env);

  if (op === 'status' && request.method === 'GET') {
    return reply({ providers: Object.fromEntries(PROVIDER_IDS.map((p) => [p, Boolean(keys[p])])) });
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;

  if (op === 'test' && request.method === 'POST') {
    const provider = body?.provider;
    const model = body?.model;
    if (!isProviderId(provider) || !validModelId(model))
      return reply({ error: 'bad_request' }, 400);
    const key = keys[provider];
    if (!key) return reply({ ok: false, error: 'not_configured' });
    const started = Date.now();
    try {
      const r = await adapters[provider].call(
        { prompt: 'Reply with the single word: OK', maxTokens: 128 },
        model,
        key,
      );
      return reply({ ok: true, ms: Date.now() - started, usage: r.usage });
    } catch (e) {
      // the provider's own message is never shown; only a code
      return reply({
        ok: false,
        error: 'provider_failed',
        status: (e as { status?: number }).status ?? null,
      });
    }
  }

  if (op === 'review' && request.method === 'POST') {
    const task = body?.task;
    const text = typeof body?.text === 'string' ? body.text : '';
    if (!isTaskId(task)) return reply({ error: 'bad_request' }, 400);
    const problems = screenPromptAddition(task, text);
    if (problems.length > 0) return reply({ result: 'rejected', problems });
    const settings = await loadSettings(env, fetchImpl);
    const result = await reviewPromptAddition(task, text, async (system, prompt) => {
      const r = await runAiWith({
        task: 'prompt_review',
        request: { system, prompt, maxTokens: 16 },
        settings,
        keys,
        adapters,
      });
      return r.text;
    });
    return reply({ result, problems: [] });
  }

  return reply({ error: 'not_found' }, 404);
}
