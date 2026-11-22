// The monthly AI budget of a business (owner answer 19 Nov: each business pays for the AI its guests and staff use).
// Before an AI call the server asks the database for the cap and this month's tokens per model, prices them like the usage page does
// (code defaults corrected by `ai_settings.prices`, the USD→THB rate) and refuses the call when the estimate has reached the cap.
// It FAILS OPEN: if the database cannot answer, the call goes through (a broken counter must not switch the assistants off), and a model with no price counts as 0
// (the usage page says "no price yet" for it too). The cap is a brake, not an accounting record.
import { DEFAULT_USD_THB, costSatang, mergePrices } from '../../packages/core/src/aiCost.js';
import { callRpc } from './notify-deliver.js';

type Usage = { model: string; input: number; output: number };

/** Pure: has the month's estimated cost reached the cap? `null` cap = no cap. */
export function budgetSpent(state: unknown): boolean {
  const o = (state && typeof state === 'object' ? state : {}) as {
    cap?: unknown;
    usd_thb?: unknown;
    prices?: unknown;
    usage?: unknown;
  };
  if (o.cap === null || o.cap === undefined) return false;
  const cap = Number(o.cap);
  if (!Number.isFinite(cap)) return false;
  if (cap <= 0) return true; // 0 = no AI at all
  const rate = Number(o.usd_thb) > 0 ? Number(o.usd_thb) : DEFAULT_USD_THB;
  const prices = mergePrices(o.prices);
  let spent = 0;
  for (const u of (Array.isArray(o.usage) ? o.usage : []) as Partial<Usage>[]) {
    if (typeof u.model !== 'string') continue;
    spent += costSatang(u.model, Number(u.input) || 0, Number(u.output) || 0, prices, rate) ?? 0;
  }
  return spent >= cap;
}

export async function budgetAllows(
  f: typeof fetch,
  supabaseUrl: string,
  serviceRoleKey: string,
  storeId: string,
): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(storeId)) return true;
  try {
    const state = await callRpc(
      supabaseUrl,
      serviceRoleKey,
      'ai_budget_state',
      { p_store: storeId },
      f,
    );
    return !budgetSpent(state);
  } catch {
    return true;
  }
}

/** For `runAiWith({ guard })`. */
export const budgetGuard =
  (f: typeof fetch, supabaseUrl: string, serviceRoleKey: string, storeId: string) => () =>
    budgetAllows(f, supabaseUrl, serviceRoleKey, storeId);
