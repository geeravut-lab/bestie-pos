// AI reads a hair photo (module `ai.hair`, off by default; owner order 2026-11-21). Called by the booking handler for op `hair_ai`:
//   action 'state'    → { enabled, consent, labels }          what the page may offer
//   action 'consent'  → { ok }                                 the guest's SEPARATE tick for this photo (on = true) or its withdrawal (on = false)
//   action 'read'     → { ok, labels } | { ok:false, error }   send the photo ONCE to the vision model and keep the closed labels it returns
// The model sees only the photo (no name, phone, booking or shop) and may only answer with closed labels about the hair; code cuts everything else away
// (`parseHairLabels`), the database refuses any other shape (`hair_labels_ok`), and the labels are erased with the photo.
import { buildSystemPrompt } from '../../packages/core/src/aiPrompts.js';
import { labelsToAnswers, parseHairLabels } from '../../packages/core/src/hairAdvisor.js';
import type { ProviderId } from '../../packages/core/src/ai.js';
import { AiError } from './ai-adapters.js';
import type { AiImage, ProviderAdapter } from './ai-adapters.js';
import { keysFrom, loadSettings } from './ai-handler.js';
import { budgetGuard } from './ai-budget.js';
import { runAiWith } from './ai-run.js';
import { adaptersFor, loadAddition, logUsage } from './food-ai-handler.js';
import { rpc } from './guest-extras-handler.js';
import { createRateLimiter } from './line.js';

type Env = Record<string, string | undefined>;
export type HairAiDeps = {
  fetchImpl?: typeof fetch;
  adapters?: Record<ProviderId, ProviderAdapter>;
};
const allowRead = createRateLimiter(4, 10 * 60_000); // one reading costs money: a few per booking, per phone
const allowReadShop = createRateLimiter(60, 60 * 60_000);
const MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export type HairAiResult = { status: number; body: Record<string, unknown> };

export async function hairAiAction(
  b: Record<string, unknown>,
  ip: string,
  env: Env,
  supabaseUrl: string,
  serviceRoleKey: string,
  deps: HairAiDeps,
): Promise<HairAiResult> {
  const f = deps.fetchImpl ?? fetch;
  const args = { p_token: b.t, p_id: b.id, p_code: b.code };
  if (b.action === 'state') {
    const r = await rpc(f, supabaseUrl, serviceRoleKey, 'guest_hair_ai_state', args);
    if (!r.ok) return { status: 502, body: { error: 'server_error' } };
    const o = obj(r.data);
    const labels = parseHairLabels(o.labels);
    return {
      status: 200,
      body: {
        enabled: o.enabled === true,
        consent: o.consent === true,
        labels,
        answers: labels ? labelsToAnswers(labels) : {},
      },
    };
  }
  if (b.action === 'consent') {
    const r = await rpc(f, supabaseUrl, serviceRoleKey, 'guest_hair_ai_consent', {
      ...args,
      p_on: b.on === true,
    });
    if (!r.ok) return { status: 502, body: { error: 'server_error' } };
    const o = obj(r.data);
    return {
      status: 200,
      body: { ok: o.ok === true, error: typeof o.error === 'string' ? o.error : null },
    };
  }
  if (b.action !== 'read') return { status: 422, body: { error: 'invalid' } };

  if (!allowRead(`hair-ai:${ip}:${String(b.id)}`) || !allowReadShop(`hair-ai-shop:${String(b.t)}`))
    return { status: 429, body: { error: 'rate_limited' } };
  const keys = keysFrom(env);
  if (Object.keys(keys).length === 0) return { status: 200, body: { ok: false, error: 'no_key' } };
  const input = await rpc(f, supabaseUrl, serviceRoleKey, 'guest_hair_ai_input', args);
  if (!input.ok) return { status: 502, body: { error: 'server_error' } };
  const o = obj(input.data);
  if (o.ok !== true)
    return {
      status: 200,
      body: { ok: false, error: typeof o.error === 'string' ? o.error : 'unavailable' },
    };
  const mime = MIMES.find((m) => m === o.mime);
  if (!mime || typeof o.data !== 'string')
    return { status: 200, body: { ok: false, error: 'unavailable' } };
  const image: AiImage = { mime, data: o.data };

  const addition = await loadAddition('hair_photo', supabaseUrl, serviceRoleKey, f);
  const settings = await loadSettings(
    { ...env, SUPABASE_URL: supabaseUrl, SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey },
    f,
  );
  let out;
  try {
    out = await runAiWith({
      task: 'hair_photo',
      request: {
        system: buildSystemPrompt('hair_photo', addition),
        prompt: 'Describe the hair in the photo with the JSON labels now.',
        maxTokens: 200,
        images: [image],
      },
      guard: budgetGuard(f, supabaseUrl, serviceRoleKey, String(o.store_id ?? '')),
      settings,
      keys,
      adapters: adaptersFor(f, deps),
    });
  } catch (e) {
    if (e instanceof AiError && e.code === 'not_configured')
      return { status: 200, body: { ok: false, error: 'no_key' } };
    return { status: 200, body: { ok: false, error: 'ai_failed' } };
  }
  await logUsage(f, supabaseUrl, serviceRoleKey, {
    store_id: String(o.store_id ?? ''),
    task: 'hair_photo',
    provider: out.provider,
    model: out.model,
    input_tokens: out.usage.inputTokens,
    output_tokens: out.usage.outputTokens,
    source: 'guest',
  });
  const labels = parseHairLabels(out.text);
  if (!labels) return { status: 200, body: { ok: false, error: 'unclear' } };
  const saved = await rpc(f, supabaseUrl, serviceRoleKey, 'guest_hair_ai_save', {
    ...args,
    p_labels: labels,
  });
  const s = obj(saved.data);
  if (!saved.ok || s.ok !== true)
    return {
      status: 200,
      body: { ok: false, error: typeof s.error === 'string' ? s.error : 'failed' },
    };
  return { status: 200, body: { ok: true, labels, answers: labelsToAnswers(labels) } };
}
