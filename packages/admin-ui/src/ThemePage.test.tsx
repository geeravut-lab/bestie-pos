import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '@bestie/i18n';
import type { PageContext } from '@bestie/auth';
import { ThemePage } from './ThemePage';
import { fakeDb } from './fakeDb';

afterEach(cleanup);

const fixed = { ink: '#0f2d4a', muted: '#4f6577', white: '#ffffff', surface: '#ffffff' };
const tables = (theme: unknown = {}) => ({ stores: [{ id: 's1', name: 'Acme', theme }] });
const ctx = (client: unknown, over: Partial<PageContext> = {}): PageContext => ({
  path: '/settings/theme',
  navigate: () => {},
  client: client as never,
  orgId: 'o1',
  storeId: 's1',
  permissions: [],
  isOwner: true,
  isPlatformAdmin: false,
  ...over,
});
const mount = (c: PageContext) =>
  render(
    <I18nProvider initialLang="en">
      <ThemePage ctx={c} fixedOverride={fixed} />
    </I18nProvider>,
  );
const field = (label: string) => screen.getByRole('textbox', { name: label }) as HTMLInputElement;
const type = (label: string, v: string) => fireEvent.change(field(label), { target: { value: v } });

describe('<ThemePage>', () => {
  it('an empty theme is fine and nothing can be saved yet', async () => {
    mount(ctx(fakeDb(tables()).client));
    await screen.findByRole('heading', { name: 'Shop colours' });
    expect(screen.getByText('Every pair is readable.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a readable palette can be saved, as lower-case #rrggbb of the chosen keys only', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client));
    await screen.findByRole('heading', { name: 'Shop colours' });
    type('Main colour (buttons, links)', '#7A1F5C');
    type('Highlight', '#FFCB3D');
    expect(screen.getByText('Every pair is readable.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(db.writes).toHaveLength(1));
    expect(db.writes[0]).toMatchObject({
      table: 'stores',
      op: 'update',
      values: { theme: { primary: '#7a1f5c', sun: '#ffcb3d' } },
    });
  });

  it('a pale main colour is explained pair by pair and cannot be saved', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client));
    await screen.findByRole('heading', { name: 'Shop colours' });
    type('Main colour (buttons, links)', '#9fe0d8');
    expect(await screen.findByText(/White text on the main colour: contrast/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    expect(db.writes).toHaveLength(0);
  });

  it('a dark highlight fails: navy text needs a light fill', async () => {
    mount(ctx(fakeDb(tables()).client));
    await screen.findByRole('heading', { name: 'Shop colours' });
    type('Highlight', '#222222');
    expect(await screen.findByText(/Navy text on the highlight: contrast/)).toBeTruthy();
  });

  it('typing something that is not a colour clears that key (back to the default)', async () => {
    mount(ctx(fakeDb(tables({ sun: '#ffcb3d' })).client));
    await screen.findByRole('heading', { name: 'Shop colours' });
    expect(field('Highlight').value).toBe('#ffcb3d');
    type('Highlight', 'yellow');
    expect(field('Highlight').value).toBe('');
  });

  it('"Use the default colours" saves an empty theme', async () => {
    const db = fakeDb(tables({ sun: '#ffcb3d' }));
    mount(ctx(db.client));
    await screen.findByRole('heading', { name: 'Shop colours' });
    await userEvent.click(screen.getByRole('button', { name: 'Use the default colours' }));
    await waitFor(() => expect(db.writes).toHaveLength(1));
    expect(db.writes[0]).toMatchObject({ values: { theme: {} } });
  });

  it('is read-only without settings.manage', async () => {
    mount(ctx(fakeDb(tables()).client, { isOwner: false }));
    await screen.findByRole('heading', { name: 'Shop colours' });
    expect(field('Highlight').disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });
});
