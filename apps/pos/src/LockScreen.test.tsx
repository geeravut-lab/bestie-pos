import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@bestie/i18n';
import { resetOfflineDb } from '@bestie/offline';
import type { DeviceBinding } from '@bestie/offline';
import type { PageContext } from '@bestie/auth';
import { LockScreen } from './LockScreen';

vi.mock('@bestie/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAuth: () => ({ user: { id: 'u1' } }),
}));

afterEach(cleanup);
beforeEach(async () => {
  await resetOfflineDb();
});

const binding: DeviceBinding = {
  deviceId: 'd1',
  storeId: 's1',
  orgId: 'o1',
  name: 'Counter iPad',
  role: 'cashier',
  station: null,
  posId: null,
};
const role = (built_in: string, name: string, permissions: string[]) => ({
  built_in,
  name,
  permissions,
  hidden_modules: [],
});
const staff = [
  {
    id: 'nok',
    store_id: null,
    display_name: 'Nok',
    roles: role('cashier', 'Cashier', ['payment.take', 'bogus']),
  },
  {
    id: 'pim',
    store_id: 's1',
    display_name: 'Pim',
    roles: role('manager', 'Manager', ['staff.manage']),
  },
  { id: 'far', store_id: 's2', display_name: 'Far', roles: role('cashier', 'Cashier', []) },
  { id: 'nopin', store_id: null, display_name: 'NoPin', roles: role('waiter', 'Waiter', []) },
];

function client(
  over: { pinIds?: string[]; verify?: string | Error; deviceActive?: boolean; fail?: boolean } = {},
) {
  const chain = (data: unknown) => {
    const c: Record<string, unknown> = {};
    for (const m of ['select', 'eq']) c[m] = () => c;
    c.maybeSingle = async () => ({ data, error: null });
    c.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve({ data, error: over.fail ? { code: 'x' } : null }).then(res, rej);
    return c;
  };
  return {
    from: (table: string) =>
      chain(table === 'staff' ? staff : { active: over.deviceActive ?? true }),
    rpc: vi.fn(async (fn: string) => {
      if (fn === 'staff_with_pin')
        return { data: over.pinIds ?? ['nok', 'pim', 'far'], error: null };
      if (over.verify instanceof Error) throw over.verify;
      return { data: over.verify ?? 'ok', error: null };
    }),
  };
}
const ctx = (c: unknown): PageContext => ({
  path: '/',
  navigate: () => {},
  client: c as never,
  orgId: 'o1',
  storeId: null,
  permissions: [],
  isOwner: false,
  isPlatformAdmin: false,
});
const mount = (c: ReturnType<typeof client>, onUnlock = vi.fn()) => {
  render(
    <I18nProvider initialLang="en">
      <LockScreen ctx={ctx(c)} binding={binding} onUnlock={onUnlock} />
    </I18nProvider>,
  );
  return onUnlock;
};
const enter = async (pin: string) => {
  for (const d of pin) await userEvent.click(screen.getByRole('button', { name: d }));
};

describe('<LockScreen>', () => {
  it("lists only this shop's active people who have a PIN", async () => {
    mount(client());
    await screen.findByText('Nok');
    expect(screen.getByText('Pim')).toBeTruthy(); // this shop
    expect(screen.queryByText('Far')).toBeNull(); // other shop (listed in the PIN list but works at s2)
    expect(screen.queryByText('NoPin')).toBeNull(); // no PIN
  });

  it('unlocks with the right PIN and hands over only known permissions plus the signed-in account id', async () => {
    const onUnlock = mount(client({ verify: 'ok' }));
    await userEvent.click(await screen.findByText('Nok'));
    await enter('4821');
    await userEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(onUnlock).toHaveBeenCalledTimes(1));
    expect(onUnlock.mock.calls[0]![0]).toMatchObject({
      staffId: 'nok',
      accountId: 'u1',
      roleBuiltIn: 'cashier',
      permissions: ['payment.take'],
    });
  });

  it('a wrong PIN shows a clear message, clears the field and does not unlock', async () => {
    const onUnlock = mount(client({ verify: 'wrong' }));
    await userEvent.click(await screen.findByText('Nok'));
    await enter('0000');
    await userEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(await screen.findByText('Wrong PIN.')).toBeTruthy();
    expect((screen.getByLabelText('PIN') as HTMLInputElement).value).toBe('');
    expect(onUnlock).not.toHaveBeenCalled();
    expect(document.querySelector('.spinner')).toBeNull();
  });

  it('the Start button needs at least 4 digits', async () => {
    mount(client());
    await userEvent.click(await screen.findByText('Nok'));
    await enter('12');
    expect((screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('shows the lockout message', async () => {
    mount(client({ verify: 'locked' }));
    await userEvent.click(await screen.findByText('Nok'));
    await enter('1234');
    await userEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(await screen.findByText(/Locked for 15 minutes/)).toBeTruthy();
  });

  it('nobody has a PIN yet → lets the account through (so the owner can set PINs)', async () => {
    const onUnlock = mount(client({ pinIds: [] }));
    await waitFor(() => expect(onUnlock).toHaveBeenCalledWith('open'));
  });

  it('a device switched off in the back office does not open', async () => {
    mount(client({ deviceActive: false }));
    expect(await screen.findByText(/switched off in the back office/)).toBeTruthy();
    expect(screen.queryByText('Nok')).toBeNull();
  });

  it('opens with no signal using the list saved last time', async () => {
    mount(client());
    await screen.findByText('Nok');
    cleanup();
    mount(client({ fail: true }));
    expect(await screen.findByText('Nok')).toBeTruthy();
  });

  it('with no list at all and no signal it says so instead of spinning forever', async () => {
    mount(client({ fail: true }));
    expect(await screen.findByText('Could not load the data.')).toBeTruthy();
  });
});
