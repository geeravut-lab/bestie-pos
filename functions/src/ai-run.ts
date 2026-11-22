import {
  TASKS,
  resolveRoute,
  shouldRetrySame,
  shouldTryFallback,
} from '../../packages/core/src/ai.js';
import type { AiSettings, ProviderId, TaskId } from '../../packages/core/src/ai.js';
import { AiError } from './ai-adapters.js';
import type { AiRequest, AiResponse, ProviderAdapter } from './ai-adapters.js';

export type AiEvent = {
  provider: ProviderId;
  task: TaskId;
  status: 'fallback' | 'error';
  errorCode: string;
};

/**
 * Run one AI request: primary (+ one retry on 429/503) → fallback (+ one retry) → throw. Never loops, never calls an
 * AI at all when no provider has a key. Only fallbacks and errors are logged (successes are not — there are thousands).
 */
export async function runAiWith(args: {
  task: TaskId;
  request: AiRequest;
  settings: AiSettings;
  keys: Partial<Record<ProviderId, string>>;
  adapters: Record<ProviderId, ProviderAdapter>;
  log?: (e: AiEvent) => Promise<void> | void;
  sleep?: (ms: number) => Promise<void>;
  /** The business's monthly AI budget: false = spent, the answer is "not available" (same as no key). Absent = no cap. */
  guard?: () => Promise<boolean>;
}): Promise<AiResponse> {
  const { task, request, settings, keys, adapters } = args;
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = async (e: AiEvent) => {
    try {
      await args.log?.(e);
    } catch {
      /* a failing log must never hide the real error */
    }
  };

  const route = resolveRoute(task, settings, (p) => Boolean(keys[p]));
  if (!route) throw new AiError('not_configured');
  if (args.guard && !(await args.guard())) throw new AiError('not_configured'); // the business's monthly AI budget is spent

  const attempt = async (provider: ProviderId, model: string): Promise<AiResponse> => {
    const key = keys[provider]!;
    try {
      return await adapters[provider].call(request, model, key);
    } catch (e) {
      if (e instanceof AiError && e.status !== undefined && shouldRetrySame(e.status)) {
        await sleep(1200);
        return adapters[provider].call(request, model, key);
      }
      throw e;
    }
  };

  try {
    return await attempt(route.primary.provider, route.primary.model);
  } catch (e) {
    const status = e instanceof AiError ? e.status : undefined;
    const code = status !== undefined ? String(status) : e instanceof AiError ? e.code : 'unknown';
    if (
      route.fallback &&
      (status === undefined || shouldTryFallback(status)) &&
      TASKS[task].fallback !== undefined
    ) {
      await log({ provider: route.primary.provider, task, status: 'fallback', errorCode: code });
      try {
        return await attempt(route.fallback.provider, route.fallback.model);
      } catch (e2) {
        await log({
          provider: route.fallback.provider,
          task,
          status: 'error',
          errorCode:
            e2 instanceof AiError && e2.status !== undefined ? String(e2.status) : 'failed',
        });
        throw e2 instanceof AiError ? e2 : new AiError('provider_failed');
      }
    }
    await log({ provider: route.primary.provider, task, status: 'error', errorCode: code });
    throw e instanceof AiError ? e : new AiError('provider_failed');
  }
}
