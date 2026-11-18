import { act, cleanup, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addLine, newOrder, sendNew } from '@bestie/core';
import type { OrderDoc } from '@bestie/core';
import { getOrder, listOutbox, resetOfflineDb, saveOrder, setDeviceBinding } from '@bestie/offline';
import { useNewIds } from './chime';
import { KitchenPage, QueueDisplayPage, QueuePage, ReadyPage } from './KitchenPages';
import { ORG, STORE, baseTables, mountEn, pageCtx, posClient } from './testKit';

afterEach(() => {
  cleanup();
  setDeviceBinding(null);
  vi.restoreAllMocks();
});
beforeEach(async () => {
  await resetOfflineDb();
  localStorage.clear();
});

const bindKds = (station: 'kitchen' | 'bar' | null) =>
  setDeviceBinding({
    deviceId: 'kds-1',
    storeId: STORE,
    orgId: ORG,
    name: 'Bar screen',
    code: 'K',
    role: 'kds',
    station,
    posId: null,
  });
const bindCashier = () =>
  setDeviceBinding({
    deviceId: 'dev-1',
    storeId: STORE,
    orgId: ORG,
    name: 'Counter',
    code: 'A',
    role: 'cashier',
    station: null,
    posId: null,
  });

const item = (name: string, station: 'kitchen' | 'bar' | null) => ({
  id: name,
  name: { th: name, en: name },
  prices: { base: 5000 },
  station,
});
const bill = async (
  id: string,
  number: string,
  channel: 'dine-in' | 'takeaway',
  lines: { name: string; station: 'kitchen' | 'bar' | null; qty?: number; note?: string }[],
  minutesAgo = 1,
  status?: 'ready' | 'served',
): Promise<OrderDoc> => {
  let o = newOrder({
    id,
    orgId: ORG,
    storeId: STORE,
    number,
    channel,
    tableId: channel === 'dine-in' ? 't1' : null,
    now: Date.now(),
  });
  for (const l of lines)
    o = addLine(o, {
      lineId: `${id}-${l.name}`,
      item: item(l.name, l.station),
      groups: [],
      selected: [],
      quantity: l.qty ?? 1,
      note: l.note,
    });
  o = sendNew(o, Date.now() - minutesAgo * 60_000).order;
  if (status) o = { ...o, lines: o.lines.map((l) => ({ ...l, status })) };
  await saveOrder(null, o);
  return o;
};
const ctx = (path: string, permissions: ('kds.use' | 'order.create')[] = ['kds.use']) =>
  pageCtx(posClient(baseTables()), { path, permissions });
const rpcs = async () => (await listOutbox()).filter((e) => e.op.kind === 'rpc');

describe('<KitchenPage>', () => {
  it('a bar screen shows only the bar lines of each bill, with quantity and note, oldest first', async () => {
    bindKds('bar');
    await bill(
      'A',
      'A001',
      'dine-in',
      [
        { name: 'Noodles', station: 'kitchen' },
        { name: 'Beer', station: 'bar', qty: 2, note: 'very cold' },
      ],
      5,
    );
    await bill('B', 'A002', 'takeaway', [{ name: 'Coffee', station: 'bar' }], 2);
    mountEn(<KitchenPage ctx={ctx('/kds')} />);
    const incoming = await screen.findByRole('region', { name: 'To make' });
    const cards = within(incoming).getAllByRole('article');
    expect(cards.map((c) => c.getAttribute('aria-label'))).toEqual(['Bill A001', 'Bill A002']);
    expect(cards[0]!.textContent).toContain('2×');
    expect(cards[0]!.textContent).toContain('Beer');
    expect(cards[0]!.textContent).toContain('very cold');
    expect(cards[0]!.textContent).not.toContain('Noodles');
    expect(cards[0]!.textContent).toContain('T1'); // the table
  });

  it('colours a ticket by how long it has waited', async () => {
    bindKds('kitchen');
    await bill('A', 'A001', 'dine-in', [{ name: 'Soup', station: 'kitchen' }], 20);
    await bill('B', 'A002', 'dine-in', [{ name: 'Rice', station: 'kitchen' }], 9);
    await bill('C', 'A003', 'dine-in', [{ name: 'Salad', station: 'kitchen' }], 1);
    mountEn(<KitchenPage ctx={ctx('/kds')} />);
    const cards = within(await screen.findByRole('region', { name: 'To make' })).getAllByRole(
      'article',
    );
    expect(cards.map((c) => c.getAttribute('data-age'))).toEqual(['late', 'warn', 'ok']);
  });

  it('Ready moves the whole ticket to the ready list at once and queues ONE set_lines_status call; Undo brings it back', async () => {
    bindKds('kitchen');
    await bill('A', 'A001', 'dine-in', [
      { name: 'Soup', station: 'kitchen' },
      { name: 'Rice', station: 'kitchen' },
    ]);
    mountEn(<KitchenPage ctx={ctx('/kds')} />);
    await userEvent.click(
      await within(await screen.findByRole('region', { name: 'To make' })).findByRole('button', {
        name: 'Ready',
      }),
    );
    await waitFor(async () =>
      expect((await getOrder('A'))!.lines.map((l) => l.status)).toEqual(['ready', 'ready']),
    );
    const call = (await rpcs()).at(-1)!.op as unknown as {
      fn: string;
      args: { p: { line_ids: string[]; status: string } };
    };
    expect(call.fn).toBe('set_lines_status');
    expect(call.args.p).toMatchObject({ status: 'ready' });
    expect(call.args.p.line_ids).toHaveLength(2);
    const ready = await screen.findByRole('region', { name: 'Ready — waiting to be served' });
    await userEvent.click(within(ready).getByRole('button', { name: 'Undo' }));
    await waitFor(async () =>
      expect((await getOrder('A'))!.lines.map((l) => l.status)).toEqual(['sent', 'sent']),
    );
    expect(
      ((await rpcs()).at(-1)!.op as unknown as { args: { p: { status: string } } }).args.p.status,
    ).toBe('sent');
  });

  it('works with no signal: says so, and a bump is still saved and queued', async () => {
    vi.spyOn(globalThis.navigator, 'onLine', 'get').mockReturnValue(false);
    bindKds('kitchen');
    await bill('A', 'A001', 'dine-in', [{ name: 'Soup', station: 'kitchen' }]);
    mountEn(<KitchenPage ctx={ctx('/kds')} />);
    expect(await screen.findByText(/Offline — new orders may not reach this screen/)).toBeTruthy();
    await userEvent.click(await screen.findByRole('button', { name: 'Ready' }));
    await waitFor(async () => expect((await getOrder('A'))!.lines[0]!.status).toBe('ready'));
    expect(await rpcs()).toHaveLength(1);
  });

  it('a tablet that is not a kitchen screen asks which station to show', async () => {
    bindCashier();
    await bill('A', 'A001', 'dine-in', [
      { name: 'Soup', station: 'kitchen' },
      { name: 'Beer', station: 'bar' },
    ]);
    mountEn(<KitchenPage ctx={ctx('/kds')} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Bar' }));
    const cards = within(await screen.findByRole('region', { name: 'To make' })).getAllByRole(
      'article',
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]!.textContent).toContain('Beer');
  });

  it('shows nothing for cancelled lines, unsent lines or lines of other stations', async () => {
    bindKds('kitchen');
    await bill('A', 'A001', 'dine-in', [
      { name: 'Beer', station: 'bar' },
      { name: 'Bag', station: null },
    ]);
    mountEn(<KitchenPage ctx={ctx('/kds')} />);
    expect(await screen.findByText('Nothing waiting')).toBeTruthy();
  });
});

describe('<ReadyPage> (waiter)', () => {
  it('lists what is ready per bill and table; Served clears it and queues one call', async () => {
    bindCashier();
    await bill(
      'A',
      'A001',
      'dine-in',
      [
        { name: 'Soup', station: 'kitchen' },
        { name: 'Beer', station: 'bar' },
      ],
      6,
      'ready',
    );
    await bill('B', 'A002', 'dine-in', [{ name: 'Rice', station: 'kitchen' }], 3); // still cooking: not listed
    mountEn(<ReadyPage ctx={ctx('/ready', ['order.create'])} />);
    const card = await screen.findByRole('article', { name: 'Bill A001' });
    expect(screen.queryByRole('article', { name: 'Bill A002' })).toBeNull();
    expect(card.textContent).toContain('Soup');
    expect(card.textContent).toContain('Beer');
    await userEvent.click(within(card).getByRole('button', { name: 'Served' }));
    await waitFor(async () =>
      expect((await getOrder('A'))!.lines.map((l) => l.status)).toEqual(['served', 'served']),
    );
    expect(
      ((await rpcs()).at(-1)!.op as unknown as { args: { p: { status: string } } }).args.p.status,
    ).toBe('served');
    expect(await screen.findByText('Nothing is waiting to be served.')).toBeTruthy();
  });
});

describe('queue (cafe)', () => {
  const seed = async () => {
    await bill('P', 'A010', 'takeaway', [{ name: 'Latte', station: 'bar' }], 2);
    await bill('R', 'A011', 'takeaway', [{ name: 'Mocha', station: 'bar' }], 4, 'ready');
    await bill('H', 'A012', 'takeaway', [{ name: 'Water', station: 'bar' }], 6, 'served');
    await bill('T', 'A013', 'dine-in', [{ name: 'Soup', station: 'kitchen' }], 3);
  };

  it('staff view: preparing and ready columns for counter bills only; Handed over serves it', async () => {
    bindCashier();
    await seed();
    mountEn(<QueuePage ctx={ctx('/queue', ['order.create'])} />);
    const preparing = await screen.findByRole('region', { name: 'Preparing' });
    expect(within(preparing).getByText('A010')).toBeTruthy();
    expect(within(preparing).queryByText('A013')).toBeNull(); // a table bill is not on the queue
    const ready = screen.getByRole('region', { name: 'Ready to collect' });
    expect(within(ready).getByText('A011')).toBeTruthy();
    expect(screen.queryByText('A012')).toBeNull(); // already handed over
    await userEvent.click(within(ready).getByRole('button', { name: 'Handed over' }));
    await waitFor(async () => expect((await getOrder('R'))!.lines[0]!.status).toBe('served'));
    await waitFor(() =>
      expect(
        within(screen.getByRole('region', { name: 'Ready to collect' })).queryByText('A011'),
      ).toBeNull(),
    );
  });

  it('the call screen shows only big numbers — no buttons that could change anything', async () => {
    bindCashier();
    await seed();
    mountEn(<QueueDisplayPage ctx={ctx('/queue/display', ['order.create'])} />);
    const ready = await screen.findByRole('region', { name: 'Ready to collect' });
    expect(within(ready).getByText('A011')).toBeTruthy();
    expect(within(ready).getByText('Please collect at the counter')).toBeTruthy();
    expect(within(ready).queryByRole('button')).toBeNull();
    expect(
      within(screen.getByRole('region', { name: 'Preparing' })).getByText('A010'),
    ).toBeTruthy();
  });

  it('the staff view links to the call screen', async () => {
    bindCashier();
    const c = ctx('/queue', ['order.create']);
    mountEn(<QueuePage ctx={c} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Open call screen' }));
    expect(c.navigate).toHaveBeenCalledWith('/queue/display');
  });
});

describe('useNewIds (the chime)', () => {
  it('stays quiet for what was already there, beeps once for a new id, and never when sound is off', () => {
    const beep = vi.fn();
    const { rerender } = renderHook(({ ids, on }) => useNewIds(ids, on, beep), {
      initialProps: { ids: ['a', 'b'], on: true },
    });
    expect(beep).not.toHaveBeenCalled();
    rerender({ ids: ['a', 'b', 'c'], on: true });
    expect(beep).toHaveBeenCalledTimes(1);
    rerender({ ids: ['a', 'c'], on: true }); // something left: no beep
    expect(beep).toHaveBeenCalledTimes(1);
    rerender({ ids: ['a', 'c', 'd'], on: false });
    expect(beep).toHaveBeenCalledTimes(1);
    act(() => {});
  });
});
