import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addLine, closeOrder, newOrder, orderBill, buildCashReceipt, sendNew } from '@bestie/core';
import type { OrderDoc } from '@bestie/core';
import {
  getOpenShift,
  getOrder,
  listOpenOrders,
  listOutbox,
  resetOfflineDb,
  saveOrder,
  saveShift,
  setDeviceBinding,
} from '@bestie/offline';
import { openShift } from '@bestie/core';
import { OrderPage } from './OrderPage';
import { ShiftPage } from './ShiftPage';
import { ORG, STORE, baseTables, bindTablet, mountEn, pageCtx, posClient } from './testKit';

afterEach(() => {
  cleanup();
  setDeviceBinding(null);
});
beforeEach(async () => {
  await resetOfflineDb();
  localStorage.clear();
});

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const item = (id: string, price: number) => ({
  id,
  name: { th: id, en: id },
  prices: { base: price },
  station: null,
});
const seed = async (id = A, number = 'A001', table: string | null = 't1'): Promise<OrderDoc> => {
  let o = newOrder({
    id,
    orgId: ORG,
    storeId: STORE,
    number,
    channel: 'dine-in',
    tableId: table,
    now: Date.now(),
  });
  o = sendNew(
    addLine(o, {
      lineId: `${id}-beer`,
      item: item('Beer', 6000),
      groups: [],
      selected: [],
      quantity: 3,
    }),
    Date.now(),
  ).order;
  o = addLine(o, {
    lineId: `${id}-noodles`,
    item: item('Noodles', 8000),
    groups: [],
    selected: [],
    quantity: 1,
  });
  await saveOrder(null, o);
  return o;
};
const mount = (id = A) => {
  const ctx = pageCtx(posClient(baseTables()), {
    path: `/order/${id}`,
    permissions: ['order.create', 'payment.take'],
  });
  mountEn(<OrderPage ctx={ctx} orderId={id} />);
  return ctx;
};
const rpcs = async () => (await listOutbox()).filter((e) => e.op.kind === 'rpc');

describe('splitting a bill', () => {
  it('moves picked items (even part of a sent line) to a new numbered bill on the same table, queueing the new bill and ONE move call', async () => {
    bindTablet();
    await seed();
    const ctx = mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Split bill' }));
    const sheet = await screen.findByRole('dialog', { name: 'Split bill' });
    const beer = within(sheet).getByText('Beer').closest('li') as HTMLElement;
    await userEvent.click(within(beer).getByRole('button', { name: 'More Beer' }));
    await userEvent.click(within(beer).getByRole('button', { name: 'More Beer' }));
    const noodles = within(sheet).getByText('Noodles').closest('li') as HTMLElement;
    await userEvent.click(within(noodles).getByRole('button', { name: 'More Noodles' }));
    await userEvent.click(within(sheet).getByRole('button', { name: 'Split into a new bill' }));
    await waitFor(() => expect(ctx.navigate).toHaveBeenCalled());

    const open = await listOpenOrders(STORE);
    expect(open).toHaveLength(2);
    const source = (await getOrder(A))!;
    const target = open.find((o) => o.id !== A)!;
    expect(target).toMatchObject({ number: 'A002', tableId: 't1', channel: 'dine-in' });
    expect(ctx.navigate).toHaveBeenCalledWith(`/order/${target.id}`);
    expect(source.lines.find((l) => l.itemId === 'Beer')!.quantity).toBe(1);
    expect(target.lines.map((l) => [l.itemId, l.quantity, l.status]).sort()).toEqual([
      ['Beer', 2, 'sent'],
      ['Noodles', 1, 'new'],
    ]);

    const q = await listOutbox();
    const afterSeed = q.slice(-2);
    expect(
      afterSeed.map((e) =>
        e.op.kind === 'insert' ? `insert:${e.op.table}` : e.op.kind === 'rpc' ? e.op.fn : '?',
      ),
    ).toEqual(['insert:orders', 'move_order_lines']);
    const move = (await rpcs()).at(-1)!.op as unknown as {
      args: {
        p: { from_order: string; to_order: string; moves: { qty: number; new_line_id?: string }[] };
      };
    };
    expect(move.args.p).toMatchObject({ from_order: A, to_order: target.id });
    expect(move.args.p.moves.find((m) => m.new_line_id)).toMatchObject({ qty: 2 }); // the part of the beer line
  });

  it('will not move everything, and says what is needed', async () => {
    bindTablet();
    await seed();
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Split bill' }));
    const sheet = await screen.findByRole('dialog', { name: 'Split bill' });
    for (const [name, times] of [
      ['Beer', 3],
      ['Noodles', 1],
    ] as const)
      for (let i = 0; i < times; i++)
        await userEvent.click(within(sheet).getByRole('button', { name: `More ${name}` }));
    expect(screen.getByText(/leave at least one item on the original bill/)).toBeTruthy();
    expect(
      (within(sheet).getByRole('button', { name: 'Split into a new bill' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('by seat: give lines a seat (a seat change is a tiny update), then split a whole seat off', async () => {
    bindTablet();
    await seed();
    mount();
    await userEvent.selectOptions(await screen.findByLabelText('Seat for Beer'), '1');
    await userEvent.selectOptions(screen.getByLabelText('Seat for Noodles'), '2');
    await waitFor(async () =>
      expect((await getOrder(A))!.lines.map((l) => l.seat)).toEqual([1, 2]),
    );
    expect(
      (await listOutbox()).some(
        (e) => e.op.kind === 'update' && JSON.stringify(e.op.values) === '{"seat":1}',
      ),
    ).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Split bill' }));
    const sheet = await screen.findByRole('dialog', { name: 'Split bill' });
    await userEvent.click(within(sheet).getByRole('tab', { name: 'By seat' }));
    await userEvent.click(within(sheet).getByRole('radio', { name: 'Seat 2' }));
    await userEvent.click(within(sheet).getByRole('button', { name: 'Split into a new bill' }));
    await waitFor(async () => expect(await listOpenOrders(STORE)).toHaveLength(2));
    const target = (await listOpenOrders(STORE)).find((o) => o.id !== A)!;
    expect(target.lines.map((l) => l.itemId)).toEqual(['Noodles']);
    expect((await getOrder(A))!.lines.map((l) => l.itemId)).toEqual(['Beer']);
  });

  it('by seat with no seats set explains what to do', async () => {
    bindTablet();
    await seed();
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Split bill' }));
    const sheet = await screen.findByRole('dialog', { name: 'Split bill' });
    await userEvent.click(within(sheet).getByRole('tab', { name: 'By seat' }));
    expect(within(sheet).getByText(/No item has a seat yet/)).toBeTruthy();
  });

  it('the other bills of the same table are one tap away', async () => {
    bindTablet();
    await seed(A, 'A001', 't1');
    await seed(B, 'A002', 't1');
    const ctx = mount(A);
    await userEvent.click(await screen.findByRole('button', { name: 'A002' }));
    expect(ctx.navigate).toHaveBeenCalledWith(`/order/${B}`);
  });
});

describe('merging bills', () => {
  it('moves everything to the chosen bill, closes the empty one, and queues only the move', async () => {
    bindTablet();
    await seed(A, 'A001', 't1');
    await seed(B, 'A002', 't2');
    const ctx = mount(A);
    await userEvent.selectOptions(await screen.findByLabelText('Merge into another bill'), B);
    expect(screen.getByText(/Every item on this bill moves/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Merge bills' }));
    await waitFor(() => expect(ctx.navigate).toHaveBeenCalledWith(`/order/${B}`));
    expect((await getOrder(A))!.status).toBe('void');
    expect((await getOrder(B))!.lines).toHaveLength(4);
    const last = (await rpcs()).at(-1)!.op as unknown as {
      fn: string;
      args: { p: { void_source_if_empty: boolean; from_order: string } };
    };
    expect(last.fn).toBe('move_order_lines');
    expect(last.args.p).toMatchObject({ from_order: A, void_source_if_empty: true });
    expect((await listOpenOrders(STORE)).map((o) => o.id)).toEqual([B]);
  });

  it('offers no merge when there is no other open bill', async () => {
    bindTablet();
    await seed();
    mount();
    await screen.findByRole('button', { name: 'Split bill' });
    expect(screen.queryByLabelText('Merge into another bill')).toBeNull();
  });
});

describe('shift required before payment', () => {
  const paySetup = async (required: boolean, withShift: boolean) => {
    bindTablet();
    await seed(A, 'A001', null);
    if (withShift)
      await saveShift(
        openShift({
          id: 's1',
          orgId: ORG,
          storeId: STORE,
          deviceId: 'dev-1',
          openedBy: null,
          openingCash: 0,
          now: Date.now(),
        }),
        'open',
        null,
      );
    const t = baseTables();
    (t.stores[0] as Record<string, unknown>).shift_required = required;
    const ctx = pageCtx(posClient(t), { path: `/order/${A}` });
    mountEn(<OrderPage ctx={ctx} orderId={A} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Take payment' }));
    return ctx;
  };
  it('a shop that requires it: no shift → "open a shift first" with a way there', async () => {
    const ctx = await paySetup(true, false);
    expect(await screen.findByText('Open a shift before taking payment.')).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Cash' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Go to shift' }));
    expect(ctx.navigate).toHaveBeenCalledWith('/shift');
  });
  it('with an open shift, or when the shop does not require one, paying is normal', async () => {
    await paySetup(true, true);
    expect(await screen.findByRole('tab', { name: 'Cash' })).toBeTruthy();
    cleanup();
    await resetOfflineDb();
    await paySetup(false, false);
    expect(await screen.findByRole('tab', { name: 'Cash' })).toBeTruthy();
  });
});

describe('<ShiftPage>', () => {
  const mountShift = (
    permissions: ('shift.open_close' | 'payment.take' | 'order.create')[] = [
      'shift.open_close',
      'payment.take',
    ],
  ) => {
    const ctx = pageCtx(posClient(baseTables()), { path: '/shift', permissions });
    mountEn(<ShiftPage ctx={ctx} />);
    return ctx;
  };
  const cashSale = async (n: number, amount: number, at = Date.now()) => {
    let o = newOrder({
      id: `00000000-0000-4000-8000-00000000000${n}`,
      orgId: ORG,
      storeId: STORE,
      number: `A00${n}`,
      channel: 'takeaway',
      now: at,
    });
    o = sendNew(
      addLine(o, {
        lineId: `l${n}`,
        item: item('x', amount),
        groups: [],
        selected: [],
        quantity: 1,
      }),
      at,
    ).order;
    const cfg = { priceMode: 'inclusive' as const, vatBps: 0, serviceChargeBps: 0 };
    const r = buildCashReceipt({
      order: o,
      bill: orderBill(o, cfg),
      billConfig: cfg,
      roundingRule: 'none',
      tendered: amount,
      number: `A-00000${n}`,
      paymentId: `p${n}`,
      seller: {
        sellerName: 's',
        sellerTaxId: null,
        branchCode: '00000',
        posId: null,
        vatRegistered: false,
        staffName: null,
      },
      lang: 'th',
      now: at,
    });
    await saveOrder(null, closeOrder(o, r));
  };

  it('a tablet that is not set up cannot open a shift', async () => {
    mountShift();
    expect(await screen.findByText(/Set this tablet up first/)).toBeTruthy();
  });

  it('opens a shift with the cash in the drawer — saved on the tablet, one open_shift call queued', async () => {
    bindTablet();
    mountShift();
    await userEvent.type(
      await screen.findByLabelText('Change in the drawer at opening (baht)'),
      '1000',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Open shift' }));
    await waitFor(async () => expect((await getOpenShift('dev-1'))?.openingCash).toBe(100000));
    const q = await rpcs();
    expect(q.at(-1)!.op).toMatchObject({
      fn: 'open_shift',
      args: { p: { device_id: 'dev-1', opening_cash: 100000 } },
    });
    expect(await screen.findByText('This shift so far')).toBeTruthy();
  });

  it('refuses a nonsense opening amount', async () => {
    bindTablet();
    mountShift();
    await userEvent.type(
      await screen.findByLabelText('Change in the drawer at opening (baht)'),
      'abc',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Open shift' }));
    expect(await screen.findByText('That amount is not valid.')).toBeTruthy();
    expect(await getOpenShift('dev-1')).toBeNull();
  });

  it('shows what the shift took and what should be in the drawer, then closes with the counted cash and the difference', async () => {
    bindTablet();
    const opened = Date.now() - 3_600_000;
    await saveShift(
      openShift({
        id: 's1',
        orgId: ORG,
        storeId: STORE,
        deviceId: 'dev-1',
        openedBy: null,
        openingCash: 100000,
        now: opened,
      }),
      'open',
      null,
    );
    await cashSale(1, 21000);
    await cashSale(2, 3000);
    mountShift();
    const sum = (await screen.findByText('Cash that should be in the drawer')).closest('div')!;
    expect(sum.textContent).toContain('฿1,240');
    await userEvent.type(screen.getByLabelText('Cash counted in the drawer (baht)'), '1235');
    expect(screen.getByText('Short by ฿5')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Note (optional)'), 'coins');
    await userEvent.click(screen.getByRole('button', { name: 'Close shift' }));
    await waitFor(async () => expect(await getOpenShift('dev-1')).toBeNull());
    const close = (await rpcs()).at(-1)!.op as unknown as {
      fn: string;
      args: { p: { counted_cash: number; note: string } };
    };
    expect(close.fn).toBe('close_shift');
    expect(close.args.p).toMatchObject({ counted_cash: 123500, note: 'coins' });
    expect(await screen.findByText('Closed shifts')).toBeTruthy();
    expect(await screen.findByText('Short by ฿5', { selector: '.badge' })).toBeTruthy();
  });

  it('without shift.open_close you can look but not open or close', async () => {
    bindTablet();
    mountShift(['order.create']);
    await screen.findByText('Open a shift');
    expect(screen.queryByRole('button', { name: 'Open shift' })).toBeNull();
  });
});
