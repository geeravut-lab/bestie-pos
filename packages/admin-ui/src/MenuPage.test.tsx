import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '@bestie/i18n';
import type { PageContext } from '@bestie/auth';
import { MenuPage } from './MenuPage';
import { fakeDb } from './fakeDb';

afterEach(cleanup);

const tables = () => ({
  stores: [{ id: 's1', name: 'Acme' }],
  menu_categories: [
    { id: 'c1', name: { th: 'จานเดียว', en: 'One dish' }, sort: 10, created_at: '2026-01-01' },
    { id: 'c2', name: { th: 'เครื่องดื่ม' }, sort: 20, created_at: '2026-01-02' },
  ],
  menu_items: [
    {
      id: 'i1',
      category_id: 'c1',
      name: { th: 'ผัดไทย', en: 'Pad Thai' },
      prices: { base: 8000, delivery: 9500 },
      station: 'kitchen',
      modifier_group_ids: ['g1'],
      available: true,
      sort: 10,
      created_at: '2026-01-01',
    },
    {
      id: 'i2',
      category_id: 'c1',
      name: { th: 'ข้าวผัด', en: 'Fried rice' },
      prices: { base: 6000 },
      station: null,
      modifier_group_ids: [],
      available: false,
      sort: 20,
      created_at: '2026-01-02',
    },
  ],
  modifier_groups: [
    {
      id: 'g1',
      name: { th: 'ความเผ็ด', en: 'Spice' },
      min_select: 1,
      max_select: 1,
      sort: 10,
      created_at: '2026-01-01',
    },
    {
      id: 'g2',
      name: { th: 'ท็อปปิ้ง', en: 'Toppings' },
      min_select: 0,
      max_select: 3,
      sort: 20,
      created_at: '2026-01-02',
    },
  ],
  modifier_options: [
    {
      id: 'o1',
      group_id: 'g1',
      name: { th: 'เผ็ดน้อย', en: 'Mild' },
      price_delta: 0,
      channel_delta: {},
      sort: 10,
      created_at: '2026-01-01',
    },
    {
      id: 'o2',
      group_id: 'g1',
      name: { th: 'เผ็ดมาก', en: 'Hot' },
      price_delta: 500,
      channel_delta: {},
      sort: 20,
      created_at: '2026-01-02',
    },
  ],
});
const ctx = (client: unknown, over: Partial<PageContext> = {}): PageContext => ({
  path: '/menu',
  navigate: () => {},
  client: client as never,
  orgId: 'o1',
  storeId: 's1',
  permissions: [],
  isOwner: true,
  isPlatformAdmin: false,
  ...over,
});
const mount = (c: PageContext) =>
  render(
    <I18nProvider initialLang="en">
      <MenuPage ctx={c} />
    </I18nProvider>,
  );
const ready = async () => {
  await screen.findByRole('heading', { name: 'Menu & prices' });
  await screen.findByRole('heading', { name: 'Categories' }); // the menu itself has loaded
};
const itemRow = (name: string) => screen.getByText(name).closest('li') as HTMLElement;

describe('<MenuPage> items', () => {
  it('lists items with price, station and sold-out marks, in English when the language is English', async () => {
    mount(ctx(fakeDb(tables()).client));
    await ready();
    const row = itemRow('Pad Thai');
    expect(row.textContent).toContain('฿80');
    expect(row.textContent).toContain('Kitchen');
    expect(itemRow('Fried rice').textContent).toContain('Sold out');
  });

  it('adds a category with a client-made id, the org and shop, and the next sort number', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client));
    await ready();
    await userEvent.type(screen.getAllByLabelText('Name (Thai)').at(-1)!, 'ของหวาน');
    await userEvent.type(screen.getAllByLabelText('Name (English — optional)').at(-1)!, 'Dessert');
    await userEvent.click(screen.getByRole('button', { name: 'Add category' }));
    await waitFor(() => expect(db.writes).toHaveLength(1));
    expect(db.writes[0]).toMatchObject({
      table: 'menu_categories',
      op: 'insert',
      values: { org_id: 'o1', store_id: 's1', name: { th: 'ของหวาน', en: 'Dessert' }, sort: 30 },
    });
    expect(typeof (db.writes[0]!.values as { id: string }).id).toBe('string');
  });

  it('adds an item; an override equal to the main price is not stored, an empty one is skipped', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client));
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Add item' }));
    const form = screen.getByRole('group', { name: 'Add item' }).closest('form') as HTMLElement;
    await userEvent.type(within(form).getByLabelText('Name (Thai)'), 'แกงเขียวหวาน');
    await userEvent.type(within(form).getByLabelText('Price (baht)'), '95.5');
    await userEvent.type(within(form).getByLabelText('Delivery'), '115');
    await userEvent.type(within(form).getByLabelText('QR order'), '95.5');
    await userEvent.selectOptions(within(form).getByLabelText('Send orders to'), 'kitchen');
    await userEvent.click(within(form).getByLabelText('Spice'));
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(db.writes).toHaveLength(1));
    expect(db.writes[0]).toMatchObject({
      table: 'menu_items',
      op: 'insert',
      values: {
        org_id: 'o1',
        store_id: 's1',
        category_id: 'c1',
        name: { th: 'แกงเขียวหวาน' },
        prices: { base: 9550, delivery: 11500 },
        station: 'kitchen',
        modifier_group_ids: ['g1'],
        available: true,
      },
    });
    expect((db.writes[0]!.values as { prices: object }).prices).not.toHaveProperty('qr');
  });

  it('refuses a bad price or missing Thai name without calling the server', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client));
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Add item' }));
    const form = screen.getByRole('group', { name: 'Add item' }).closest('form') as HTMLElement;
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect((await within(form).findAllByRole('alert')).length).toBe(1);
    await userEvent.type(within(form).getByLabelText('Name (Thai)'), 'x');
    await userEvent.type(within(form).getByLabelText('Price (baht)'), '5.123');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await within(form).findByText(/menu details are not valid/);
    expect(db.writes).toHaveLength(0);
  });

  it('changes the price of an existing item with an update', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client));
    await ready();
    await userEvent.click(within(itemRow('Pad Thai')).getByRole('button', { name: 'Edit' }));
    const price = within(itemRow('Pad Thai')).getByLabelText('Price (baht)') as HTMLInputElement;
    expect(price.value).toBe('80');
    await userEvent.clear(price);
    await userEvent.type(price, '85');
    await userEvent.click(within(itemRow('Pad Thai')).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(db.writes).toHaveLength(1));
    expect(db.writes[0]).toMatchObject({
      table: 'menu_items',
      op: 'update',
      values: { prices: { base: 8500, delivery: 9500 } },
    });
  });

  it('deletes an item softly after confirming', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client));
    await ready();
    await userEvent.click(within(itemRow('Fried rice')).getByRole('button', { name: 'Edit' }));
    await userEvent.click(within(itemRow('Fried rice')).getByRole('button', { name: 'Delete' }));
    expect(db.writes).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Yes, delete' }));
    await waitFor(() => expect(db.writes).toHaveLength(1));
    expect(db.writes[0]!.values).toHaveProperty('deleted_at');
    expect(db.writes[0]!.op).toBe('update');
  });

  it('will not delete a category that still has items', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client));
    await ready();
    const cat = screen
      .getAllByText('One dish')
      .map((e) => e.closest('li'))
      .find(Boolean) as HTMLElement;
    await userEvent.click(within(cat).getByRole('button', { name: 'Delete' }));
    await userEvent.click(screen.getByRole('button', { name: 'Yes, delete' }));
    expect(await screen.findByText(/can't be deleted while it still has items/)).toBeTruthy();
    expect(db.writes).toHaveLength(0);
  });

  it('is read-only without menu.edit', async () => {
    mount(ctx(fakeDb(tables()).client, { isOwner: false, permissions: ['report.view'] }));
    await ready();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add item' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add category' })).toBeNull();
    expect(screen.getByText(/View only/)).toBeTruthy();
  });

  it('a refused save (0 rows touched) is reported, not shown as success', async () => {
    const db = fakeDb(tables(), { updatedRows: 0 });
    mount(ctx(db.client));
    await ready();
    await userEvent.click(within(itemRow('Pad Thai')).getByRole('button', { name: 'Edit' }));
    await userEvent.click(within(itemRow('Pad Thai')).getByRole('button', { name: 'Save' }));
    expect(await within(itemRow('Pad Thai')).findByText(/Couldn't save/)).toBeTruthy();
  });
});

describe('<MenuPage> add-on options', () => {
  const openOptions = async () => {
    await ready();
    await userEvent.click(screen.getByRole('tab', { name: 'Add-on options' }));
  };

  it('shows the pick rule, and warns when a required group has too few options', async () => {
    const t = tables();
    t.modifier_groups[0]!.min_select = 3;
    t.modifier_groups[0]!.max_select = 3;
    mount(ctx(fakeDb(t).client));
    await openOptions();
    expect(screen.getByText('Pick 3–3')).toBeTruthy();
    expect(screen.getByText(/requires 3 choices but only has 2/)).toBeTruthy();
    expect(screen.getByText('Pick 0–3')).toBeTruthy();
  });

  it('adds an option with a negative price; a per-channel amount equal to the base is dropped', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client));
    await openOptions();
    await userEvent.click(screen.getAllByRole('button', { name: /Add option/ })[0]!);
    const form = screen
      .getByLabelText('Extra price (baht, may be negative)')
      .closest('form') as HTMLElement;
    await userEvent.type(within(form).getByLabelText('Name (Thai)'), 'ไม่เผ็ด');
    await userEvent.type(within(form).getByLabelText('Extra price (baht, may be negative)'), '-5');
    await userEvent.type(within(form).getByLabelText('Delivery'), '-5');
    await userEvent.type(within(form).getByLabelText('QR order'), '10');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(db.writes).toHaveLength(1));
    expect(db.writes[0]).toMatchObject({
      table: 'modifier_options',
      op: 'insert',
      values: {
        org_id: 'o1',
        store_id: 's1',
        group_id: 'g1',
        name: { th: 'ไม่เผ็ด' },
        price_delta: -500,
        channel_delta: { qr: 1000 },
      },
    });
  });

  it('adds a group with min/max and refuses min above max', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client));
    await openOptions();
    await userEvent.click(screen.getByRole('button', { name: 'Add group' }));
    const form = screen
      .getByLabelText('Must pick at least (0 = optional)')
      .closest('form') as HTMLElement;
    await userEvent.type(within(form).getByLabelText('Name (Thai)'), 'ขนาด');
    await userEvent.clear(within(form).getByLabelText('Must pick at least (0 = optional)'));
    await userEvent.type(within(form).getByLabelText('Must pick at least (0 = optional)'), '3');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await within(form).findByText(/menu details are not valid/);
    expect(db.writes).toHaveLength(0);
    await userEvent.clear(within(form).getByLabelText('Must pick at least (0 = optional)'));
    await userEvent.type(within(form).getByLabelText('Must pick at least (0 = optional)'), '1');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(db.writes).toHaveLength(1));
    expect(db.writes[0]).toMatchObject({
      table: 'modifier_groups',
      values: { name: { th: 'ขนาด' }, min_select: 1, max_select: 1, sort: 30 },
    });
  });

  it('will not delete a group that an item still uses, but deletes an unused one', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client));
    await openOptions();
    const used = screen.getByText('Spice').closest('li') as HTMLElement;
    await userEvent.click(within(used).getAllByRole('button', { name: 'Delete' })[0]!);
    expect(await within(used).findByText(/1 item\(s\) still use it/)).toBeTruthy();
    const free = screen.getByText('Toppings').closest('li') as HTMLElement;
    await userEvent.click(within(free).getAllByRole('button', { name: 'Delete' })[0]!);
    await userEvent.click(screen.getByRole('button', { name: 'Yes, delete' }));
    await waitFor(() => expect(db.writes).toHaveLength(1));
    expect(db.writes[0]).toMatchObject({ table: 'modifier_groups', op: 'update' });
    expect(db.writes[0]!.values).toHaveProperty('deleted_at');
  });
});

describe('<MenuPage> demo menu', () => {
  const emptyShop = (profile: string) => ({
    ...tables(),
    stores: [{ id: 's1', name: 'Acme', profile }],
    menu_categories: [],
    menu_items: [],
    modifier_groups: [],
    modifier_options: [],
  });

  it('offers the demo menu on an empty restaurant and calls the server function for that shop', async () => {
    const db = fakeDb(emptyShop('restaurant'), {
      rpc: { seed_demo_menu: { data: { items: 13 } } },
    });
    mount(ctx(db.client));
    await userEvent.click(await screen.findByRole('button', { name: 'Load demo menu' }));
    await waitFor(() => expect(db.rpcs).toHaveLength(1));
    expect(db.rpcs[0]).toEqual({ fn: 'seed_demo_menu', args: { p_store: 's1' } });
  });

  it('is not offered when the shop has a menu, no edit right, or another profile', async () => {
    mount(ctx(fakeDb(tables()).client));
    await ready();
    expect(screen.queryByRole('button', { name: 'Load demo menu' })).toBeNull();
    cleanup();
    mount(ctx(fakeDb(emptyShop('restaurant')).client, { isOwner: false, permissions: [] }));
    await screen.findByRole('heading', { name: 'Menu & prices' });
    expect(screen.queryByRole('button', { name: 'Load demo menu' })).toBeNull();
    cleanup();
    mount(ctx(fakeDb(emptyShop('salon')).client));
    await screen.findByRole('heading', { name: 'Menu & prices' });
    expect(screen.queryByRole('button', { name: 'Load demo menu' })).toBeNull();
  });
});
