import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageContext } from '@bestie/auth';
import { I18nProvider } from '@bestie/i18n';
import { fakeDb } from './fakeDb';
import { ItemPhoto } from './ItemPhoto';

afterEach(cleanup);
const ctx = (client: unknown): PageContext => ({
  path: '/menu',
  navigate: () => {},
  client: client as never,
  orgId: 'o1',
  storeId: 's1',
  permissions: ['menu.edit'],
  isOwner: false,
  isPlatformAdmin: false,
});
const file = (type = 'image/png', size = 2000) =>
  new File([new Uint8Array(size)], 'dish.png', { type });
const mount = (c: PageContext, over: Partial<React.ComponentProps<typeof ItemPhoto>> = {}) => {
  const onChanged = vi.fn();
  const prepare = vi.fn(async () => ({
    mime: 'image/jpeg' as const,
    base64: '/9j/AAAA',
    bytes: 5000,
  }));
  render(
    <I18nProvider initialLang="en">
      <ItemPhoto
        ctx={c}
        itemId="i1"
        itemName="Pad Thai"
        version={null}
        onChanged={onChanged}
        prepare={prepare}
        {...over}
      />
    </I18nProvider>,
  );
  return { onChanged, prepare };
};
const pick = (f: File) =>
  fireEvent.change(screen.getByLabelText('Menu picture file'), { target: { files: [f] } });

describe('<ItemPhoto>', () => {
  it('with no picture it says so and offers to choose one', () => {
    mount(ctx(fakeDb({}).client));
    expect(screen.getByText('No picture yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Choose a picture' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove the picture' })).toBeNull();
  });

  it('shows the current picture by its versioned address, and offers replace / remove', () => {
    mount(ctx(fakeDb({}).client), { version: 3 });
    const img = screen.getByAltText('Picture of Pad Thai') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/api/menu-image?i=i1&v=3');
    expect(screen.getByRole('button', { name: 'Replace the picture' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove the picture' })).toBeTruthy();
  });

  it('shrinks the chosen file, sends it through the database function and reloads the menu', async () => {
    const db = fakeDb({});
    const { onChanged, prepare } = mount(ctx(db.client));
    pick(file());
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(db.rpcs).toEqual([
      { fn: 'save_menu_image', args: { p_item: 'i1', p_mime: 'image/jpeg', p_data: '/9j/AAAA' } },
    ]);
    expect(await screen.findByText(/Picture saved/)).toBeTruthy();
  });

  it('refuses a file that is not JPG / PNG / WebP before doing anything', async () => {
    const db = fakeDb({});
    const { prepare, onChanged } = mount(ctx(db.client));
    pick(file('image/svg+xml'));
    expect(await screen.findByText('Only JPG, PNG or WebP pictures can be used.')).toBeTruthy();
    pick(file('application/pdf'));
    expect(prepare).not.toHaveBeenCalled();
    expect(db.rpcs).toHaveLength(0);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('says plainly when the file cannot be read as a picture, or stays too big', async () => {
    const db = fakeDb({});
    mount(ctx(db.client), { prepare: async () => Promise.reject(new Error('decode')) });
    pick(file());
    expect(await screen.findByText(/cannot be opened as a picture/)).toBeTruthy();
    cleanup();
    mount(ctx(db.client), { prepare: async () => Promise.reject(new Error('toobig')) });
    pick(file());
    expect(await screen.findByText(/still too big after shrinking/)).toBeTruthy();
    expect(db.rpcs).toHaveLength(0);
  });

  it('a refused save (no menu.edit) is reported and does not reload', async () => {
    const db = fakeDb({}, { rpc: { save_menu_image: { error: { code: '42501' } } } });
    const { onChanged } = mount(ctx(db.client));
    pick(file());
    expect(await screen.findByText(/permission/i)).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('removing calls the database function and reloads', async () => {
    const db = fakeDb({});
    const { onChanged } = mount(ctx(db.client), { version: 2 });
    await userEvent.click(screen.getByRole('button', { name: 'Remove the picture' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(db.rpcs).toEqual([{ fn: 'remove_menu_image', args: { p_item: 'i1' } }]);
  });
});
