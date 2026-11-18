import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '@bestie/i18n';
import type { PageContext } from '@bestie/auth';
import { StaffPage } from './StaffPage';
import { fakeDb } from './fakeDb';

afterEach(cleanup);

const roles = [
  { id: 'r-owner', name: 'Owner', built_in: 'owner' },
  { id: 'r-mgr', name: 'Manager', built_in: 'manager' },
  { id: 'r-cash', name: 'Cashier', built_in: 'cashier' },
];
const staff = [
  { id: 'st1', store_id: null, display_name: 'Boss', role_id: 'r-owner', active: true },
  { id: 'st2', store_id: 's1', display_name: 'Nok', role_id: 'r-cash', active: true },
];
const tables = () => ({
  roles,
  staff,
  stores: [{ id: 's1', name: 'Acme' }],
  staff_invites: [
    {
      id: 'i1',
      display_name: 'Pim',
      role_id: 'r-cash',
      store_id: null,
      expires_at: '2026-12-01T00:00:00Z',
    },
  ],
});
const ctx = (client: unknown, over: Partial<PageContext> = {}): PageContext => ({
  path: '/staff',
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
      <StaffPage ctx={c} />
    </I18nProvider>,
  );
const row = (name: string) => screen.getByText(name).closest('li') as HTMLElement;

describe('<StaffPage>', () => {
  it('lists the team, and the pending invites for someone who can manage staff', async () => {
    mount(ctx(fakeDb(tables()).client));
    await screen.findByRole('heading', { name: 'Team & roles' });
    expect(row('Nok')).toBeTruthy();
    expect(screen.getByText('Pim')).toBeTruthy();
  });

  it('changes a role through an update that is checked for rows touched', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client));
    await screen.findByRole('heading', { name: 'Team & roles' });
    await userEvent.selectOptions(within(row('Nok')).getByLabelText('Role'), 'r-mgr');
    await waitFor(() => expect(db.writes).toHaveLength(1));
    expect(db.writes[0]).toMatchObject({ table: 'staff', values: { role_id: 'r-mgr' } });
  });

  it('a manager never sees the owner role as a choice and cannot edit the owner row', async () => {
    mount(ctx(fakeDb(tables()).client, { isOwner: false, permissions: ['staff.manage'] }));
    await screen.findByRole('heading', { name: 'Team & roles' });
    const nokRole = within(row('Nok')).getByLabelText('Role') as HTMLSelectElement;
    expect([...nokRole.options].map((o) => o.value)).not.toContain('r-owner');
    expect((within(row('Boss')).getByLabelText('Role') as HTMLSelectElement).disabled).toBe(true);
    expect(within(row('Boss')).queryByRole('button', { name: 'Deactivate' })).toBeNull();
    const inviteRole = screen.getByLabelText('Role', {
      selector: '#inv-role',
    }) as HTMLSelectElement;
    expect([...inviteRole.options].map((o) => o.value)).not.toContain('r-owner');
  });

  it('someone without staff.manage only sees the team, with no controls or invites', async () => {
    mount(ctx(fakeDb(tables()).client, { isOwner: false, permissions: ['report.view'] }));
    await screen.findByRole('heading', { name: 'Team & roles' });
    expect(screen.queryByRole('button', { name: 'Create invite code' })).toBeNull();
    expect(screen.queryByText('Pim')).toBeNull();
    expect((within(row('Nok')).getByLabelText('Role') as HTMLSelectElement).disabled).toBe(true);
  });

  it('deactivates a person', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client));
    await screen.findByRole('heading', { name: 'Team & roles' });
    await userEvent.click(within(row('Nok')).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(db.writes).toHaveLength(1));
    expect(db.writes[0]).toMatchObject({ table: 'staff', values: { active: false } });
  });

  it('creates an invite, shows the code once in AAAA-BBBB-CCCC form', async () => {
    const db = fakeDb(tables(), { rpc: { create_staff_invite: { data: 'AB12CD34EF56' } } });
    mount(ctx(db.client));
    await screen.findByRole('heading', { name: 'Team & roles' });
    await userEvent.type(screen.getByLabelText('Display name'), 'Mali');
    await userEvent.click(screen.getByRole('button', { name: 'Create invite code' }));
    expect(await screen.findByText('AB12-CD34-EF56')).toBeTruthy();
    expect(db.rpcs[0]).toEqual({
      fn: 'create_staff_invite',
      args: { p_org: 'o1', p_store: null, p_role: 'r-cash', p_name: 'Mali' },
    });
  });

  it('needs a name before it asks the server for an invite', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client));
    await screen.findByRole('heading', { name: 'Team & roles' });
    await userEvent.click(screen.getByRole('button', { name: 'Create invite code' }));
    await screen.findAllByRole('alert');
    expect(db.rpcs).toHaveLength(0);
  });

  it('shows "only the owner" when the server refuses an invite', async () => {
    const db = fakeDb(tables(), { rpc: { create_staff_invite: { error: { code: '42501' } } } });
    mount(ctx(db.client));
    await screen.findByRole('heading', { name: 'Team & roles' });
    await userEvent.type(screen.getByLabelText('Display name'), 'Mali');
    await userEvent.click(screen.getByRole('button', { name: 'Create invite code' }));
    expect((await screen.findAllByText('Only the owner can do this.')).length).toBe(1);
  });

  it('sets a PIN (digits only), clears the field afterwards, and rejects short PINs locally', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client));
    await screen.findByRole('heading', { name: 'Team & roles' });
    const nok = row('Nok');
    const input = within(nok).getByLabelText(/New PIN/) as HTMLInputElement;
    await userEvent.type(input, '12');
    await userEvent.click(within(nok).getByRole('button', { name: 'Set PIN' }));
    await within(nok).findByText('A PIN is 4 to 8 digits.');
    expect(db.rpcs).toHaveLength(0);
    await userEvent.clear(input);
    await userEvent.type(input, '48a21');
    expect(input.value).toBe('4821');
    await userEvent.click(within(nok).getByRole('button', { name: 'Set PIN' }));
    await within(nok).findByText('PIN set.');
    expect(db.rpcs[0]).toEqual({ fn: 'set_staff_pin', args: { p_staff: 'st2', p_pin: '4821' } });
    expect(input.value).toBe('');
  });

  it('revokes an invite', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client));
    await screen.findByRole('heading', { name: 'Team & roles' });
    await userEvent.click(screen.getByRole('button', { name: 'Cancel invite' }));
    await waitFor(() => expect(db.rpcs).toHaveLength(1));
    expect(db.rpcs[0]).toEqual({ fn: 'revoke_staff_invite', args: { p_invite: 'i1' } });
  });
});
