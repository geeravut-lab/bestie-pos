import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { PageContext } from '@bestie/auth';
import { I18nProvider } from '@bestie/i18n';
import { fakeDb } from './fakeDb';
import { OrgMembersPage } from './OrgMembersPage';

afterEach(cleanup);

const ORGS = {
  orgs: [
    {
      id: 'org-real',
      name: 'Real Co',
      staff_count: 5,
      empty: false,
      stores: [
        { id: 'st-1', name: 'Kitchen' },
        { id: 'st-2', name: 'Cafe' },
      ],
    },
    { id: 'org-oops', name: 'Real Co', staff_count: 1, empty: true, stores: [] },
  ],
};
const PERSON = {
  user_id: 'u-9',
  email: 'new@example.test',
  confirmed: true,
  memberships: [
    {
      org_id: 'org-oops',
      org_name: 'Real Co',
      role: 'owner',
      store_id: null,
      store_name: null,
      active: true,
    },
  ],
};

const mount = (
  rpc: Record<string, { data?: unknown; error?: { code: string } | null }>,
  over: Partial<PageContext> = {},
) => {
  const db = fakeDb({}, { rpc });
  const ctx = {
    path: '/admin/org-members',
    navigate: () => undefined,
    client: db.client as never,
    orgId: 'o1',
    storeId: 's1',
    permissions: [],
    isOwner: true,
    isPlatformAdmin: true,
    ...over,
  } as PageContext;
  render(
    <I18nProvider initialLang="en">
      <OrgMembersPage ctx={ctx} />
    </I18nProvider>,
  );
  return db;
};

const find = async (email = 'new@example.test') => {
  await userEvent.type(screen.getByPlaceholderText('E-mail of the account to move'), email);
  await userEvent.click(screen.getByRole('button', { name: 'Find' }));
};

describe('<OrgMembersPage>', () => {
  it('is for the platform administrator only and asks the server for nothing otherwise', async () => {
    const db = mount({ platform_orgs_overview: { data: ORGS } }, { isPlatformAdmin: false });
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(db.rpcs).toHaveLength(0);
  });

  it('finds a person and shows where they work now', async () => {
    const db = mount({
      platform_orgs_overview: { data: ORGS },
      platform_member_lookup: { data: PERSON },
    });
    await find('  New@Example.test ');
    expect(await screen.findByText('new@example.test is now in')).toBeTruthy();
    expect(db.rpcs.find((r) => r.fn === 'platform_member_lookup')!.args).toEqual({
      p_email: 'New@Example.test',
    });
    expect(screen.getByText(/Owner · All shops/)).toBeTruthy();
  });

  it('says plainly when there is no such account', async () => {
    mount({
      platform_orgs_overview: { data: ORGS },
      platform_member_lookup: { error: { code: 'P0002' } },
    });
    await find('nobody@example.test');
    expect(await screen.findByText(/No account found/)).toBeTruthy();
  });

  it('moves only after a second confirming press, with the chosen business, role and shop', async () => {
    const db = mount({
      platform_orgs_overview: { data: ORGS },
      platform_member_lookup: { data: PERSON },
      platform_move_member: {
        data: { org_id: 'org-real', deleted: ['Real Co'], left: [] },
      },
    });
    await find();
    await screen.findByText('new@example.test is now in');
    const move = screen.getByRole('button', {
      name: 'Move into this business',
    }) as HTMLButtonElement;
    expect(move.disabled).toBe(true); // no business picked yet
    await userEvent.selectOptions(screen.getByLabelText('Target business'), 'org-real');
    await userEvent.selectOptions(screen.getByLabelText('Role'), 'manager');
    await userEvent.selectOptions(screen.getByLabelText('Shop'), 'st-2');
    await userEvent.click(screen.getByRole('button', { name: 'Move into this business' }));
    expect(db.rpcs.some((r) => r.fn === 'platform_move_member')).toBe(false); // first press only asks
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Confirm: move new@example.test into Real Co as Manager',
      }),
    );
    await waitFor(() => expect(db.rpcs.some((r) => r.fn === 'platform_move_member')).toBe(true));
    expect(db.rpcs.find((r) => r.fn === 'platform_move_member')!.args).toEqual({
      p: {
        user_id: 'u-9',
        org_id: 'org-real',
        role: 'manager',
        store_id: 'st-2',
        leave_others: true,
      },
    });
    expect(await screen.findByText('Moved')).toBeTruthy();
    expect(screen.getByText('Empty businesses deleted: Real Co')).toBeTruthy();
  });

  it.each([
    ['55000', /not confirmed, or the person is the only owner/],
    ['22023', /Something is not valid/],
    ['XX000', /That did not work/],
  ])('explains the server refusal %s', async (code, text) => {
    mount({
      platform_orgs_overview: { data: ORGS },
      platform_member_lookup: { data: PERSON },
      platform_move_member: { error: { code } },
    });
    await find();
    await screen.findByText('new@example.test is now in');
    await userEvent.selectOptions(screen.getByLabelText('Target business'), 'org-real');
    await userEvent.click(screen.getByRole('button', { name: 'Move into this business' }));
    await userEvent.click(screen.getByRole('button', { name: /^Confirm: move/ }));
    expect(await screen.findByText(text)).toBeTruthy();
  });
});
