import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@bestie/i18n';
import type { PageContext } from '@bestie/auth';
import { RolesPage } from './RolesPage';

afterEach(cleanup);
const ROLES = [
  { id: 'r1', name: 'Owner', built_in: 'owner', permissions: [] },
  { id: 'r2', name: 'Cashier', built_in: 'cashier', permissions: ['order.create', 'drawer.open'] },
  { id: 'r3', name: 'Runner', built_in: null, permissions: ['order.create'] },
];
function client(over: { writeError?: { code: string } } = {}) {
  const writes: { op: string; values?: unknown; id?: string }[] = [];
  const from = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq']) chain[m] = () => chain;
    chain.order = async () => ({ data: ROLES, error: null });
    chain.insert = async (values: unknown) => {
      writes.push({ op: 'insert', values });
      return { error: over.writeError ?? null };
    };
    chain.update = (values: unknown) => ({
      eq: (_c: string, id: string) => ({
        select: async () => {
          writes.push({ op: 'update', values, id });
          return { data: over.writeError ? null : [{ id }], error: over.writeError ?? null };
        },
      }),
    });
    chain.delete = () => ({
      eq: async (_c: string, id: string) => {
        writes.push({ op: 'delete', id });
        return { error: over.writeError ?? null };
      },
    });
    return chain;
  };
  return { writes, client: { from } };
}
const ctx = (c: unknown, over: Partial<PageContext> = {}): PageContext => ({
  path: '/staff/roles',
  navigate: vi.fn(),
  client: c as never,
  orgId: 'o1',
  storeId: 's1',
  permissions: ['staff.manage', 'order.create', 'payment.take'],
  isOwner: false,
  isPlatformAdmin: false,
  ...over,
});
const mount = (c: PageContext) =>
  render(
    <I18nProvider initialLang="en">
      <RolesPage ctx={c} />
    </I18nProvider>,
  );

describe('<RolesPage>', () => {
  it('lists built-in roles (no edit) and the shop’s own roles (edit / delete)', async () => {
    const c = client();
    mount(ctx(c.client));
    expect(await screen.findByText('Runner')).toBeTruthy();
    expect(screen.getAllByText('Built-in')).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(1);
    expect(screen.getByText('Every permission')).toBeTruthy();
  });

  it('a manager can only tick permissions they hold; the new role is saved with exactly those', async () => {
    const c = client();
    mount(ctx(c.client));
    await userEvent.click(await screen.findByRole('button', { name: 'Create a role' }));
    expect(
      (screen.getByRole('checkbox', { name: 'Adjust Credit / Points' }) as HTMLInputElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('checkbox', { name: 'Take payment' }) as HTMLInputElement).disabled,
    ).toBe(false);
    await userEvent.type(screen.getByLabelText('Role name'), 'Runner 2');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Take payment' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save role' }));
    await waitFor(() => expect(c.writes).toHaveLength(1));
    expect(c.writes[0]).toEqual({
      op: 'insert',
      values: { org_id: 'o1', name: 'Runner 2', permissions: ['payment.take'] },
    });
  });

  it('the owner may tick everything, including the new drawer permission', async () => {
    const c = client();
    mount(ctx(c.client, { isOwner: true, permissions: [] }));
    await userEvent.click(await screen.findByRole('button', { name: 'Create a role' }));
    const box = screen.getByRole('checkbox', {
      name: 'Open the cash drawer (no sale)',
    }) as HTMLInputElement;
    expect(box.disabled).toBe(false);
  });

  it('edits and deletes a custom role; a database refusal is shown', async () => {
    const c = client();
    mount(ctx(c.client));
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Take payment' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save role' }));
    await waitFor(() => expect(c.writes[0]).toMatchObject({ op: 'update', id: 'r3' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await userEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
    );
    await waitFor(() => expect(c.writes[1]).toEqual({ op: 'delete', id: 'r3' }));
    cleanup();
    const bad = client({ writeError: { code: '23503' } });
    mount(ctx(bad.client));
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await userEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
    );
    expect(await screen.findByText(/someone still has this role/)).toBeTruthy();
  });

  it('is closed without staff.manage', () => {
    mount(ctx(client().client, { permissions: [] }));
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});
