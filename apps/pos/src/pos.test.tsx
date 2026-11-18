import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addLine, newOrder, sendNew } from '@bestie/core';
import type { OrderDoc } from '@bestie/core';
import {
  getOrder,
  listOpenOrders,
  listOutbox,
  resetOfflineDb,
  saveOrder,
  setDeviceBinding,
} from '@bestie/offline';
import { FloorPlanPage } from './FloorPlanPage';
import { OrderPage } from './OrderPage';
import { OrdersPage } from './OrdersPage';
import { ORG, STORE, baseTables, bindTablet, mountEn, pageCtx, posClient } from './testKit';

afterEach(() => {
  cleanup();
  setDeviceBinding(null);
});
beforeEach(async () => {
  await resetOfflineDb();
  localStorage.clear();
});

const seed = async (over: Partial<OrderDoc> = {}, lines = 0): Promise<OrderDoc> => {
  let o = newOrder({
    id: '11111111-1111-4111-8111-111111111111',
    orgId: ORG,
    storeId: STORE,
    number: 'A001',
    channel: 'dine-in',
    tableId: 't1',
    now: Date.now(),
  });
  o = { ...o, ...over, status: 'open' }; // lines first (a closed order accepts none), the override's status after
  for (let i = 0; i < lines; i++)
    o = addLine(o, {
      lineId: `l${i}`,
      item: {
        id: 'i1',
        name: { th: 'ผัดไทย', en: 'Pad Thai' },
        prices: { base: 8000 },
        station: 'kitchen',
      },
      groups: [],
      selected: [],
      quantity: 1,
    });
  if (over.status) o = { ...o, status: over.status };
  await saveOrder(null, o);
  return o;
};
const ID = '11111111-1111-4111-8111-111111111111';

describe('<FloorPlanPage>', () => {
  it('shows the tables grouped by zone, free ones marked free', async () => {
    bindTablet();
    mountEn(<FloorPlanPage ctx={pageCtx(posClient(baseTables()))} />);
    await screen.findByRole('heading', { name: 'Terrace' });
    expect(screen.getByRole('heading', { name: 'General' })).toBeTruthy(); // the table without a zone
    expect(screen.getByRole('button', { name: /T1/ }).textContent).toContain('Free');
  });

  it('tapping a free table opens a numbered order on it — saved on the tablet first — and goes to it', async () => {
    bindTablet();
    const ctx = pageCtx(posClient(baseTables()));
    mountEn(<FloorPlanPage ctx={ctx} />);
    await userEvent.click(await screen.findByRole('button', { name: /T1/ }));
    await waitFor(() => expect(ctx.navigate).toHaveBeenCalledTimes(1));
    const [o] = await listOpenOrders(STORE);
    expect(o).toMatchObject({
      number: 'A001',
      tableId: 't1',
      channel: 'dine-in',
      deviceId: 'dev-1',
      openedBy: 'staff-1',
    });
    expect(ctx.navigate).toHaveBeenCalledWith(`/order/${o!.id}`);
    expect((await listOutbox()).map((e) => (e.op.kind === 'insert' ? e.op.table : '?'))).toEqual([
      'orders',
    ]);
  });

  it('a busy table shows its bill and continues the same order instead of opening a second one', async () => {
    bindTablet();
    await seed({}, 1);
    const ctx = pageCtx(posClient(baseTables()));
    mountEn(<FloorPlanPage ctx={ctx} />);
    const card = await screen.findByRole('button', { name: /T1/ });
    await waitFor(() => expect(card.textContent).toContain('Open bill'));
    expect(card.textContent).toContain('฿'); // item count and total
    await userEvent.click(card);
    expect(ctx.navigate).toHaveBeenCalledWith(`/order/${ID}`);
    expect(await listOpenOrders(STORE)).toHaveLength(1);
  });

  it('a table with several bills (after a split) says how many', async () => {
    bindTablet();
    await seed({}, 1);
    await saveOrder(null, {
      ...newOrder({
        id: '33333333-3333-4333-8333-333333333333',
        orgId: ORG,
        storeId: STORE,
        number: 'A002',
        channel: 'dine-in',
        tableId: 't1',
        now: Date.now(),
      }),
    });
    mountEn(<FloorPlanPage ctx={pageCtx(posClient(baseTables()))} />);
    const card = await screen.findByRole('button', { name: /T1/ });
    await waitFor(() => expect(card.textContent).toContain('2 bills'));
  });

  it('a tablet that is not set up as a device cannot open bills (numbers would clash) and says what to do', async () => {
    mountEn(<FloorPlanPage ctx={pageCtx(posClient(baseTables()))} />);
    await screen.findByRole('heading', { name: 'Terrace' });
    expect(screen.getByText(/Set this tablet up first/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /T1/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('opens with no signal from the last saved copy', async () => {
    bindTablet();
    mountEn(<FloorPlanPage ctx={pageCtx(posClient(baseTables()))} />);
    await screen.findByRole('heading', { name: 'Terrace' });
    cleanup();
    const broken = posClient(baseTables());
    broken.from = () => {
      throw new TypeError('Failed to fetch');
    };
    mountEn(<FloorPlanPage ctx={pageCtx(broken)} />);
    expect(await screen.findByRole('heading', { name: 'Terrace' })).toBeTruthy();
    expect(screen.getByText('Showing the last saved data')).toBeTruthy();
  });

  it('only people with menu.edit see the table manager', async () => {
    bindTablet();
    mountEn(<FloorPlanPage ctx={pageCtx(posClient(baseTables()))} />);
    await screen.findByRole('heading', { name: 'Terrace' });
    expect(screen.queryByRole('heading', { name: 'Manage tables' })).toBeNull();
    cleanup();
    mountEn(
      <FloorPlanPage ctx={pageCtx(posClient(baseTables()), { permissions: ['menu.edit'] })} />,
    );
    expect(await screen.findByRole('heading', { name: 'Manage tables' })).toBeTruthy();
  });
});

describe('<OrdersPage>', () => {
  it('sell: starts a counter order right away (takeaway, next number) and opens it', async () => {
    bindTablet();
    const ctx = pageCtx(posClient(baseTables()), { path: '/sell' });
    mountEn(<OrdersPage ctx={ctx} mode="sell" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Start a new order' }));
    await waitFor(() => expect(ctx.navigate).toHaveBeenCalled());
    const [o] = await listOpenOrders(STORE);
    expect(o).toMatchObject({ number: 'A001', channel: 'takeaway', tableId: null });
  });

  it('lists what is open, with table name or channel and the total', async () => {
    bindTablet();
    await seed({}, 2);
    mountEn(<OrdersPage ctx={pageCtx(posClient(baseTables()), { path: '/orders' })} mode="list" />);
    const row = await screen.findByText('A001');
    expect(row.closest('button')!.textContent).toContain('Table T1');
  });
});

describe('<OrderPage>', () => {
  const mount = (over = {}) =>
    mountEn(
      <OrderPage
        ctx={pageCtx(posClient(baseTables()), { path: `/order/${ID}`, ...over })}
        orderId={ID}
      />,
    );

  it('tapping a menu item adds a line; tapping it again just raises the quantity', async () => {
    bindTablet();
    await seed();
    mount();
    const item = await screen.findByRole('button', { name: /Pad Thai/ });
    await userEvent.click(item);
    await userEvent.click(item);
    await waitFor(async () => expect((await getOrder(ID))?.lines).toHaveLength(1));
    await waitFor(async () => expect((await getOrder(ID))?.lines[0]!.quantity).toBe(2));
    expect(
      (await listOutbox()).some((e) => e.op.kind === 'insert' && e.op.table === 'order_lines'),
    ).toBe(true);
  });

  it('two taps in the same instant never overwrite each other', async () => {
    bindTablet();
    await seed();
    mount();
    const item = await screen.findByRole('button', { name: /Pad Thai/ });
    await Promise.all([userEvent.click(item), userEvent.click(item), userEvent.click(item)]);
    await waitFor(async () => expect((await getOrder(ID))?.lines[0]?.quantity).toBe(3));
  });

  it('an item with a required option opens the sheet; Add stays off until the choice is made, then prices the option in', async () => {
    bindTablet();
    await seed();
    mount();
    await userEvent.click(await screen.findByRole('button', { name: /Fried rice/ }));
    const sheet = await screen.findByRole('dialog');
    const add = within(sheet).getByRole('button', { name: 'Add to bill' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    await userEvent.click(within(sheet).getByLabelText(/Fried egg/));
    expect(add.disabled).toBe(false);
    await userEvent.click(add);
    await waitFor(async () =>
      expect((await getOrder(ID))?.lines[0]).toMatchObject({
        unitPrice: 7000,
        modifiers: [{ id: 'o1', priceDelta: 1000 }],
      }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a sold-out item cannot be added', async () => {
    bindTablet();
    await seed();
    mount();
    expect(
      ((await screen.findByRole('button', { name: /Tom yum/ })) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('send to kitchen marks the new lines sent and queues only the status change', async () => {
    bindTablet();
    await seed({}, 1);
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Send to kitchen / bar' }));
    await waitFor(async () => expect((await getOrder(ID))?.lines[0]!.status).toBe('sent'));
    const q = await listOutbox();
    const last = q.at(-1)!.op;
    expect(last).toMatchObject({
      kind: 'update',
      table: 'order_lines',
      values: { status: 'sent' },
    });
    expect(await screen.findByRole('button', { name: 'Nothing new to send' })).toBeTruthy();
  });

  it('quantity and removal work on an unsent line, and the totals follow', async () => {
    bindTablet();
    await seed({}, 1);
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'More Pad Thai' }));
    await waitFor(async () => expect((await getOrder(ID))?.lines[0]!.quantity).toBe(2));
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(async () => expect((await getOrder(ID))?.lines[0]!.status).toBe('void'));
    expect(await screen.findByText(/Nothing yet/)).toBeTruthy();
  });

  it('a sent line is frozen: no stepper; cancelling it needs order.void and a reason', async () => {
    bindTablet();
    const o = await seed({}, 1);
    await saveOrder(o, sendNew(o, Date.now()).order);
    cleanup();
    mount();
    await screen.findByText('Sent');
    expect(screen.queryByRole('button', { name: 'More Pad Thai' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel a line that was sent' })).toBeNull(); // cashier has no order.void
    cleanup();
    mount({ permissions: ['order.create', 'order.void'] });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Cancel a line that was sent' }),
    );
    await userEvent.type(screen.getByLabelText('Reason'), 'guest left');
    await userEvent.click(screen.getByRole('button', { name: 'Yes, cancel it' }));
    await waitFor(async () =>
      expect((await getOrder(ID))?.lines[0]).toMatchObject({
        status: 'void',
        voidReason: 'guest left',
      }),
    );
  });

  it('someone without order.create can look but not change', async () => {
    bindTablet();
    await seed({}, 1);
    mount({ permissions: ['report.view'] });
    expect(await screen.findByText('You can only view this order.')).toBeTruthy();
    expect((screen.getByRole('button', { name: /Pad Thai/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.queryByRole('button', { name: 'Send to kitchen / bar' })).toBeNull();
  });

  it('a closed bill is read-only', async () => {
    bindTablet();
    await seed({ status: 'paid' }, 1);
    mount();
    expect(await screen.findByText('This bill is closed.')).toBeTruthy();
    expect((screen.getByRole('button', { name: /Pad Thai/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('moves the bill to a free table only', async () => {
    bindTablet();
    await seed();
    await saveOrder(null, {
      ...newOrder({
        id: '22222222-2222-4222-8222-222222222222',
        orgId: ORG,
        storeId: STORE,
        number: 'A002',
        channel: 'dine-in',
        tableId: 't2',
        now: Date.now(),
      }),
    });
    mount();
    const select = (await screen.findByLabelText('Move to table')) as HTMLSelectElement;
    expect([...select.options].map((o) => o.text)).toEqual(['T1', 'Bar 1']); // T2 is taken
    await userEvent.selectOptions(select, 't3');
    await waitFor(async () => expect((await getOrder(ID))?.tableId).toBe('t3'));
  });

  it('an order that is not on this tablet says so', async () => {
    bindTablet();
    mount();
    expect(await screen.findByText('This order is not on this tablet.')).toBeTruthy();
  });

  it('shows the bill the owner configured: service charge on a table, none on takeaway', async () => {
    bindTablet();
    await seed({}, 1); // dine-in, ฿80, service 10 %
    mount();
    await screen.findByText('Service charge');
    cleanup();
    await resetOfflineDb();
    await seed({ channel: 'takeaway', tableId: null }, 1);
    mount();
    await screen.findByText('Total');
    expect(screen.queryByText('Service charge')).toBeNull();
  });
});
