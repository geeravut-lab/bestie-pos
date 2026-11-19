/**
 * GET /api/card-image?id=<card id>&v=<version> — an admin-uploaded home-card picture. The bytes live in a PRIVATE bucket;
 * this function makes them public with an ETag per version. No picture (or any problem) → 404, and the page falls back to the
 * built-in illustration. Nothing but the picture is ever revealed.
 */
import { cardObjectPath, parseCardImages } from '../../packages/core/src/cardImages.js';
import type { CardImages } from '../../packages/core/src/cardImages.js';
import { readServerEnv } from './env.js';

export interface CardImageStore {
  load(): Promise<CardImages>;
  fetchObject(path: string): Promise<ArrayBuffer | null>;
}

const SAFE = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
};

export async function cardImageResponse(
  request: Request,
  store: CardImageStore,
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  const id = new URL(request.url).searchParams.get('id') ?? '';
  if (!/^[a-zA-Z]{2,20}$/.test(id)) return new Response('Not Found', { status: 404 });
  try {
    const image = (await store.load())[id];
    if (!image)
      return new Response('Not Found', {
        status: 404,
        headers: { 'Cache-Control': 'public, max-age=60' },
      });
    const etag = `"card-${id}-${image.version}"`;
    const headers = { ETag: etag, 'Cache-Control': 'public, max-age=60, must-revalidate', ...SAFE };
    if (request.headers.get('if-none-match') === etag)
      return new Response(null, { status: 304, headers });
    const bytes = await store.fetchObject(cardObjectPath(id, image));
    if (!bytes) return new Response('Not Found', { status: 404 });
    return new Response(bytes, {
      status: 200,
      headers: { ...headers, 'Content-Type': image.mime },
    });
  } catch (e) {
    console.error('[card-image] failed', e instanceof Error ? e.message : 'unknown');
    return new Response('Not Found', { status: 404 });
  }
}

export function createSupabaseCardImageStore(
  supabaseUrl: string,
  serviceRoleKey: string,
  fetchImpl: typeof fetch = fetch,
): CardImageStore {
  const headers = { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` };
  let cache: { at: number; images: CardImages } | null = null;
  return {
    async load() {
      if (cache && Date.now() - cache.at < 30_000) return cache.images;
      const res = await fetchImpl(
        `${supabaseUrl}/rest/v1/platform_settings?select=card_images&id=eq.true`,
        { headers },
      );
      if (!res.ok) throw new Error(`settings ${res.status}`);
      const rows = (await res.json()) as { card_images?: unknown }[];
      const images = parseCardImages(rows[0]?.card_images);
      cache = { at: Date.now(), images };
      return images;
    },
    async fetchObject(path) {
      const res = await fetchImpl(
        `${supabaseUrl}/storage/v1/object/card-images/${encodeURIComponent(path)}`,
        { headers },
      );
      if (res.status === 404 || res.status === 400) return null;
      if (!res.ok) throw new Error(`storage ${res.status}`);
      return res.arrayBuffer();
    },
  };
}

export function cardImageHandler(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): Promise<Response> {
  try {
    const { supabaseUrl, serviceRoleKey } = readServerEnv(env);
    return cardImageResponse(request, createSupabaseCardImageStore(supabaseUrl, serviceRoleKey));
  } catch {
    return Promise.resolve(new Response('Not Found', { status: 404 }));
  }
}
