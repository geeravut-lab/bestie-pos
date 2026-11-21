/**
 * Public brand endpoints (BRANDING-KNOWLEDGE §3.3): /brand/logo, /brand/favicon and the dynamic web manifest.
 * The images live in a PRIVATE bucket; this function is what makes them public, with an ETag per upload version.
 * No admin image → redirect to the built-in artwork. Never reveals anything but the brand itself.
 */
// Relative import on purpose (not '@bestie/core'): inside a Vercel Function a workspace package that points at .ts source
// does not resolve. packages/core/src/brand.ts is dependency-free, so it compiles along with this file.
import { brandName, brandObjectPath, parseBrand } from '../../packages/core/src/brand.js';
import type { Brand, BrandImage, BrandImageKind } from '../../packages/core/src/brand.js';

export interface BrandStore {
  loadBrand(): Promise<Brand>;
  /** Raw bytes of an object in the brand bucket, or null if it does not exist. */
  fetchObject(path: string): Promise<{ bytes: ArrayBuffer } | null>;
}

const DEFAULT_ICONS = {
  logo: '/icon-512.png',
  favicon: '/favicon.svg',
} as const;

const SAFE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  // if an image URL is ever opened directly, nothing in it may run
  'Content-Security-Policy': "default-src 'none'; sandbox",
};

const redirectToDefault = (kind: BrandImageKind): Response =>
  new Response(null, {
    status: 307,
    headers: {
      Location: DEFAULT_ICONS[kind],
      'Cache-Control': 'public, max-age=60',
      ...SAFE_HEADERS,
    },
  });

export function buildManifest(brand: Brand): Record<string, unknown> {
  const name = brandName('en', brand);
  const fav = brand.favicon;
  const icons: Record<string, string>[] = fav
    ? [
        {
          src: `/brand/favicon?v=${fav.version}`,
          sizes: '192x192',
          type: 'image/png',
          purpose: 'any',
        },
        ...((fav.size ?? 0) >= 512
          ? [
              {
                src: `/brand/favicon?v=${fav.version}`,
                sizes: '512x512',
                type: 'image/png',
                purpose: 'any',
              },
            ]
          : []),
      ]
    : [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ];
  return {
    name,
    short_name: name.length > 12 ? name.slice(0, 12) : name,
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    lang: 'th',
    background_color: '#f3fbfb',
    theme_color: '#00796f',
    icons,
  };
}

function imageResponse(
  request: Request,
  kind: BrandImageKind,
  image: BrandImage,
  bytes: ArrayBuffer,
): Response {
  const etag = `"${kind}-${image.version}"`;
  const headers = {
    ETag: etag,
    'Cache-Control': 'public, max-age=60, must-revalidate',
    ...SAFE_HEADERS,
  };
  if (request.headers.get('if-none-match') === etag)
    return new Response(null, { status: 304, headers });
  return new Response(bytes, { status: 200, headers: { ...headers, 'Content-Type': image.mime } });
}

export async function brandResponse(request: Request, store: BrandStore): Promise<Response> {
  const url = new URL(request.url);
  const kind = url.searchParams.get('kind');
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });

  let brand: Brand = {};
  try {
    brand = await store.loadBrand();
  } catch (e) {
    console.error('[brand] could not read settings', e instanceof Error ? e.message : 'unknown'); // fall back to defaults
  }

  if (kind === 'manifest') {
    return Response.json(buildManifest(brand), {
      headers: {
        'Content-Type': 'application/manifest+json',
        'Cache-Control': 'public, max-age=60',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }
  if (kind !== 'logo' && kind !== 'favicon') return new Response('Not Found', { status: 404 });

  const image = brand[kind];
  if (!image) return redirectToDefault(kind);
  try {
    const obj = await store.fetchObject(brandObjectPath(kind, image));
    if (!obj) return redirectToDefault(kind); // settings point at a file that is gone: defaults, not an error page
    return imageResponse(request, kind, image, obj.bytes);
  } catch (e) {
    console.error('[brand] could not read image', e instanceof Error ? e.message : 'unknown');
    return redirectToDefault(kind);
  }
}

/** Real store on Supabase REST + Storage with the service-role key (server only). */
export function createSupabaseBrandStore(
  supabaseUrl: string,
  serviceRoleKey: string,
  fetchImpl: typeof fetch = fetch,
): BrandStore {
  const headers = { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` };
  let cache: { at: number; brand: Brand } | null = null;
  return {
    async loadBrand() {
      if (cache && Date.now() - cache.at < 30_000) return cache.brand; // 30 s: changes show within about a minute
      const res = await fetchImpl(
        `${supabaseUrl}/rest/v1/platform_settings?select=brand&id=eq.true`,
        { headers },
      );
      if (!res.ok) throw new Error(`settings ${res.status}`);
      const rows = (await res.json()) as { brand?: unknown }[];
      const brand = parseBrand(rows[0]?.brand);
      cache = { at: Date.now(), brand };
      return brand;
    },
    async fetchObject(path) {
      const res = await fetchImpl(
        `${supabaseUrl}/storage/v1/object/brand-assets/${encodeURIComponent(path)}`,
        { headers },
      );
      if (res.status === 404 || res.status === 400) return null;
      if (!res.ok) throw new Error(`storage ${res.status}`);
      return { bytes: await res.arrayBuffer() };
    },
  };
}

/** The Google Wallet pass background (a literal hex, as Google Wallet needs one). */
export const WALLET_BACKGROUND = '#0f766e';
