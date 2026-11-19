import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { PageContext } from '@bestie/auth';
import { I18nProvider } from '@bestie/i18n';
import { fakeDb } from './fakeDb';
import { StockPage } from './StockPage';

afterEach(cleanup);

const tables = () => ({
  stock_items: [
    {
      id: 'milk',
      name: { th: 'นม', en: 'Milk' },
      barcode: '8851234567890',
      unit: 'ml',
      quantity: 6000,
      cost_per_1000: 6500,
      low_at: 0,
      active: true,
    },
    {
      id: 'oat',
      name: { th: 'นมโอ๊ต', en: 'Oat milk' },
      barcode: null,
      unit: 'ml',
      quantity: 2000,
      cost_per_1000: 9000,
      low_at: 0,
      active: true,
    },
  ],
  recipe_lines: [],
  menu_items: [],
  stock_moves: [],
  stores: [
    { id: 's1', name: 'Cafe', vat_registered: false, vat_bps: 0, price_mode: 'inclusive' },
    { id: 's2', name: 'Branch' },
  ],
  suppliers: [{ id: 'sup1', name: 'Makro', phone: '02-123-4567', note: null }],
  purchase_orders: [
    {
      id: 'po1',
      number: 'PO-0001',
      supplier_id: 'sup1',
      status: 'sent',
      note: null,
      expected_on: null,
      created_at: '2026-11-19T05:00:00Z',
    },
    {
      id: 'po2',
      number: 'PO-0002',
      supplier_id: 'sup1',
      status: 'draft',
      note: null,
      expected_on: null,
      created_at: '2026-11-19T06:00:00Z',
    },
  ],
  purchase_order_lines: [
    {
      id: 'pl1',
      po_id: 'po1',
      item_id: 'milk',
      qty_ordered: 10000,
      qty_received: 4000,
      cost_per_1000: 6500,
    },
    {
      id: 'pl2',
      po_id: 'po2',
      item_id: 'oat',
      qty_ordered: 2000,
      qty_received: 0,
      cost_per_1000: 9000,
    },
  ],
  stock_transfers: [
    {
      id: 'tr1',
      number: 'TR-0001',
      from_store_id: 's2',
      to_store_id: 's1',
      status: 'sent',
      note: null,
      created_at: '2026-11-19T07:00:00Z',
    },
  ],
  stock_transfer_lines: [
    { id: 'tl1', transfer_id: 'tr1', from_item_id: 'milk', quantity: 1500, cost_per_1000: 6500 },
  ],
  modifier_groups: [{ id: 'g1', name: { th: 'นม', en: 'Milk choice' } }],
  modifier_options: [
    { id: 'o1', group_id: 'g1', name: { th: 'โอ๊ต', en: 'Oat' } },
    { id: 'o2', group_id: 'g1', name: { th: 'ช็อตเพิ่ม', en: 'Extra shot' } },
  ],
  modifier_option_stock: [{ option_id: 'o1', item_id: 'oat', quantity: 150, instead_of: 'milk' }],
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
const openTab = async (name: string) => userEvent.click(await screen.findByRole('tab', { name }));

describe('stock v2: permissions', () => {
  it('menu.edit alone no longer opens stock (it has its own permission)', async () => {
    mount(ctx(fakeDb(tables()).client, { permissions: ['menu.edit'] }));
    expect(await screen.findByText(/permission/i)).toBeTruthy();
  });
  it('the owner can always manage stock', async () => {
    mount(ctx(fakeDb(tables()).client, { permissions: [], isOwner: true }));
    expect(await screen.findByRole('button', { name: 'Add a stock item' })).toBeTruthy();
  });
});

describe('stock v2: value and barcode', () => {
  it('shows what the stock is worth at cost', async () => {
    mount(ctx(fakeDb(tables()).client));
    // 6,000 ml × 65.00 per litre = 390.00 ; 2,000 ml × 90.00 per litre = 180.00
    expect(await screen.findByText('Stock value at cost: ฿570')).toBeTruthy();
  });
  it('a scanned code opens goods-in for that item; an unknown code says so', async () => {
    mount(ctx(fakeDb(tables()).client));
    const box = await screen.findByLabelText('Scan or type a barcode');
    await userEvent.type(box, '0000000000{Enter}');
    expect(await screen.findByText('No item has this barcode')).toBeTruthy();
    await userEvent.clear(box);
    await userEvent.type(box, '8851234567890{Enter}');
    expect(await screen.findByText(/Goods in: Milk/)).toBeTruthy();
  });
  it('a barcode is saved with the item; a malformed one is refused', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client));
    await userEvent.click(await screen.findByRole('button', { name: 'Add a stock item' }));
    await userEvent.type(screen.getByLabelText('Name (Thai)'), 'ชา');
    await userEvent.type(screen.getByLabelText('Barcode (optional)'), 'bad code!');
    await userEvent.click(screen.getByRole('button', { name: 'Save item' }));
    expect(await screen.findByText(/Enter a valid number/)).toBeTruthy();
    expect(db.writes).toHaveLength(0);
    await userEvent.clear(screen.getByLabelText('Barcode (optional)'));
    await userEvent.type(screen.getByLabelText('Barcode (optional)'), 'TEA-0001');
    await userEvent.click(screen.getByRole('button', { name: 'Save item' }));
    await waitFor(() => expect(db.writes).toHaveLength(1));
    expect(db.writes[0]).toMatchObject({ values: { barcode: 'TEA-0001' } });
  });
});

describe('stock v2: suppliers and purchase orders', () => {
  it('adds a supplier', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client));
    await openTab('Suppliers');
    expect(await screen.findByText('Makro')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Add a supplier' }));
    await userEvent.type(screen.getByLabelText('Supplier name'), 'Big C');
    await userEvent.click(screen.getByRole('button', { name: 'Save supplier' }));
    await waitFor(() => expect(db.writes).toHaveLength(1));
    expect(db.writes[0]).toMatchObject({ table: 'suppliers', values: { name: 'Big C' } });
  });

  it('lists orders with their state and only the actions that state allows', async () => {
    mount(ctx(fakeDb(tables()).client));
    await openTab('Purchase orders');
    const sent = (await screen.findByText('PO-0001')).closest('li')!;
    expect(within(sent).getByText('Sent')).toBeTruthy();
    expect(within(sent).getByText(/4 l received/)).toBeTruthy();
    expect(within(sent).getByText(/6 l still to come/)).toBeTruthy();
    expect(within(sent).getByRole('button', { name: 'Receive goods' })).toBeTruthy();
    // goods already arrived: it can no longer be cancelled
    expect(within(sent).queryByRole('button', { name: 'Cancel order' })).toBeNull();
    const draft = screen.getByText('PO-0002').closest('li')!;
    expect(within(draft).getByRole('button', { name: 'Edit draft' })).toBeTruthy();
    expect(within(draft).getByRole('button', { name: 'Mark as sent' })).toBeTruthy();
    expect(within(draft).getByRole('button', { name: 'Cancel order' })).toBeTruthy();
  });

  it('makes an order in whole base units with the price per litre', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client));
    await openTab('Purchase orders');
    await userEvent.click(await screen.findByRole('button', { name: 'New purchase order' }));
    await userEvent.selectOptions(screen.getByLabelText('Supplier'), 'sup1');
    await userEvent.type(screen.getByLabelText('Quantity ordered (l)'), '12.5');
    await userEvent.type(screen.getByLabelText('Price per litre (baht)'), '64');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(db.rpcs).toHaveLength(1));
    expect(db.rpcs[0]).toEqual({
      fn: 'save_purchase_order',
      args: {
        p: {
          id: null,
          store_id: 's1',
          supplier_id: 'sup1',
          note: undefined,
          expected_on: undefined,
          lines: [{ item_id: 'milk', quantity: 12500, cost_per_1000: 6400 }],
        },
      },
    });
  });

  it('refuses an order without a quantity before anything is sent', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client));
    await openTab('Purchase orders');
    await userEvent.click(await screen.findByRole('button', { name: 'New purchase order' }));
    await userEvent.selectOptions(screen.getByLabelText('Supplier'), 'sup1');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText(/Add at least one line/)).toBeTruthy();
    expect(db.rpcs).toHaveLength(0);
  });

  it('receives part of an order: sends what is typed per line', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client));
    await openTab('Purchase orders');
    const sent = (await screen.findByText('PO-0001')).closest('li')!;
    await userEvent.click(within(sent).getByRole('button', { name: 'Receive goods' }));
    const box = screen.getByLabelText(/Milk — Received now \(l\)/);
    expect((box as HTMLInputElement).value).toBe('6'); // what is still to come
    await userEvent.clear(box);
    await userEvent.type(box, '2.5');
    await userEvent.click(screen.getByRole('button', { name: 'Book the delivery' }));
    await waitFor(() => expect(db.rpcs).toHaveLength(1));
    expect(db.rpcs[0]).toEqual({
      fn: 'receive_purchase_order',
      args: { p: { po_id: 'po1', lines: [{ line_id: 'pl1', quantity: 2500 }] } },
    });
  });

  it('sends a draft to the supplier', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client));
    await openTab('Purchase orders');
    const draft = (await screen.findByText('PO-0002')).closest('li')!;
    await userEvent.click(within(draft).getByRole('button', { name: 'Mark as sent' }));
    await waitFor(() => expect(db.rpcs).toHaveLength(1));
    expect(db.rpcs[0]).toEqual({
      fn: 'set_purchase_order_status',
      args: { p_po: 'po2', p_status: 'sent' },
    });
  });

  it('a viewer sees the orders but none of the buttons', async () => {
    mount(ctx(fakeDb(tables()).client, { permissions: ['stock.view'] }));
    await openTab('Purchase orders');
    expect(await screen.findByText('PO-0001')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Receive goods' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New purchase order' })).toBeNull();
  });
});

describe('stock v2: transfers', () => {
  it('an incoming transfer can be received; either side can call it off', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client));
    await openTab('Transfers');
    const tr = (await screen.findByText('TR-0001')).closest('li')!;
    expect(within(tr).getByText('From Branch')).toBeTruthy();
    expect(within(tr).getByText('On the way')).toBeTruthy();
    await userEvent.click(within(tr).getByRole('button', { name: 'Receive the transfer' }));
    await waitFor(() => expect(db.rpcs).toHaveLength(1));
    expect(db.rpcs[0]).toEqual({
      fn: 'receive_stock_transfer',
      args: { p: { transfer_id: 'tr1' } },
    });
  });

  it('sends goods to another shop; more than is on hand is refused before anything is sent', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client));
    await openTab('Transfers');
    await userEvent.click(
      await screen.findByRole('button', { name: 'Transfer stock to another shop' }),
    );
    await userEvent.selectOptions(screen.getByLabelText('Send to shop'), 's2');
    await userEvent.type(screen.getByLabelText(/Quantity \(l\)/), '9'); // 9 l > 6 l on hand
    await userEvent.click(screen.getByRole('button', { name: 'Send goods' }));
    expect(await screen.findByText(/cannot send more than is on hand/)).toBeTruthy();
    expect(db.rpcs).toHaveLength(0);
    const q = screen.getByLabelText(/Quantity \(l\)/);
    await userEvent.clear(q);
    await userEvent.type(q, '3');
    await userEvent.click(screen.getByRole('button', { name: 'Send goods' }));
    await waitFor(() => expect(db.rpcs).toHaveLength(1));
    expect(db.rpcs[0]).toEqual({
      fn: 'send_stock_transfer',
      args: {
        p: {
          from_store_id: 's1',
          to_store_id: 's2',
          note: undefined,
          lines: [{ item_id: 'milk', quantity: 3000 }],
        },
      },
    });
  });
});

describe('stock v2: options that use stock', () => {
  it('shows what each option uses and what it replaces', async () => {
    mount(ctx(fakeDb(tables()).client));
    await openTab('Options using stock');
    const oat = (await screen.findByText('Oat')).closest('li')!;
    expect(within(oat).getByText(/Uses 150 ml of Oat milk/)).toBeTruthy();
    expect(within(oat).getByText(/instead of Milk in the recipe/)).toBeTruthy();
    const shot = screen.getByText('Extra shot').closest('li')!;
    expect(within(shot).getByText('Does not use stock')).toBeTruthy();
  });

  it('links the extra shot to an ingredient', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client));
    await openTab('Options using stock');
    const shot = (await screen.findByText('Extra shot')).closest('li')!;
    await userEvent.click(within(shot).getByRole('button', { name: 'Link to an ingredient' }));
    await userEvent.selectOptions(screen.getByLabelText('Ingredient'), 'milk');
    await userEvent.type(screen.getByLabelText(/Used per portion with this option/), '30');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(db.writes).toHaveLength(1));
    expect(db.writes[0]).toMatchObject({
      table: 'modifier_option_stock',
      op: 'insert',
      values: { option_id: 'o2', item_id: 'milk', quantity: 30, instead_of: null },
    });
  });

  it('removes a link', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client));
    await openTab('Options using stock');
    const oat = (await screen.findByText('Oat')).closest('li')!;
    await userEvent.click(within(oat).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(db.writes).toHaveLength(1));
    expect(db.writes[0]).toMatchObject({ table: 'modifier_option_stock', op: 'delete' });
  });
});
