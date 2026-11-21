import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '@bestie/i18n';
import type { PageContext } from '@bestie/auth';
import { ModulesPage } from './ModulesPage';
import { fakeDb } from './fakeDb';

afterEach(cleanup);

const store = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  name: 'Acme',
  profile: 'salon',
  plan: 'pro',
  module_overrides: {},
  ...over,
});
const ctx = (client: unknown, over: Partial<PageContext> = {}): PageContext => ({
  path: '/modules',
  navigate: () => {},
  client: client as never,
  orgId: 'o1',
  storeId: null,
  permissions: [],
  isOwner: true,
  isPlatformAdmin: false,
  ...over,
});
const mount = (c: PageContext) =>
  render(
    <I18nProvider initialLang="en">
      <ModulesPage ctx={c} />
    </I18nProvider>,
  );
const sw = (name: string) => screen.getByRole('switch', { name: new RegExp(name) });

describe('<ModulesPage>', () => {
  it('shows every module with the shop profile defaults', async () => {
    const db = fakeDb({ stores: [store()], orgs: [{ legal_sign_off: {} }] });
    mount(ctx(db.client));
    await screen.findByRole('heading', { name: 'Modules' });
    expect((sw('Appointments & online booking') as HTMLInputElement).checked).toBe(true);
    expect((sw('Kitchen display') as HTMLInputElement).checked).toBe(false);
    expect(screen.getAllByRole('switch')).toHaveLength(35);
  });

  it('switching a module on saves ONLY the difference from the profile default, and auto-enables what it needs', async () => {
    const db = fakeDb({ stores: [store({ profile: 'salon' })], orgs: [{ legal_sign_off: {} }] });
    mount(ctx(db.client));
    await screen.findByRole('heading', { name: 'Modules' });
    await userEvent.click(sw('Kitchen display'));
    await waitFor(() => expect(db.writes).toHaveLength(1));
    expect(db.writes[0]).toMatchObject({
      table: 'stores',
      op: 'update',
      values: { module_overrides: { kds: true } },
    });
  });

  it('warns before switching off a module others depend on, and only saves after confirming', async () => {
    const db = fakeDb({
      stores: [store({ module_overrides: { deposits: true } })],
      orgs: [{ legal_sign_off: {} }],
    });
    mount(ctx(db.client));
    await screen.findByRole('heading', { name: 'Modules' });
    await userEvent.click(sw('Appointments & online booking'));
    const box = await screen.findByRole('alertdialog');
    expect(box.textContent).toContain('Deposits');
    expect(db.writes).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Yes, switch off' }));
    await waitFor(() => expect(db.writes).toHaveLength(1));
    const saved = (db.writes[0]!.values as { module_overrides: Record<string, boolean> })
      .module_overrides;
    expect(saved).toMatchObject({ appointments: false, deposits: false });
  });

  it('keeps the legally gated crypto top-up locked without the sign-off', async () => {
    const db = fakeDb({ stores: [store()], orgs: [{ legal_sign_off: {} }] });
    mount(ctx(db.client));
    await screen.findByRole('heading', { name: 'Modules' });
    expect((sw('Credit top-up by crypto') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getAllByText(/legal sign-off/).length).toBeGreaterThan(0);
  });

  it('is read-only without permission', async () => {
    const db = fakeDb({ stores: [store()], orgs: [{ legal_sign_off: {} }] });
    mount(ctx(db.client, { isOwner: false, permissions: ['report.view'] }));
    await screen.findByRole('heading', { name: 'Modules' });
    for (const s of screen.getAllByRole('switch'))
      expect((s as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Add shop' })).toBeNull();
  });

  it('reports a refused save (RLS touched 0 rows) instead of pretending it worked', async () => {
    const db = fakeDb({ stores: [store()], orgs: [{ legal_sign_off: {} }] }, { updatedRows: 0 });
    mount(ctx(db.client));
    await screen.findByRole('heading', { name: 'Modules' });
    await userEvent.click(sw('Kitchen display'));
    expect((await screen.findAllByText(/Couldn't save/)).length).toBeGreaterThan(0);
  });

  it('adds a shop through the create_store RPC', async () => {
    const db = fakeDb({ stores: [store()], orgs: [{ legal_sign_off: {} }] });
    mount(ctx(db.client));
    await screen.findByRole('heading', { name: 'Modules' });
    await userEvent.type(screen.getByLabelText('Shop name (branch)'), 'Beach Cafe');
    await userEvent.selectOptions(screen.getByLabelText('Store type'), 'cafe');
    await userEvent.click(screen.getByRole('button', { name: 'Add shop' }));
    await waitFor(() => expect(db.rpcs).toHaveLength(1));
    expect(db.rpcs[0]).toEqual({
      fn: 'create_store',
      args: { p_org: 'o1', p_name: 'Beach Cafe', p_profile: 'cafe' },
    });
    expect((await screen.findAllByText('Shop added.')).length).toBe(1);
  });

  it('refuses an empty shop name without calling the server', async () => {
    const db = fakeDb({ stores: [store()], orgs: [{ legal_sign_off: {} }] });
    mount(ctx(db.client));
    await screen.findByRole('heading', { name: 'Modules' });
    await userEvent.click(screen.getByRole('button', { name: 'Add shop' }));
    expect((await screen.findAllByText(/enter a shop name/i)).length).toBe(1);
    expect(db.rpcs).toHaveLength(0);
  });
});
