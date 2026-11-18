import { readServerEnv } from './env.js';
import { brandResponse, createSupabaseBrandStore } from './brand.js';

/** GET /api/brand?kind=logo|favicon|manifest — mounted by each app api/brand.ts and reached through the brand rewrites. */
export function brandHandler(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): Promise<Response> {
  try {
    const { supabaseUrl, serviceRoleKey } = readServerEnv(env);
    return brandResponse(request, createSupabaseBrandStore(supabaseUrl, serviceRoleKey));
  } catch (e) {
    console.error('[brand] not configured', e instanceof Error ? e.message : 'unknown');
    // not configured → still answer: defaults (the app must work before any admin sets anything)
    return brandResponse(request, { loadBrand: async () => ({}), fetchObject: async () => null });
  }
}
