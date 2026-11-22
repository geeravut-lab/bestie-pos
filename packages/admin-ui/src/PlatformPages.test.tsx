import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageContext } from '@bestie/auth';
import { I18nProvider } from '@bestie/i18n';
import { AnalyticsPage } from './AnalyticsPage';
import { fakeDb } from './fakeDb';
import { FlagsPage } from './FlagsPage';

afterEach(cleanup);

const mount = (
  ui: (ctx: PageContext) => React.ReactNode,
  tables: Record<string, unknown[]>,
  rpc: Record<string, { data?: unknown; error?: { code: string } | null }>,
  over: Partial<PageContext> = {},
) => {
  const db = fakeDb(tables, { rpc });
  Object.assign(db.client as object, {
    channel: vi.fn(() => {
      const ch: Record<string, unknown> = {};
      ch.on = () => ch;
      ch.subscribe = (cb?: (s: string) => void) => {
        cb?.('SUBSCRIBED');
        return ch;
      };
      return ch;
    }),
    removeChannel: vi.fn(async () => 'ok'),
  });
  const ctx = {
    path: '/x',
    navigate: vi.fn(),
    client: db.client as never,
    orgId: 'o1',
    storeId: 's1',
    permissions: [],
    isOwner: true,
    isPlatformAdmin: true,
    ...over,
  } as PageContext;
  render(<I18nProvider initialLang="en">{ui(ctx)}</I18nProvider>);
  return db;
};

describe('<FlagsPage>', () => {
  const rpc = {
    platform_flags_overview: {
      data: {
        shops: 9,
        modules: [
          {
            module_id: 'kiosk',
            on_count: 2,
            off_count: 1,
            killed: true,
            reason: 'bug found',
            changed_at: '2026-11-22T03:00:00Z',
          },
        ],
        killed: [
          {
            module_id: 'kiosk',
            reason: 'bug found',
            changed_at: '2026-11-22T03:00:00Z',
            db_enforced: true,
          },
        ],
      },
    },
  };
  it('is for the platform administrator only', async () => {
    const db = mount((ctx) => <FlagsPage ctx={ctx} />, {}, rpc, { isPlatformAdmin: false });
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(db.rpcs).toHaveLength(0);
  });
  it('shows what is off platform-wide, with the reason, and can switch it back on', async () => {
    const db = mount(
      (ctx) => <FlagsPage ctx={ctx} />,
      { platform_flag_enforced: [{ module_id: 'kiosk' }] },
      rpc,
    );
    expect(
      await screen.findByText('1 module(s) are switched off platform-wide right now'),
    ).toBeTruthy();
    const card = screen.getByText('kiosk').closest('li')!;
    expect(within(card).getByText(/bug found/)).toBeTruthy();
    expect(within(card).getByText('2 shops switched it on · 1 shops switched it off')).toBeTruthy();
    expect(within(card).queryByText(/no database check yet/)).toBeNull();
    await userEvent.click(within(card).getByRole('button', { name: 'Switch back on' }));
    await waitFor(() => expect(db.rpcs.some((r) => r.fn === 'set_platform_flag')).toBe(true));
    expect(db.rpcs.find((r) => r.fn === 'set_platform_flag')!.args).toEqual({
      p: { module_id: 'kiosk', enabled: true, reason: null },
    });
  });
  it('switches a module off with a reason and warns when the database does not check it', async () => {
    const db = mount(
      (ctx) => <FlagsPage ctx={ctx} />,
      { platform_flag_enforced: [] },
      {
        platform_flags_overview: {
          data: {
            shops: 3,
            modules: [],
            killed: [{ module_id: 'stock', reason: null, changed_at: '2026-11-22T03:00:00Z' }],
          },
        },
      },
    );
    expect(await screen.findByText(/no database check yet/)).toBeTruthy();
    const card = screen.getByText('marketing').closest('li')!;
    await userEvent.type(within(card).getByPlaceholderText('Reason (optional)'), 'provider down');
    await userEvent.click(
      within(card).getByRole('button', { name: 'Switch off for every business' }),
    );
    await waitFor(() => expect(db.rpcs.some((r) => r.fn === 'set_platform_flag')).toBe(true));
    expect(db.rpcs.find((r) => r.fn === 'set_platform_flag')!.args).toEqual({
      p: { module_id: 'marketing', enabled: false, reason: 'provider down' },
    });
    expect(await screen.findByText('The module is off for every business')).toBeTruthy();
  });
});

describe('<AnalyticsPage>', () => {
  const data = {
    dau: 3,
    wau: 8,
    mau: 21,
    accounts: 40,
    businesses: 5,
    shops: 9,
    new_businesses_30d: 2,
    paid_bills_30d: 480,
    paid_bills_prev_30d: 400,
    retention_d7: 42,
    series: [
      { day: '2026-11-21', users: 2 },
      { day: '2026-11-22', users: 3 },
    ],
    top_pages: [
      { page: 'reports', users: 7 },
      { page: 'stock_insights', users: 2 },
    ],
  };
  it('shows active people, retention, the top screens and growth', async () => {
    mount((ctx) => <AnalyticsPage ctx={ctx} />, {}, { admin_analytics: { data } });
    expect(await screen.findByText('21')).toBeTruthy();
    expect(screen.getByText('42%')).toBeTruthy();
    expect(screen.getByText('7 people')).toBeTruthy();
    expect(screen.getAllByText('stock_insights').length).toBeGreaterThan(0);
    expect(screen.getByText(/the 30 days before: 400/)).toBeTruthy();
  });
  it('says "not enough data" when retention is unknown and asks for the chosen range', async () => {
    const db = mount(
      (ctx) => <AnalyticsPage ctx={ctx} />,
      {},
      { admin_analytics: { data: { ...data, retention_d7: null } } },
    );
    expect(await screen.findByText('not enough data yet')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '90 days' }));
    await waitFor(() =>
      expect(db.rpcs.some((r) => (r.args as { p_days: number }).p_days === 90)).toBe(true),
    );
  });
  it('asks nothing of a person who is not the platform administrator', async () => {
    const db = mount(
      (ctx) => <AnalyticsPage ctx={ctx} />,
      {},
      { admin_analytics: { data } },
      { isPlatformAdmin: false },
    );
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(db.rpcs).toHaveLength(0);
  });
});
