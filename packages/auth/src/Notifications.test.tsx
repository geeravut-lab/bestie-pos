import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '@bestie/i18n';
import { AuthProvider } from './context';
import { NotificationBell, NotificationsPage } from './Notifications';

afterEach(cleanup);

type Row = {
  id: string;
  kind: string;
  title: string;
  body: string;
  href: string | null;
  read_at: string | null;
  created_at: string;
};
const row = (id: string, over: Partial<Row> = {}): Row => ({
  id,
  kind: 'payment.paid',
  title: `Payment ${id}`,
  body: 'Bill: A001',
  href: '/receipt/x',
  read_at: null,
  created_at: '2026-11-18T05:00:00Z',
  ...over,
});

/** A tiny fake of the PostgREST builder: enough for count / list / update / delete / prefs. */
function fakeClient(
  rows: Row[],
  prefs: { line_transactional: boolean; line_reminders: boolean } | null = null,
) {
  const log: string[] = [];
  const unread = () => rows.filter((r) => !r.read_at).length;
  const from = (table: string) => {
    if (table === 'notification_prefs')
      return {
        select: () => ({ maybeSingle: async () => ({ data: prefs, error: null }) }),
        upsert: async (v: Record<string, unknown>) => {
          log.push(`prefs:${JSON.stringify(v)}`);
          return { error: null };
        },
      };
    return {
      select: (_cols: string, opts?: { head?: boolean }) =>
        opts?.head
          ? { is: async () => ({ count: unread(), error: null }) }
          : { order: () => ({ limit: async () => ({ data: [...rows], error: null }) }) },
      update: (v: { read_at: string }) => ({
        eq: async (_c: string, id: string) => {
          log.push(`read:${id}`);
          rows.find((r) => r.id === id)!.read_at = v.read_at;
          return { error: null };
        },
        is: async () => {
          log.push('read:all');
          for (const r of rows) r.read_at ??= v.read_at;
          return { error: null };
        },
      }),
      delete: () => ({
        eq: async (_c: string, id: string) => {
          log.push(`del:${id}`);
          rows.splice(
            rows.findIndex((r) => r.id === id),
            1,
          );
          return { error: null };
        },
      }),
    };
  };
  const client = {
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'jwt', user: { id: 'u1' } } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    from,
    rpc: async () => ({ data: false }),
    channel: () => ({
      on() {
        return this;
      },
      subscribe() {
        return this;
      },
    }),
    removeChannel: async () => 'ok',
  } as never;
  return { client, log };
}

const mount = (client: never, ui: React.ReactNode) =>
  render(
    <I18nProvider initialLang="en">
      <AuthProvider client={client}>{ui}</AuthProvider>
    </I18nProvider>,
  );

describe('<NotificationBell>', () => {
  it('links to the inbox and says how many are unread', async () => {
    const { client } = fakeClient([
      row('a'),
      row('b'),
      row('c', { read_at: '2026-11-18T06:00:00Z' }),
    ]);
    mount(client, <NotificationBell />);
    const link = await screen.findByRole('link', { name: 'Notifications, 2 unread' });
    expect(link.getAttribute('href')).toBe('/notifications');
  });
  it('plain label when nothing is unread', async () => {
    const { client } = fakeClient([row('c', { read_at: '2026-11-18T06:00:00Z' })]);
    mount(client, <NotificationBell />);
    expect(await screen.findByRole('link', { name: 'Notifications' })).toBeTruthy();
  });
});

describe('<NotificationsPage>', () => {
  it('lists the notices, newest first, with an open link, and the empty state', async () => {
    const { client } = fakeClient([row('a')]);
    mount(client, <NotificationsPage />);
    expect(await screen.findByText('Payment a')).toBeTruthy();
    expect(screen.getByText('Bill: A001')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open' }).getAttribute('href')).toBe('/receipt/x');
    cleanup();
    const empty = fakeClient([]);
    mount(empty.client, <NotificationsPage />);
    expect(await screen.findByText('No notifications yet')).toBeTruthy();
  });

  it('mark one read, mark all read, delete — each through the database', async () => {
    const { client, log } = fakeClient([row('a'), row('b')]);
    mount(client, <NotificationsPage />);
    await screen.findByText('Payment a');
    await userEvent.click(screen.getAllByRole('button', { name: 'Mark as read' })[0]!);
    await waitFor(() => expect(log).toContain('read:a'));
    await userEvent.click(await screen.findByRole('button', { name: 'Mark all as read' }));
    await waitFor(() => expect(log).toContain('read:all'));
    await userEvent.click((await screen.findAllByRole('button', { name: 'Delete' }))[0]!);
    await waitFor(() => expect(log.some((l) => l.startsWith('del:'))).toBe(true));
    expect(screen.queryByRole('button', { name: 'Mark all as read' })).toBeNull();
  });

  it('LINE preferences: transactional on, reminders off by default; changing one saves both flags for this person', async () => {
    const { client, log } = fakeClient([]);
    mount(client, <NotificationsPage />);
    const [tx, rem] = (await screen.findAllByRole('checkbox')) as HTMLInputElement[];
    expect(tx!.checked).toBe(true);
    expect(rem!.checked).toBe(false);
    await userEvent.click(rem!);
    await waitFor(() => expect(log.some((l) => l.startsWith('prefs:'))).toBe(true));
    const saved = JSON.parse(log.find((l) => l.startsWith('prefs:'))!.slice(6));
    expect(saved).toMatchObject({ user_id: 'u1', line_transactional: true, line_reminders: true });
    expect(await screen.findByText('Saved')).toBeTruthy();
  });
});
