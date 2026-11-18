import type { SupabaseClient } from '@supabase/supabase-js';
import { AppError } from '@bestie/i18n';

/** Call /api/ai with the signed-in admin's JWT. Only a code ever reaches the screen, never a provider message. */
export async function callAi<T>(
  client: SupabaseClient,
  op: 'status' | 'test' | 'review',
  body?: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const { data } = await client.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new AppError('err_forbidden');
  const res = await fetchImpl(`/api/ai?op=${op}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (res.status === 403) throw new AppError('err_forbidden');
  if (!res.ok) throw new AppError('err_unknown');
  return (await res.json()) as T;
}
