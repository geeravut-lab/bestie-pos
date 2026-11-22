import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageContext } from '@bestie/auth';
import { I18nProvider } from '@bestie/i18n';
import { fakeDb } from './fakeDb';
import { KpiPage } from './KpiPage';
import { MenuImportPage } from './MenuImportPage';
import { MenuProfitPage } from './MenuProfitPage';
import { PromotionsPage } from './PromotionsPage';
import { UpsellPage } from './UpsellPage';

afterEach(cleanup);

const mount = (
  ui: (ctx: PageContext) => React.ReactNode,
  tables: Record<string, unknown[]> = {},
  rpc: Record<string, { data?: unknown; error?: { code: string } | null }> = {},
  perms = ['report.view', 'menu.edit'],
  owner = true,
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
    navigate: () => {},
    client: db.client as never,
    orgId: 'o1',
    storeId: 's1',
    permissions: perms,
    isOwner: owner,
    isPlatformAdmin: false,
  } as PageContext;
  render(<I18nProvider initialLang="en">{ui(ctx)}</I18nProvider>);
  return db;
};

describe('<MenuProfitPage>', () => {
  it('sorts dishes into the four groups and says what each means', async () => {
    mount(
      (ctx) => <MenuProfitPage ctx={ctx} />,
      {},
      {
        menu_profit_report: {
          data: [
            {
              item_id: 'a',
              name: { th: 'ก', en: 'Star dish' },
              qty: 50,
              revenue: 500000,
              cost_unit: 4000,
            },
            {
              item_id: 'b',
              name: { th: 'ข', en: 'Cheap dish' },
              qty: 40,
              revenue: 200000,
              cost_unit: 4500,
            },
            {
              item_id: 'c',
              name: { th: 'ค', en: 'Plain dish' },
              qty: 3,
              revenue: 30000,
              cost_unit: null,
            },
          ],
        },
      },
    );
    const row = (await screen.findByText('Star dish')).closest('tr')!;
    expect(within(row).getByText('Star')).toBeTruthy();
    expect(
      within(screen.getByText('Cheap dish').closest('tr')!).getByText('Plowhorse'),
    ).toBeTruthy();
    const none = screen.getByText('Plain dish').closest('tr')!;
    expect(within(none).getByText('Unknown')).toBeTruthy();
    expect(screen.getByText(/Sells well and earns well/)).toBeTruthy();
  });
  it('needs the report permission', () => {
    mount((ctx) => <MenuProfitPage ctx={ctx} />, {}, {}, ['menu.edit'], false);
    expect(screen.getByText('This page needs permission to see reports.')).toBeTruthy();
  });
});

describe('<KpiPage>', () => {
  it('shows each figure with the period before, and a dash where nothing could be measured', async () => {
    mount(
      (ctx) => <KpiPage ctx={ctx} />,
      {},
      {
        kpi_report: {
          data: {
            bills: 10,
            sales: 250000,
            order_to_kitchen_sec: 95,
            prep_sec: null,
            waste_cost: 5000,
            stockouts: 2,
            noshow_rate_bps: null,
            repeat_rate_bps: 2500,
            feedback_resolution_sec: null,
          },
        },
      },
    );
    expect(await screen.findByText('Time from opening a bill to the kitchen')).toBeTruthy();
    expect(screen.getAllByText('1 min 35 s').length).toBeGreaterThan(0);
    expect(screen.getAllByText('25%').length).toBeGreaterThan(0);
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });
});

describe('<MenuImportPage>', () => {
  it('checks a pasted table and sends only the usable rows', async () => {
    const db = mount(
      (ctx) => <MenuImportPage ctx={ctx} />,
      {},
      { import_menu: { data: { items: 2, categories: 1, skipped: [] } } },
    );
    await userEvent.click(screen.getByLabelText('or paste the data here'));
    await userEvent.paste(
      'Category,Name,Price\nDrinks,Tea,35\nDrinks,,10\nFood,Rice,abc\nFood,Soup,60',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Check the file' }));
    expect(await screen.findByText('2 items can be imported')).toBeTruthy();
    expect(screen.getByText('2 rows were skipped (missing name or bad price)')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Import 2 items' }));
    await waitFor(() => expect(db.rpcs.some((c) => c.fn === 'import_menu')).toBe(true));
    const sent = db.rpcs.find((c) => c.fn === 'import_menu')!.args as {
      p: { rows: { name_th: string; price: number }[] };
    };
    expect(sent.p.rows.map((r) => [r.name_th, r.price])).toEqual([
      ['Tea', 3500],
      ['Soup', 6000],
    ]);
    expect(await screen.findByText(/Imported 2 items, 1 new categories/)).toBeTruthy();
  });
  it('says so when the columns are missing', async () => {
    mount((ctx) => <MenuImportPage ctx={ctx} />);
    await userEvent.click(screen.getByLabelText('or paste the data here'));
    await userEvent.paste('foo,bar\n1,2');
    await userEvent.click(screen.getByRole('button', { name: 'Check the file' }));
    expect(await screen.findByText(/No name and price columns found/)).toBeTruthy();
  });
});

describe('<PromotionsPage>', () => {
  it('lists promotions, warns when the margin guard switched one off, and lets the owner force it', async () => {
    const save = vi.fn();
    const db = mount(
      (ctx) => <PromotionsPage ctx={ctx} />,
      {
        promotions: [
          {
            id: 'p1',
            name: 'Happy hour',
            code: 'HAPPY',
            kind: 'percent',
            value: 2000,
            scope: 'bill',
            item_ids: [],
            min_subtotal: 0,
            channels: [],
            weekdays: [1, 2],
            from_time: '15:00:00',
            to_time: '17:00:00',
            active: true,
          },
        ],
        menu_items: [{ id: 'i1', name: { th: 'ผัด', en: 'Pad Thai' } }],
      },
      {
        save_promotion: { data: { id: 'p2', active: false, below_margin: ['Pad Thai'] } },
        promotions_report: {
          data: [{ promo_id: 'p1', name: 'Happy hour', bills: 4, given: 12000 }],
        },
      },
    );
    void save;
    expect((await screen.findAllByText('Happy hour', { selector: 'strong' })).length).toBe(2);
    expect(screen.getByText('HAPPY')).toBeTruthy();
    expect(await screen.findByText(/Gave ฿120 on 4 bills/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Add a promotion' }));
    await userEvent.type(screen.getByLabelText('Promotion name'), 'Half price');
    const v = screen.getByLabelText('Discount value');
    await userEvent.clear(v);
    await userEvent.type(v, '60');
    await userEvent.click(screen.getByRole('button', { name: 'Save the promotion' }));
    expect(await screen.findByText(/sells below cost for: Pad Thai/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Save and switch on even though/ }));
    await waitFor(() => expect(db.rpcs.filter((c) => c.fn === 'save_promotion').length).toBe(2));
    const calls = db.rpcs
      .filter((c) => c.fn === 'save_promotion')
      .map((c) => (c.args as { p: { value: number; force: boolean; kind: string } }).p);
    expect(calls[0]).toMatchObject({ value: 6000, kind: 'percent', force: false });
    expect(calls[1]).toMatchObject({ force: true });
  });
  it('a database refusal of a code already used is explained', async () => {
    mount(
      (ctx) => <PromotionsPage ctx={ctx} />,
      {},
      { save_promotion: { error: { code: '23505' } } },
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Add a promotion' }));
    await userEvent.type(screen.getByLabelText('Promotion name'), 'X');
    await userEvent.click(screen.getByRole('button', { name: 'Save the promotion' }));
    expect(await screen.findByText('This code is already used in this shop.')).toBeTruthy();
  });
});

describe('<UpsellPage>', () => {
  const tables = {
    upsell_rules: [{ id: 'r1', item_id: 'a', suggest_id: 'b', sort: 0, active: true }],
    menu_items: [
      { id: 'a', name: { th: 'ผัดไทย', en: 'Pad Thai' } },
      { id: 'b', name: { th: 'ชา', en: 'Tea' } },
    ],
  };
  it('lists the rules by dish name and adds a new one', async () => {
    const db = mount((ctx) => <UpsellPage ctx={ctx} />, tables, {
      save_upsell_rule: { data: 'r2' },
    });
    expect(await screen.findByText('Pad Thai', { selector: 'strong' })).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText('When the bill has'), 'b');
    await userEvent.selectOptions(screen.getByLabelText('Offer'), 'a');
    await userEvent.click(screen.getByRole('button', { name: 'Add the rule' }));
    await waitFor(() => expect(db.rpcs.some((c) => c.fn === 'save_upsell_rule')).toBe(true));
    expect(db.rpcs.find((c) => c.fn === 'save_upsell_rule')!.args).toEqual({
      p: { store_id: 's1', item_id: 'b', suggest_id: 'a' },
    });
  });
  it('refuses the same dish twice and shows pairs from history with a button to use them', async () => {
    const db = mount((ctx) => <UpsellPage ctx={ctx} />, tables, {
      pair_stats: {
        data: [
          {
            a: 'a',
            b: 'b',
            a_name: { th: 'ผัดไทย', en: 'Pad Thai' },
            b_name: { th: 'ชา', en: 'Tea' },
            together: 6,
            a_count: 20,
          },
        ],
      },
      save_upsell_rule: { data: 'r3' },
    });
    await screen.findByText('Pad Thai', { selector: 'strong' });
    await userEvent.click(screen.getByRole('button', { name: 'Add the rule' }));
    expect(await screen.findByText('Pick two different dishes.')).toBeTruthy();
    await userEvent.click(
      screen.getByRole('button', { name: /Show pairs customers often order together/ }),
    );
    expect(
      await screen.findByText(/Ordered together 6 times \(30% of the bills with Pad Thai\)/),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Use as a rule' }));
    await waitFor(() => expect(db.rpcs.some((c) => c.fn === 'save_upsell_rule')).toBe(true));
  });
});
