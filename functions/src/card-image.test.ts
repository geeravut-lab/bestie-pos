import { describe, expect, it } from 'vitest';
import { cardImageResponse } from './card-image.js';
import type { CardImageStore } from './card-image.js';

const store = (over: Partial<CardImageStore> = {}): CardImageStore => ({
  load: async () => ({ sell: { mime: 'image/png', version: 7 } }),
  fetchObject: async (p) => (p === 'sell-7.png' ? new Uint8Array([1, 2, 3]).buffer : null),
  ...over,
});
const get = (qs: string, headers: Record<string, string> = {}, method = 'GET') =>
  new Request(`https://x/api/card-image?${qs}`, { method, headers });

describe('GET /api/card-image', () => {
  it('serves the current file with its type, an ETag and locked-down headers', async () => {
    const r = await cardImageResponse(get('id=sell&v=7'), store());
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    expect(r.headers.get('etag')).toBe('"card-sell-7"');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
  it('answers 304 for a matching ETag without touching storage', async () => {
    let touched = false;
    const r = await cardImageResponse(
      get('id=sell', { 'if-none-match': '"card-sell-7"' }),
      store({ fetchObject: async () => ((touched = true), null) }),
    );
    expect(r.status).toBe(304);
    expect(touched).toBe(false);
  });
  it('404 for no picture, a bad id, a missing file or any failure (the page uses its illustration)', async () => {
    expect((await cardImageResponse(get('id=tables'), store())).status).toBe(404);
    expect((await cardImageResponse(get('id=../etc'), store())).status).toBe(404);
    expect(
      (await cardImageResponse(get('id=sell'), store({ fetchObject: async () => null }))).status,
    ).toBe(404);
    expect(
      (
        await cardImageResponse(
          get('id=sell'),
          store({
            load: async () => {
              throw new Error('x');
            },
          }),
        )
      ).status,
    ).toBe(404);
  });
  it('only GET / HEAD', async () => {
    expect((await cardImageResponse(get('id=sell', {}, 'POST'), store())).status).toBe(405);
  });
});
