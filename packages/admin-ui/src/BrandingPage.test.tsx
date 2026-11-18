import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@bestie/i18n';
import type { PageContext } from '@bestie/auth';
import { BrandingPage } from './BrandingPage';
import { removeBrandImage, saveBrandNames, uploadBrandImage } from './brandingActions';

afterEach(cleanup);

/** A tiny but header-valid PNG. */
function png(width: number, height: number): File {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, width);
  dv.setUint32(20, height);
  return new File([b], 'icon.png', { type: 'image/png' });
}

function fakeClient(opts: { brand?: unknown; updatedRows?: number; uploadError?: boolean } = {}) {
  const updates: unknown[] = [];
  const storage = {
    upload: vi.fn(async () => ({ error: opts.uploadError ? { message: 'x' } : null })),
    remove: vi.fn(async () => ({ error: null })),
  };
  const from = vi.fn(() => {
    const chain: Record<string, unknown> = {};
    let updated = false; // per query: `.update(...).select()` resolves with the touched rows, a plain `.select()` is a read
    chain.select = () =>
      updated
        ? Promise.resolve({
            data: Array.from({ length: opts.updatedRows ?? 1 }, () => ({ id: true })),
            error: null,
          })
        : chain;
    chain.maybeSingle = async () => ({ data: { brand: opts.brand ?? {} }, error: null });
    chain.update = (v: unknown) => {
      updated = true;
      updates.push(v);
      return chain;
    };
    chain.eq = () => chain;
    return chain;
  });
  const channel = () => {
    const ch: Record<string, unknown> = {};
    ch.on = () => ch;
    ch.subscribe = (cb?: (s: string) => void) => {
      cb?.('SUBSCRIBED');
      return ch;
    };
    return ch;
  };
  const client = {
    from,
    storage: { from: () => storage },
    channel,
    removeChannel: vi.fn(async () => 'ok'),
  };
  return { client: client as never, updates, storage };
}

describe('brand actions', () => {
  it('uploads a new versioned file, points the settings at it, then deletes the old file', async () => {
    const { client, updates, storage } = fakeClient();
    const next = await uploadBrandImage(client, 'favicon', png(512, 512), {
      favicon: { mime: 'image/png', version: 1, size: 512 },
    });
    const path = (storage.upload.mock.calls[0] as unknown as [string])[0];
    expect(path).toMatch(/^favicon-\d+\.png$/);
    expect(path).not.toBe('favicon-1.png'); // never overwrites the old file
    expect(next.favicon!.size).toBe(512);
    expect((updates[0] as { brand: { favicon: { version: number } } }).brand.favicon.version).toBe(
      next.favicon!.version,
    );
    expect(storage.remove).toHaveBeenCalledWith(['favicon-1.png']); // old file removed only after the switch
  });

  it('refuses a bad icon before touching storage', async () => {
    const { client, storage } = fakeClient();
    await expect(uploadBrandImage(client, 'favicon', png(512, 300), {})).rejects.toMatchObject({
      code: 'err_brand_not_square',
    });
    await expect(uploadBrandImage(client, 'favicon', png(64, 64), {})).rejects.toMatchObject({
      code: 'err_brand_too_small',
    });
    await expect(
      uploadBrandImage(
        client,
        'logo',
        new File([new TextEncoder().encode('<svg/>')], 'x.svg', { type: 'image/svg+xml' }),
        {},
      ),
    ).rejects.toMatchObject({ code: 'err_brand_bad_type' });
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('removes the new file again when the settings update touches no row (old image keeps working)', async () => {
    const { client, storage } = fakeClient({ updatedRows: 0 });
    await expect(
      uploadBrandImage(client, 'logo', png(300, 100), { logo: { mime: 'image/png', version: 9 } }),
    ).rejects.toMatchObject({ code: 'err_save_failed' });
    expect(storage.remove).toHaveBeenCalledTimes(1);
    const removed = (storage.remove.mock.calls[0] as unknown as [string[]])[0][0]!;
    expect(removed).not.toBe('logo-9.png'); // the ORPHAN was removed, not the old image
  });

  it('a failed upload changes nothing', async () => {
    const { client, updates } = fakeClient({ uploadError: true });
    await expect(uploadBrandImage(client, 'logo', png(300, 100), {})).rejects.toMatchObject({
      code: 'err_save_failed',
    });
    expect(updates).toHaveLength(0);
  });

  it('use-default clears the reference first, then deletes the file', async () => {
    const { client, updates, storage } = fakeClient();
    const next = await removeBrandImage(client, 'logo', {
      nameEn: 'X',
      logo: { mime: 'image/png', version: 5 },
    });
    expect(next).toEqual({ nameEn: 'X' });
    expect((updates[0] as { brand: unknown }).brand).toEqual({ name_en: 'X' });
    expect(storage.remove).toHaveBeenCalledWith(['logo-5.png']);
  });

  it('validates names before saving', async () => {
    const { client, updates } = fakeClient();
    await expect(
      saveBrandNames(client, {}, { nameTh: '', nameEn: '<b>x</b>' }),
    ).rejects.toMatchObject({ code: 'err_brand_name_invalid' });
    expect(updates).toHaveLength(0);
    expect(await saveBrandNames(client, {}, { nameTh: ' ร้านเรา ', nameEn: '' })).toEqual({
      nameTh: 'ร้านเรา',
      nameEn: undefined,
    });
  });
});

const ctx = (client: unknown, isPlatformAdmin = true): PageContext => ({
  path: '/admin/branding',
  navigate: () => {},
  client: client as never,
  orgId: 'o',
  storeId: null,
  permissions: [],
  isOwner: false,
  isPlatformAdmin,
});
const mount = (c: PageContext) =>
  render(
    <I18nProvider initialLang="en">
      <BrandingPage ctx={c} />
    </I18nProvider>,
  );

describe('<BrandingPage>', () => {
  it('is for platform admins only', () => {
    mount(ctx(fakeClient().client, false));
    expect(screen.getByRole('alert').textContent).toContain('platform admins');
  });

  it('shows the defaults, validates a wrong icon in the UI and shows a readable error', async () => {
    mount(ctx(fakeClient().client));
    expect(await screen.findByRole('heading', { name: 'Platform branding' })).toBeTruthy();
    expect(screen.getAllByText('Default')).toHaveLength(2);
    const input = screen.getByLabelText('Choose a file', { selector: '#brand-file-favicon' });
    await userEvent.upload(input, png(512, 300));
    await userEvent.click(screen.getAllByRole('button', { name: 'Upload' })[1]!);
    expect((await screen.findByRole('alert')).textContent).toContain('square');
  });

  it('upload buttons stay disabled until a file is chosen; saving names shows the success note', async () => {
    const { client, updates } = fakeClient({ brand: { name_en: 'Old' } });
    mount(ctx(client));
    await screen.findByRole('heading', { name: 'Platform branding' });
    for (const b of screen.getAllByRole('button', { name: 'Upload' }))
      expect((b as HTMLButtonElement).disabled).toBe(true);
    await userEvent.clear(screen.getByLabelText('Name (English)'));
    await userEvent.type(screen.getByLabelText('Name (English)'), 'Island Shop');
    await userEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(updates).toHaveLength(1));
    expect((updates[0] as { brand: unknown }).brand).toEqual({ name_en: 'Island Shop' });
    expect(await screen.findByText(/within about a minute/)).toBeTruthy();
  });
});
