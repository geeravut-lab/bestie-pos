import type { SupabaseClient } from '@supabase/supabase-js';
import { parseFood } from '@bestie/core';
import type { DietTag } from '@bestie/core';
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

export type TagDraft =
  { available: true; tags: DietTag[]; spice: 0 | 1 | 2 | 3 | null } | { available: false };

/** Ask for a DRAFT of one dish's food tags (owner / manager). The draft is never saved or marked verified by itself. */
export async function draftFoodTags(
  client: SupabaseClient,
  storeId: string,
  name: { th: string; en: string },
  fetchImpl: typeof fetch = fetch,
): Promise<TagDraft> {
  const { data } = await client.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new AppError('err_forbidden');
  const res = await fetchImpl('/api/menu/ai-tags', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ store_id: storeId, name }),
  });
  if (res.status === 403) throw new AppError('err_forbidden');
  if (res.status === 429) throw new AppError('err_rate_limited');
  if (!res.ok) throw new AppError('err_unknown');
  const b = (await res.json().catch(() => null)) as {
    available?: unknown;
    tags?: unknown;
    spice?: unknown;
  } | null;
  if (!b || b.available !== true) return { available: false };
  const f = parseFood({ tags: b.tags, spice_level: b.spice });
  return { available: true, tags: [...f.tags], spice: f.spice };
}
