import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@bestie/i18n';
import type { PageContext } from '@bestie/auth';
import { CardImagesPage } from './CardImagesPage';
import { removeCardImage, uploadCardImage } from './cardImageActions';

afterEach(cleanup);

const PNG = () =>
  new File(
    [Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])],
    'a.png',
    {
      type: 'image/png',
    },
  );

function fakeClient(opts: { images?: unknown; updatedRows?: number; uploadError?: boolean } = {}) {
  const updates: unknown[] = [];
  const storage = {
    upload: vi.fn(async () => ({ error: opts.uploadError ? { message: 'x' } : null })),
    remove: vi.fn(async () => ({ error: null })),
  };
  const from = vi.fn(() => {
    const chain: Record<string, unknown> = {};
    let updated = false;
    chain.select = () =>
      updated
        ? Promise.resolve({
            data: Array.from({ length: opts.updatedRows ?? 1 }, () => ({ id: true })),
            error: null,
          })
        : chain;
    chain.maybeSingle = async () => ({ data: { card_images: opts.images ?? {} }, error: null });
    chain.update = (v: unknown) => {
      updated = true;
      updates.push(v);
      return chain;
    };
    chain.eq = () => chain;
    return chain;
  });
  return {
    client: {
      from,
      storage: { from: () => storage },
      channel: () => ({
        on() {
          return this;
        },
        subscribe() {
          return this;
        },
      }),
      removeChannel: async () => 'ok',
    } as never,
    updates,
    storage,
  };
}
const ctx = (client: unknown, admin = true): PageContext => ({
  path: '/admin/cards',
  navigate: () => {},
  client: client as never,
  orgId: 'o1',
  storeId: null,
  permissions: [],
  isOwner: false,
  isPlatformAdmin: admin,
});

describe('card image actions', () => {
  it('uploads a NEW versioned file, points the settings at it, then deletes the old one', async () => {
    const f = fakeClient();
    const next = await uploadCardImage(f.client, 'sell', PNG(), {
      sell: { mime: 'image/png', version: 1 },
    });
    expect(next.sell!.version).toBeGreaterThan(1);
    expect(f.storage.upload).toHaveBeenCalledTimes(1);
    expect(f.updates[0]).toEqual({ card_images: next });
    expect(f.storage.remove).toHaveBeenCalledWith(['sell-1.png']);
  });
  it('refuses a file that is not a picture, before touching storage', async () => {
    const f = fakeClient();
    await expect(
      uploadCardImage(f.client, 'sell', new File([new Uint8Array(20)], 'x.png'), {}),
    ).rejects.toMatchObject({ code: 'err_brand_bad_type' });
    expect(f.storage.upload).not.toHaveBeenCalled();
  });
  it('an update that touches no row removes the orphan and keeps the old picture', async () => {
    const f = fakeClient({ updatedRows: 0 });
    await expect(
      uploadCardImage(f.client, 'sell', PNG(), { sell: { mime: 'image/png', version: 1 } }),
    ).rejects.toBeTruthy();
    expect(f.storage.remove).toHaveBeenCalledTimes(1);
    expect(f.storage.remove).not.toHaveBeenCalledWith(['sell-1.png']);
  });
  it('"built-in picture" forgets the reference first, then deletes the file', async () => {
    const f = fakeClient();
    const next = await removeCardImage(f.client, 'sell', {
      sell: { mime: 'image/png', version: 3 },
    });
    expect(next).toEqual({});
    expect(f.updates[0]).toEqual({ card_images: {} });
    expect(f.storage.remove).toHaveBeenCalledWith(['sell-3.png']);
  });
});

describe('<CardImagesPage>', () => {
  const mount = (c: PageContext) =>
    render(
      <I18nProvider initialLang="en">
        <CardImagesPage ctx={c} />
      </I18nProvider>,
    );
  it('lists the cards, marks the replaced one and offers "use the built-in picture" only there', async () => {
    mount(ctx(fakeClient({ images: { sell: { mime: 'image/png', version: 9 } } }).client));
    await screen.findByRole('heading', { name: 'Home card pictures' });
    expect(document.querySelector('img[src="/api/card-image?id=sell&v=9"]')).not.toBeNull();
    expect(screen.getAllByRole('button', { name: 'Use the default' })).toHaveLength(1);
  });
  it('is for the platform admin only', async () => {
    mount(ctx(fakeClient().client, false));
    expect(await screen.findByText(/administrators only|platform admin/i)).toBeTruthy();
  });
});
