/**
 * GET /api/menu-image?i=<item id>&v=<version> — the picture of a menu item. Public on purpose (the guest table page and the till show
 * it, and a guest has no account); the item id is a 128-bit random id, the picture is read by the SERVICE role through one database
 * function that only knows pictures, and the answer is the picture bytes and nothing else. The version is part of the address, so a
 * changed picture is a new address and may be cached for a year. No picture (or any problem) → 404.
 */
import { readServerEnv } from './env.js';

type Env = Record<string, string | undefined>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

export type MenuImageDeps = { fetchImpl?: typeof fetch };

export async function menuImageResponse(
  request: Request,
  env: Env = process.env,
  deps: MenuImageDeps = {},
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  const q = new URL(request.url).searchParams;
  const id = q.get('i') ?? '';
  const v = q.get('v') ?? '';
  if (!UUID.test(id) || !/^[0-9]{1,6}$/.test(v)) return new Response('Not Found', { status: 404 });
  try {
    const etag = `"mi-${id}-${v}"`;
    if (request.headers.get('if-none-match') === etag)
      return new Response(null, { status: 304, headers: { ETag: etag, ...SAFE } });
    const { supabaseUrl, serviceRoleKey } = readServerEnv(env);
    const res = await (deps.fetchImpl ?? fetch)(`${supabaseUrl}/rest/v1/rpc/menu_image_get`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_item: id }),
    });
    if (!res.ok) return new Response('Not Found', { status: 404 });
    const d = (await res.json().catch(() => null)) as {
      mime?: unknown;
      version?: unknown;
      b64?: unknown;
    } | null;
    if (
      !d ||
      typeof d.b64 !== 'string' ||
      (d.mime !== 'image/jpeg' && d.mime !== 'image/png' && d.mime !== 'image/webp')
    )
      return new Response('Not Found', {
        status: 404,
        headers: { 'Cache-Control': 'public, max-age=60' },
      });
    const bytes = Uint8Array.from(atob(d.b64), (c) => c.charCodeAt(0));
    // the address names a version; an older address still gets the newest picture but must not be cached for long
    const current = String(d.version) === v;
    return new Response(request.method === 'HEAD' ? null : bytes, {
      status: 200,
      headers: {
        'Content-Type': d.mime,
        ETag: etag,
        'Cache-Control': current ? 'public, max-age=31536000, immutable' : 'public, max-age=60',
        ...SAFE,
      },
    });
  } catch (e) {
    console.error('[menu-image] failed', e instanceof Error ? e.message : 'unknown');
    return new Response('Not Found', { status: 404 });
  }
}
