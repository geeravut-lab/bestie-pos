// The morning brief of the business manager: POST /api/brief/summary { store_id } → { available, summary, unverified, facts }
// The person's own token decides (`brief_context`: report.view + the module `ai.business_manager`); the model only explains the findings the database holds, in at most 120 words,
// and code lists every number in its answer that is not among the facts. Without a key the page still shows the findings (`available: false`).
import { buildSystemPrompt } from '../../packages/core/src/aiPrompts.js';
import { unverifiedNumbers } from '../../packages/core/src/askShop.js';
import { buildBriefPack, parseInsights } from '../../packages/core/src/smartOps.js';
import type { ProviderId } from '../../packages/core/src/ai.js';
import { AiError } from './ai-adapters.js';
import type { ProviderAdapter } from './ai-adapters.js';
import { keysFrom, loadSettings } from './ai-handler.js';
import { budgetGuard } from './ai-budget.js';
import { runAiWith } from './ai-run.js';
import { readServerEnv } from './env.js';
import { adaptersFor, loadAddition, logUsage } from './food-ai-handler.js';
import { createRateLimiter } from './line.js';

type Env = Record<string, string | undefined>;
const HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: HEADERS });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const allow = createRateLimiter(6, 60_000);
export type BriefDeps = {
  fetchImpl?: typeof fetch;
  adapters?: Record<ProviderId, ProviderAdapter>;
};

export async function briefSummaryResponse(
  request: Request,
  env: Env = process.env,
  deps: BriefDeps = {},
): Promise<Response> {
  if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
  const token = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
  const body = (await request.json().catch(() => null)) as { store_id?: unknown } | null;
  if (!token) return reply({ error: 'forbidden' }, 403);
  if (!body || typeof body.store_id !== 'string' || !UUID.test(body.store_id))
    return reply({ error: 'invalid' }, 422);
  const f = deps.fetchImpl ?? fetch;
  try {
    const { supabaseUrl, serviceRoleKey } = readServerEnv(env);
    const anon = (env.SUPABASE_ANON_KEY ?? env.VITE_SUPABASE_ANON_KEY)?.trim() || serviceRoleKey;
    const res = await f(`${supabaseUrl}/rest/v1/rpc/brief_context`, {
      method: 'POST',
      headers: {
        apikey: anon,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_store: body.store_id }),
    });
    if (!res.ok) return reply({ error: 'forbidden' }, 403);
    const ctx = (await res.json().catch(() => null)) as { org_id?: string } | null;
    const pack = buildBriefPack(parseInsights(ctx));
    if (pack.text === '')
      return reply({ available: true, summary: null, unverified: [], facts: '' });
    if (!allow(`brief:${token.slice(-16)}`)) return reply({ error: 'rate_limited' }, 429);
    const keys = keysFrom(env);
    if (Object.keys(keys).length === 0) return reply({ available: false, facts: pack.text });
    const addition = await loadAddition('summary', supabaseUrl, serviceRoleKey, f);
    const settings = await loadSettings(
      { ...env, SUPABASE_URL: supabaseUrl, SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey },
      f,
    );
    let out;
    try {
      out = await runAiWith({
        task: 'summary',
        request: {
          system: buildSystemPrompt('summary', addition),
          prompt: `Findings of the shop's business manager (the only facts you may use; amounts are THB):\n"""\n${pack.text}\n"""\nWrite a short morning brief for the owner in at most 120 words: what needs attention first and why. Quote numbers exactly as written. Do not invent causes, do not promise results, do not give orders: the owner decides.`,
          maxTokens: 450,
        },
        guard: budgetGuard(f, supabaseUrl, serviceRoleKey, String(body.store_id)),
        settings,
        keys,
        adapters: adaptersFor(f, deps),
      });
    } catch (e) {
      if (e instanceof AiError && e.code === 'not_configured')
        return reply({ available: false, facts: pack.text });
      return reply({ error: 'ai_failed' }, 502);
    }
    await logUsage(f, supabaseUrl, serviceRoleKey, {
      store_id: body.store_id,
      task: 'summary',
      provider: out.provider,
      model: out.model,
      input_tokens: out.usage.inputTokens,
      output_tokens: out.usage.outputTokens,
      source: 'staff',
    });
    const summary = out.text.trim().slice(0, 1200);
    return reply({
      available: true,
      summary,
      unverified: unverifiedNumbers(summary, pack.allowed),
      facts: pack.text,
    });
  } catch {
    return reply({ error: 'server_error' }, 502);
  }
}
