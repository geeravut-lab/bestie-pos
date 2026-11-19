import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '@bestie/i18n';
import type { PageContext } from '@bestie/auth';
import { StockPage } from './StockPage';
import { fakeDb } from './fakeDb';

afterEach(cleanup);
const tables = () => ({
  stock_items: [
    {
      id: 'i1',
      name: { th: 'เส้นจันท์', en: 'Rice noodles' },
      unit: 'g',
      quantity: 4200,
      cost_per_1000: 4000,
      low_at: 1000,
      active: true,
    },
    {
      id: 'i2',
      name: { th: 'ไข่', en: 'Egg' },
      unit: 'pcs',
      quantity: 8,
      cost_per_1000: 500000,
      low_at: 10,
      active: true,
    },
    {
      id: 'i3',
      name: { th: 'น้ำมัน', en: 'Oil' },
      unit: 'ml',
      quantity: -300,
      cost_per_1000: 6000,
      low_at: 0,
      active: true,
    },
  ],
  recipe_lines: [
    { menu_item_id: 'm1', item_id: 'i1', quantity: 150 },
    { menu_item_id: 'm1', item_id: 'i2', quantity: 1 },
  ],
  menu_items: [{ id: 'm1', name: { th: 'ผัดไทย', en: 'Pad Thai' }, prices: { base: 10700 } }],
  stock_moves: [
    {
      id: 'v1',
      item_id: 'i1',
      kind: 'receive',
      qty_delta: 5000,
      note: 'Makro',
      created_at: '2026-11-19T05:00:00Z',
    },
  ],
  stores: [{ vat_registered: true, vat_bps: 700, price_mode: 'inclusive' }],
});
const ctx = (client: unknown, over: Partial<PageContext> = {}): PageContext => ({
  path: '/stock',
  navigate: () => {},
  client: client as never,
  orgId: 'o1',
  storeId: 's1',
  permissions: ['stock.manage'],
  isOwner: false,
  isPlatformAdmin: false,
  ...over,
});
const mount = (c: PageContext) =>
  render(
    <I18nProvider initialLang="en">
      <StockPage ctx={c} />
    </I18nProvider>,
  );

describe('<StockPage>', () => {
  it('lists stock with kg display, low and negative badges', async () => {
    mount(ctx(fakeDb(tables()).client));
    expect(await screen.findByText('Rice noodles')).toBeTruthy();
    // the print-only count sheet shows the quantity too, once its portal has mounted
    expect(screen.getAllByText('4.2 kg').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Running low')).toHaveLength(1); // the eggs: 8 ≤ 10
    expect(screen.getAllByText('Negative')).toHaveLength(1); // the oil
  });

  it('goods in: sends whole base units (1.5 kg = 1500 g) with the cost per kg, through the database function', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client));
    const card = (await screen.findByText('Rice noodles')).closest('li')!;
    await userEvent.click(within(card).getByRole('button', { name: 'Goods in' }));
    await userEvent.type(screen.getByLabelText('Quantity'), '1.5');
    await userEvent.type(screen.getByLabelText('Cost per kg (THB)'), '42');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(db.rpcs).toHaveLength(1));
    expect(db.rpcs[0]).toEqual({
      fn: 'stock_move',
      args: {
        p: { item_id: 'i1', kind: 'receive', quantity: 1500, cost_per_1000: 4200, note: undefined },
      },
    });
  });

  it('a wrong number is refused before anything is sent', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client));
    const card = (await screen.findByText('Egg')).closest('li')!;
    await userEvent.click(within(card).getByRole('button', { name: 'Waste' }));
    await userEvent.type(screen.getByLabelText('Quantity'), '1.5'); // no half pieces
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Enter a valid number/)).toBeTruthy();
    expect(db.rpcs).toHaveLength(0);
  });

  it('adds an item with its cost (per kg) and low level', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client));
    await userEvent.click(await screen.findByRole('button', { name: 'Add a stock item' }));
    await userEvent.type(screen.getByLabelText('Name (Thai)'), 'น้ำตาล');
    await userEvent.type(screen.getByLabelText('Cost per kg (THB)'), '25');
    await userEvent.type(screen.getByLabelText('Warn at or below (kg)'), '2');
    await userEvent.click(screen.getByRole('button', { name: 'Save item' }));
    await waitFor(() => expect(db.writes).toHaveLength(1));
    expect(db.writes[0]).toMatchObject({
      table: 'stock_items',
      values: { name: { th: 'น้ำตาล' }, unit: 'g', cost_per_1000: 2500, low_at: 2000 },
    });
  });

  it('recipes: cost per portion, price before VAT, profit and margin; adds an ingredient line', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client));
    await userEvent.click(await screen.findByRole('tab', { name: 'Recipes and cost' }));
    await userEvent.selectOptions(await screen.findByLabelText('Pick a menu item'), 'm1');
    // 150 g at 40/kg = 6.00 + 1 egg at 5.00 = 11.00 ; price 107 incl. 7 % VAT = 100.00 net
    const dl = screen.getByText('Cost per portion').closest('dl')!;
    expect(within(dl).getByText('฿11')).toBeTruthy();
    expect(within(dl).getByText('฿100')).toBeTruthy();
    expect(within(dl).getByText('฿89')).toBeTruthy();
    expect(within(dl).getByText('89.0%')).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText('Ingredient'), 'i3');
    await userEvent.type(screen.getByLabelText('Used per portion'), '20');
    await userEvent.click(screen.getByRole('button', { name: 'Add to the recipe' }));
    await waitFor(() => expect(db.writes).toHaveLength(1));
    expect(db.writes[0]).toMatchObject({
      table: 'recipe_lines',
      values: { menu_item_id: 'm1', item_id: 'i3', quantity: 20 },
    });
  });

  it('history shows the moves; a viewer (stock.view) cannot change anything; others are closed out', async () => {
    mount(ctx(fakeDb(tables()).client, { permissions: ['stock.view'] }));
    expect(await screen.findByText('Rice noodles')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add a stock item' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Goods in' })).toBeNull();
    await userEvent.click(screen.getByRole('tab', { name: 'History' }));
    expect(await screen.findByText(/Makro/)).toBeTruthy();
    cleanup();
    mount(ctx(fakeDb(tables()).client, { permissions: [] }));
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});
