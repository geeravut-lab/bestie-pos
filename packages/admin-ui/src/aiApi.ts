import type { SupabaseClient } from '@supabase/supabase-js';
import { parseFood } from '@bestie/core';
import type { AskPreset, DietTag } from '@bestie/core';
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

/** Ask for a DRAFT English (or Thai) version of one menu name. Null = AI is not set up. The draft is never saved by itself. */
export async function translateName(
  client: SupabaseClient,
  storeId: string,
  text: string,
  to: 'en' | 'th' = 'en',
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const { data } = await client.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new AppError('err_forbidden');
  const res = await fetchImpl('/api/menu/ai-translate', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ store_id: storeId, text, to }),
  });
  if (res.status === 403) throw new AppError('err_forbidden');
  if (res.status === 429) throw new AppError('err_rate_limited');
  if (!res.ok) throw new AppError('err_unknown');
  const b = (await res.json().catch(() => null)) as { available?: unknown; text?: unknown } | null;
  return b?.available === true && typeof b.text === 'string' ? b.text : null;
}

export type ShopAnswer =
  | {
      available: true;
      answer: string;
      /** Numbers in the answer that the shop's own figures do not contain. */
      unverified: string[];
      figures: string;
      range: { from: string; to: string };
    }
  | { available: false };

/** "Ask my shop": a plain-language answer about the chosen period; every figure comes from the shop's reports (read only). */
export async function askShop(
  client: SupabaseClient,
  /** One shop, or every shop of the business together. */
  target: { storeId: string } | { orgId: string },
  preset: AskPreset,
  question: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ShopAnswer> {
  const { data } = await client.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new AppError('err_forbidden');
  const res = await fetchImpl('/api/ask/shop', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...('storeId' in target ? { store_id: target.storeId } : { org_id: target.orgId }),
      preset,
      question,
    }),
  });
  if (res.status === 403) throw new AppError('err_forbidden');
  if (res.status === 429) throw new AppError('err_rate_limited');
  if (!res.ok) throw new AppError('err_unknown');
  const b = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b || b.available !== true || typeof b.answer !== 'string') return { available: false };
  const r = (b.range ?? {}) as { from?: unknown; to?: unknown };
  return {
    available: true,
    answer: b.answer,
    unverified: Array.isArray(b.unverified)
      ? b.unverified.filter((x): x is string => typeof x === 'string')
      : [],
    figures: typeof b.figures === 'string' ? b.figures : '',
    range: { from: String(r.from ?? ''), to: String(r.to ?? '') },
  };
}
