import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { PageContext } from '@bestie/auth';
import { I18nProvider } from '@bestie/i18n';
import { fakeDb } from './fakeDb';
import { PlatformAdminsPage } from './PlatformAdminsPage';

afterEach(cleanup);

const LIST = {
  admins: [
    {
      user_id: 'u-me',
      email: 'me@example.test',
      added_at: '2026-11-20T03:00:00Z',
      added_by_email: null,
      is_me: true,
    },
    {
      user_id: 'u-2',
      email: 'second@example.test',
      added_at: '2026-11-21T03:00:00Z',
      added_by_email: 'me@example.test',
      is_me: false,
    },
  ],
  log: [
    {
      action: 'add',
      actor_email: 'me@example.test',
      target_email: 'second@example.test',
      at: '2026-11-21T03:00:00Z',
    },
  ],
};

const mount = (
  rpc: Record<string, { data?: unknown; error?: { code: string } | null }>,
  over: Partial<PageContext> = {},
) => {
  const db = fakeDb({}, { rpc });
  const ctx = {
    path: '/admin/platform-admins',
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
      <PlatformAdminsPage ctx={ctx} />
    </I18nProvider>,
  );
  return db;
};

describe('<PlatformAdminsPage>', () => {
  it('is for the platform administrator only and asks the server for nothing otherwise', async () => {
    const db = mount({ platform_admins_list: { data: LIST } }, { isPlatformAdmin: false });
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(db.rpcs).toHaveLength(0);
  });

  it('lists the administrators with who added them, marks me and offers no remove button for me', async () => {
    mount({ platform_admins_list: { data: LIST } });
    expect(await screen.findByText('Platform administrators now (2)')).toBeTruthy();
    expect(screen.getByText('second@example.test')).toBeTruthy();
    expect(screen.getByText('You')).toBeTruthy();
    expect(screen.getByText(/by me@example\.test/)).toBeTruthy();
    expect(screen.getByText(/added by hand in the database/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove me@example.test' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove second@example.test' })).toBeTruthy();
    expect(screen.getByText('me@example.test added second@example.test')).toBeTruthy();
  });

  it('adds an administrator by e-mail', async () => {
    const db = mount({
      platform_admins_list: { data: LIST },
      platform_admin_add: { data: { user_id: 'u-3', email: 'new@example.test' } },
    });
    await screen.findByText('second@example.test');
    const add = screen.getByRole('button', { name: 'Make administrator' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    await userEvent.type(
      screen.getByPlaceholderText('E-mail of an existing account'),
      '  New@Example.test ',
    );
    await userEvent.click(add);
    await waitFor(() => expect(db.rpcs.some((r) => r.fn === 'platform_admin_add')).toBe(true));
    expect(db.rpcs.find((r) => r.fn === 'platform_admin_add')!.args).toEqual({
      p_email: 'New@Example.test',
    });
    expect(await screen.findByText('Administrator added: new@example.test')).toBeTruthy();
    // the list is read again after the change
    await waitFor(() =>
      expect(db.rpcs.filter((r) => r.fn === 'platform_admins_list').length).toBeGreaterThan(1),
    );
  });

  it.each([
    ['22023', 'That is not a valid e-mail address.'],
    ['P0002', 'No account uses this e-mail. The person must sign up and sign in to Bestie first.'],
    ['55000', 'The e-mail of this account is not confirmed yet. Confirm the e-mail first.'],
    ['23505', 'This person already is a platform administrator.'],
    ['XX000', 'That did not work'],
  ])('explains the server refusal %s in plain words', async (code, text) => {
    mount({ platform_admins_list: { data: LIST }, platform_admin_add: { error: { code } } });
    await screen.findByText('second@example.test');
    await userEvent.type(
      screen.getByPlaceholderText('E-mail of an existing account'),
      'x@example.test',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Make administrator' }));
    expect(await screen.findByText(text)).toBeTruthy();
  });

  it('removes somebody only after a second confirming click, and can be cancelled', async () => {
    const db = mount({
      platform_admins_list: { data: LIST },
      platform_admin_remove: { data: { user_id: 'u-2' } },
    });
    await screen.findByText('second@example.test');
    await userEvent.click(screen.getByRole('button', { name: 'Remove second@example.test' }));
    expect(db.rpcs.some((r) => r.fn === 'platform_admin_remove')).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(
      screen.queryByRole('button', { name: 'Confirm removing second@example.test' }),
    ).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Remove second@example.test' }));
    await userEvent.click(
      screen.getByRole('button', { name: 'Confirm removing second@example.test' }),
    );
    await waitFor(() => expect(db.rpcs.some((r) => r.fn === 'platform_admin_remove')).toBe(true));
    expect(db.rpcs.find((r) => r.fn === 'platform_admin_remove')!.args).toEqual({ p_user: 'u-2' });
    expect(await screen.findByText('Administrator removed')).toBeTruthy();
  });

  it('says why when the server refuses a removal (yourself / the last one)', async () => {
    mount({
      platform_admins_list: { data: LIST },
      platform_admin_remove: { error: { code: '55000' } },
    });
    await screen.findByText('second@example.test');
    await userEvent.click(screen.getByRole('button', { name: 'Remove second@example.test' }));
    await userEvent.click(
      screen.getByRole('button', { name: 'Confirm removing second@example.test' }),
    );
    expect(
      await screen.findByText('You cannot remove yourself or the last administrator.'),
    ).toBeTruthy();
  });

  it('shows a load error and an empty history politely', async () => {
    mount({ platform_admins_list: { error: { code: 'XX000' } } });
    expect(await screen.findByText('Could not load the data.')).toBeTruthy();
    cleanup();
    mount({ platform_admins_list: { data: { admins: LIST.admins, log: [] } } });
    expect(await screen.findByText('No history yet')).toBeTruthy();
  });
});
