import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '@bestie/i18n';
import type { PageContext } from '@bestie/auth';
import { LineSettingsPage } from './LineSettingsPage';
import { fakeDb } from './fakeDb';

afterEach(cleanup);

const usage = (over: Record<string, unknown> = {}) => ({
  cap: 200,
  reserve: 20,
  halted_until: null,
  halted_reason: null,
  sent_month: 50,
  queued: 3,
  failed_month: 1,
  ...over,
});
const ctx = (client: unknown, admin = true): PageContext => ({
  path: '/admin/line',
  navigate: () => {},
  client: {
    ...(client as object),
    channel: () => ({
      on() {
        return this;
      },
      subscribe() {
        return this;
      },
    }),
    removeChannel: async () => 'ok',
  } as never,
  orgId: 'o1',
  storeId: null,
  permissions: [],
  isOwner: false,
  isPlatformAdmin: admin,
});
const mount = (c: PageContext) =>
  render(
    <I18nProvider initialLang="en">
      <LineSettingsPage ctx={c} />
    </I18nProvider>,
  );
const withUsage = (u = usage()) =>
  fakeDb({ notification_settings: [{ id: true }] }, { rpc: { notify_usage: { data: u } } });

describe('<LineSettingsPage>', () => {
  it('shows this month’s use against the cap', async () => {
    mount(ctx(withUsage().client));
    await screen.findByRole('heading', { name: 'LINE sending cap' });
    expect(screen.getByText('50 / 200')).toBeTruthy();
    expect(screen.getByText('3 waiting to be sent · 1 failed this month')).toBeTruthy();
    expect((screen.getByLabelText('Monthly cap (messages)') as HTMLInputElement).value).toBe('200');
  });

  it('saves a new cap and reserve', async () => {
    const db = withUsage();
    mount(ctx(db.client));
    await screen.findByRole('heading', { name: 'LINE sending cap' });
    fireEvent.change(screen.getByLabelText('Monthly cap (messages)'), {
      target: { value: '1000' },
    });
    fireEvent.change(screen.getByLabelText('Reserve for urgent messages'), {
      target: { value: '100' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(db.writes).toHaveLength(1));
    expect(db.writes[0]).toMatchObject({
      table: 'notification_settings',
      values: { line_monthly_cap: 1000, line_reserve: 100 },
    });
  });

  it('refuses a reserve above the cap, a non-number, and cannot save', async () => {
    const db = withUsage();
    mount(ctx(db.client));
    await screen.findByRole('heading', { name: 'LINE sending cap' });
    fireEvent.change(screen.getByLabelText('Reserve for urgent messages'), {
      target: { value: '500' },
    });
    expect(screen.getByText(/reserve may not be larger/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Monthly cap (messages)'), {
      target: { value: 'lots' },
    });
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    expect(db.writes).toHaveLength(0);
  });

  it('a halt can be lifted by hand', async () => {
    const db = withUsage(
      usage({
        halted_until: new Date(Date.now() + 3600_000).toISOString(),
        halted_reason: 'LINE rejected the access token',
      }),
    );
    mount(ctx(db.client));
    expect(await screen.findByText(/Delivery is paused until/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Resume now' }));
    await waitFor(() => expect(db.writes).toHaveLength(1));
    expect(db.writes[0]).toMatchObject({ values: { halted_until: null, halted_reason: null } });
  });

  it('is for the platform admin only', async () => {
    mount(ctx(withUsage().client, false));
    expect(await screen.findByText(/platform administrator only/)).toBeTruthy();
  });
});
