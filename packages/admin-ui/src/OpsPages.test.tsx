import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageContext } from '@bestie/auth';
import { I18nProvider } from '@bestie/i18n';
import { AiBudgetPanel } from './AiBudgetPanel';
import { AiEvalPanel } from './AiEvalPanel';
import { DataExportPanel } from './DataExportPanel';
import { fakeDb } from './fakeDb';
import { TimeClockPage } from './TimeClockPage';
import { WaitlistPage } from './WaitlistPage';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mount = (
  ui: (ctx: PageContext) => React.ReactNode,
  tables: Record<string, unknown[]> = {},
  rpc: Record<string, { data?: unknown; error?: { code: string } | null }> = {},
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
    auth: { getSession: vi.fn(async () => ({ data: { session: { access_token: 'tok' } } })) },
  });
  const ctx = {
    path: '/x',
    navigate: vi.fn(),
    client: db.client as never,
    orgId: 'o1',
    storeId: 's1',
    permissions: ['report.view', 'staff.manage', 'order.create'],
    isOwner: true,
    isPlatformAdmin: false,
    staffId: 'st1',
    ...over,
  } as PageContext;
  render(<I18nProvider initialLang="en">{ui(ctx)}</I18nProvider>);
  return db;
};

describe('<WaitlistPage>', () => {
  const tables = {
    waitlist_entries: [
      {
        id: 'w1',
        name: 'Anna',
        phone: '0833333333',
        party: 2,
        status: 'waiting',
        quoted_min: 25,
        created_at: new Date(Date.now() - 12 * 60_000).toISOString(),
      },
    ],
    dining_tables: [{ id: 't1', name: 'T1', seats: 4 }],
  };
  it('shows who waits, for how long against the quote, and the table report', async () => {
    mount((ctx) => <WaitlistPage ctx={ctx} />, tables, {
      table_turnover: {
        data: [
          {
            table_id: 't1',
            name: 'T1',
            seats: 4,
            bills: 3,
            avg_min: 52,
            revenue: 90000,
            per_hour: 34615,
          },
        ],
      },
    });
    expect(await screen.findByText('Anna')).toBeTruthy();
    expect(screen.getByText(/waited 1[12] min \(quoted 25\)/)).toBeTruthy();
    expect(await screen.findByText('3 bills')).toBeTruthy();
    expect(screen.getByText('52 min')).toBeTruthy();
  });
  it('adds a party with a request id and reports the quoted wait', async () => {
    const db = mount((ctx) => <WaitlistPage ctx={ctx} />, tables, {
      waitlist_add: { data: { id: 'w2', quoted_min: 40 } },
    });
    await screen.findByText('Anna');
    await userEvent.type(screen.getByLabelText('Name'), 'Ben');
    await userEvent.click(screen.getByRole('button', { name: 'Add to the list' }));
    expect(await screen.findByText('Added. Estimated wait about 40 minutes')).toBeTruthy();
    const a = db.rpcs.find((r) => r.fn === 'waitlist_add')!.args as {
      p: { name: string; party: number; client_id: string };
    };
    expect(a.p).toMatchObject({ name: 'Ben', party: 2 });
    expect(a.p.client_id).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('seats a party at a chosen table and refuses an empty name', async () => {
    const db = mount((ctx) => <WaitlistPage ctx={ctx} />, tables);
    await screen.findByText('Anna');
    await userEvent.click(screen.getByRole('button', { name: 'Add to the list' }));
    expect(await screen.findByText('Enter a name and the number of people')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Seat' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm seat' }));
    await waitFor(() => expect(db.rpcs.some((r) => r.fn === 'waitlist_set')).toBe(true));
    expect(db.rpcs.find((r) => r.fn === 'waitlist_set')!.args).toEqual({
      p_id: 'w1',
      p_status: 'seated',
      p_table: 't1',
    });
  });
});

describe('<TimeClockPage>', () => {
  const tables = {
    staff: [
      { id: 'st1', display_name: 'Pim' },
      { id: 'st2', display_name: 'Noi' },
    ],
    staff_schedule: [],
  };
  it('shows my state, who is in, and the timesheet for a manager', async () => {
    mount((ctx) => <TimeClockPage ctx={ctx} />, tables, {
      time_status: { data: [{ staff_id: 'st1', name: 'Pim', since: '2026-11-22T02:00:00Z' }] },
      timesheet: {
        data: [{ staff_id: 'st2', name: 'Noi', worked_min: 485, days: 2, planned_min: 540 }],
      },
    });
    expect(await screen.findByText('You are clocked in')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clock out' })).toBeTruthy();
    expect(await screen.findByText('worked 8:05 h')).toBeTruthy();
    expect(screen.getByText('planned 9:00 h')).toBeTruthy();
  });
  it('clocks me in when I am out, and says when the module is off', async () => {
    const db = mount((ctx) => <TimeClockPage ctx={ctx} />, tables, {
      time_status: { data: [] },
      clock_toggle: { data: { state: 'in' } },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Clock in' }));
    expect(await screen.findByText('Clocked in')).toBeTruthy();
    expect(db.rpcs.find((r) => r.fn === 'clock_toggle')!.args).toEqual({
      p: { store_id: 's1', staff_id: 'st1' },
    });
    cleanup();
    mount((ctx) => <TimeClockPage ctx={ctx} />, tables, {
      time_status: { data: [] },
      clock_toggle: { error: { code: '0A000' } },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Clock in' }));
    expect(await screen.findByText('The time clock module is off in this shop')).toBeTruthy();
  });
  it('a plain member sees no timesheet or schedule', async () => {
    mount(
      (ctx) => <TimeClockPage ctx={ctx} />,
      tables,
      { time_status: { data: [] } },
      { isOwner: false, permissions: ['order.create'] },
    );
    await screen.findByText('Nobody is clocked in');
    expect(screen.queryByText('Timesheet')).toBeNull();
    expect(screen.queryByText('Planned shifts')).toBeNull();
  });
});

describe('<DataExportPanel>', () => {
  it('asks for the chosen dataset and for all of them in a backup', async () => {
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:x'),
      revokeObjectURL: vi.fn(),
    });
    const db = mount(
      (ctx) => <DataExportPanel ctx={ctx} />,
      {},
      { export_data: { data: [{ name: 'Noi' }] } },
    );
    await userEvent.selectOptions(screen.getByLabelText('Data'), 'points');
    await userEvent.click(screen.getByRole('button', { name: 'Download CSV' }));
    expect(await screen.findByText('Downloaded 1 rows')).toBeTruthy();
    expect(db.rpcs[0]!.args).toEqual({ p: { org_id: 'o1', dataset: 'points' } });
    await userEvent.click(screen.getByRole('button', { name: 'Back up everything (JSON)' }));
    expect(await screen.findByText('Everything was backed up')).toBeTruthy();
    expect(db.rpcs.map((r) => (r.args as { p: { dataset: string } }).p.dataset).slice(1)).toEqual([
      'customers',
      'menu',
      'orders',
      'stock',
      'staff',
      'points',
    ]);
  });
  it('says so when the server refuses', async () => {
    mount(
      (ctx) => <DataExportPanel ctx={ctx} />,
      {},
      { export_data: { error: { code: '42501' } } },
    );
    await userEvent.click(screen.getByRole('button', { name: 'Download CSV' }));
    expect(await screen.findByText('The download failed')).toBeTruthy();
  });
});

describe('<AiBudgetPanel>', () => {
  it('shows the cap, saves a new one in satang and can remove it', async () => {
    const db = mount((ctx) => <AiBudgetPanel ctx={ctx} orgId="o1" />, {
      ai_budgets: [{ monthly_cap: 50000 }],
    });
    expect(await screen.findByText(/500/)).toBeTruthy();
    await userEvent.type(screen.getByLabelText(/Monthly cap/), '800');
    await userEvent.click(screen.getByRole('button', { name: 'Save the cap' }));
    await waitFor(() => expect(db.rpcs.some((r) => r.fn === 'set_ai_budget')).toBe(true));
    expect(db.rpcs.find((r) => r.fn === 'set_ai_budget')!.args).toEqual({
      p_org: 'o1',
      p_cap: 80000,
    });
    await userEvent.click(screen.getByRole('button', { name: 'Remove the cap' }));
    await waitFor(() => expect(db.rpcs.filter((r) => r.fn === 'set_ai_budget')).toHaveLength(2));
    expect(db.rpcs.filter((r) => r.fn === 'set_ai_budget')[1]!.args).toEqual({
      p_org: 'o1',
      p_cap: null,
    });
  });
  it('is hidden from people who cannot set it', () => {
    mount((ctx) => <AiBudgetPanel ctx={ctx} orgId="o1" />, {}, {}, { isOwner: false });
    expect(screen.queryByText('Monthly AI budget')).toBeNull();
  });
});

describe('<AiEvalPanel>', () => {
  it('runs the evaluation and lists what passed and failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          results: [
            {
              id: 'a',
              task: 'concierge',
              about: 'Wifi question',
              ok: true,
              reason: null,
              ms: 10,
              tokens: 5,
            },
            {
              id: 'b',
              task: 'summary',
              about: 'No invented numbers',
              ok: false,
              reason: 'numbers not in the figures: 99',
              ms: 10,
              tokens: 5,
            },
          ],
          summary: [
            { task: 'concierge', passed: 1, total: 1 },
            { task: 'summary', passed: 0, total: 1 },
          ],
        }),
      ),
    );
    mount((ctx) => <AiEvalPanel ctx={ctx} />);
    await userEvent.click(screen.getByRole('button', { name: 'Run the evaluation' }));
    expect(await screen.findByText('Passed 1 of 2')).toBeTruthy();
    expect(screen.getByText(/numbers not in the figures: 99/)).toBeTruthy();
    expect(screen.getByText('Fail')).toBeTruthy();
  });
});

describe('routes of the role-home cards', () => {
  it.each(['/ai', '/dashboard', '/points', '/credit'])(
    '%s opens a real page for an owner who is not a platform administrator',
    async (path) => {
      const { adminPages } = await import('./index');
      const db = fakeDb({});
      const ctx = {
        path,
        navigate: vi.fn(),
        client: db.client as never,
        orgId: 'o1',
        storeId: 's1',
        permissions: [],
        isOwner: true,
        isPlatformAdmin: false,
      } as unknown as PageContext;
      expect(adminPages(ctx)).not.toBeNull();
    },
  );
});
