import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { brandResponse, buildManifest, createSupabaseBrandStore } from './brand.js';
import type { BrandStore } from './brand.js';

const req = (kind: string, headers: Record<string, string> = {}, method = 'GET') =>
  new Request(`https://x/api/brand?kind=${kind}`, { method, headers });
const store = (over: Partial<BrandStore> = {}): BrandStore => ({
  loadBrand: async () => ({}),
  fetchObject: async () => null,
  ...over,
});
const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;

describe('brandResponse — images', () => {
  it('redirects to the built-in artwork when the admin has not uploaded anything', async () => {
    const logo = await brandResponse(req('logo'), store());
    expect(logo.status).toBe(307);
    expect(logo.headers.get('location')).toBe('/icon-512.png');
    expect((await brandResponse(req('favicon'), store())).headers.get('location')).toBe(
      '/favicon.svg',
    );
  });

  it('serves the admin image with its type, an ETag per version, short cache and hardening headers', async () => {
    const s = store({
      loadBrand: async () => ({ logo: { mime: 'image/png', version: 42 } }),
      fetchObject: vi.fn(async () => ({ bytes })),
    });
    const res = await brandResponse(req('logo'), s);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('etag')).toBe('"logo-42"');
    expect(res.headers.get('cache-control')).toContain('max-age=60');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(s.fetchObject).toHaveBeenCalledWith('logo-42.png');
  });

  it('answers 304 when the ETag matches', async () => {
    const s = store({
      loadBrand: async () => ({ favicon: { mime: 'image/png', version: 7, size: 512 } }),
      fetchObject: async () => ({ bytes }),
    });
    const res = await brandResponse(req('favicon', { 'If-None-Match': '"favicon-7"' }), s);
    expect(res.status).toBe(304);
  });

  it('falls back to defaults — never an error page — when storage or settings fail', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const gone = store({
      loadBrand: async () => ({ logo: { mime: 'image/png', version: 1 } }),
      fetchObject: async () => null,
    });
    expect((await brandResponse(req('logo'), gone)).status).toBe(307);
    const broken = store({
      loadBrand: async () => {
        throw new Error('db down');
      },
    });
    expect((await brandResponse(req('logo'), broken)).status).toBe(307);
    const storageDown = store({
      loadBrand: async () => ({ logo: { mime: 'image/png', version: 1 } }),
      fetchObject: async () => {
        throw new Error('boom');
      },
    });
    expect((await brandResponse(req('logo'), storageDown)).status).toBe(307);
    spy.mockRestore();
  });

  it('rejects unknown kinds and non-GET methods', async () => {
    expect((await brandResponse(req('secrets'), store())).status).toBe(404);
    expect((await brandResponse(req('logo', {}, 'POST'), store())).status).toBe(405);
  });
});

describe('manifest', () => {
  it('uses the same colours as the theme tokens (a manifest cannot reference CSS variables)', () => {
    const css = readFileSync(join(import.meta.dirname, '../../packages/ui/src/theme.css'), 'utf8');
    const token = (n: string) =>
      new RegExp(`--bp-${n}:\\s*(#[0-9a-fA-F]{6})`).exec(css)![1]!.toLowerCase();
    const m = buildManifest({}) as { background_color: string; theme_color: string };
    expect(m.background_color).toBe(token('bg'));
    expect(m.theme_color).toBe(token('primary'));
  });

  it('uses the built-in icons and name by default (incl. a maskable icon)', () => {
    const m = buildManifest({}) as { name: string; icons: { purpose: string }[] };
    expect(m.name).toBe('Bestie POS');
    expect(m.icons.some((i) => i.purpose === 'maskable')).toBe(true);
  });

  it('follows the admin name and tab icon; only declares sizes the icon really has', () => {
    const small = buildManifest({
      nameEn: 'Island Shop Koh Phangan',
      favicon: { mime: 'image/png', version: 3, size: 256 },
    }) as { name: string; short_name: string; icons: { sizes: string; src: string }[] };
    expect(small.name).toBe('Island Shop Koh Phangan');
    expect(small.short_name).toBe('Island Shop ');
    expect(small.icons.map((i) => i.sizes)).toEqual(['192x192']);
    expect(small.icons[0]!.src).toBe('/brand/favicon?v=3');
    const big = buildManifest({ favicon: { mime: 'image/png', version: 3, size: 1024 } }) as {
      icons: { sizes: string }[];
    };
    expect(big.icons.map((i) => i.sizes)).toEqual(['192x192', '512x512']);
  });

  it('is served as JSON with the manifest content type', async () => {
    const res = await brandResponse(
      req('manifest'),
      store({ loadBrand: async () => ({ nameEn: 'X "quoted" <b>' }) }),
    );
    expect(res.headers.get('content-type')).toBe('application/manifest+json');
    expect(((await res.json()) as { name: string }).name).toBe('X "quoted" <b>'); // JSON-encoded, never concatenated into HTML
  });
});

describe('createSupabaseBrandStore', () => {
  it('reads the brand over REST with the service key, caches it, and parses leniently', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            { brand: { name_en: 'Eng', evil: 1, logo: { mime: 'image/png', version: 1 } } },
          ]),
        ),
    );
    const s = createSupabaseBrandStore(
      'https://p.supabase.co',
      'service-key',
      fetchMock as unknown as typeof fetch,
    );
    expect(await s.loadBrand()).toEqual({ nameEn: 'Eng', logo: { mime: 'image/png', version: 1 } });
    await s.loadBrand();
    expect(fetchMock).toHaveBeenCalledTimes(1); // 30 s cache
    expect(
      (fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }])[1]
        .headers.apikey,
    ).toBe('service-key');
  });

  it('treats a missing storage object as "no image"', async () => {
    const s = createSupabaseBrandStore(
      'https://p.supabase.co',
      'k',
      (async () => new Response('', { status: 404 })) as unknown as typeof fetch,
    );
    expect(await s.fetchObject('logo-1.png')).toBeNull();
  });
});
