import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addLine, newOrder } from '@bestie/core';
import { resetOfflineDb, saveOrder, setDeviceBinding } from '@bestie/offline';
import { OrderPage } from './OrderPage';
import { ORG, STORE, baseTables, bindTablet, mountEn, pageCtx, posClient } from './testKit';

// jsdom has no canvas: the ticket is "drawn" as a tiny fake picture, everything after that (ESC/POS bytes, the bridge call) is real
vi.mock('./printing/browser', () => ({
  browserDeps: () => ({
    draw: async () => ({
      width: 576,
      height: 8,
      rgba: () => new Uint8Array(576 * 8 * 4),
      jpeg: async () => new Uint8Array(),
    }),
    savePdf: () => {},
  }),
}));

afterEach(() => {
  cleanup();
  setDeviceBinding(null);
  vi.unstubAllGlobals();
});
beforeEach(async () => {
  await resetOfflineDb();
  localStorage.clear();
});
const ID = '11111111-1111-4111-8111-111111111111';
const seed = async () => {
  let o = newOrder({
    id: ID,
    orgId: ORG,
    storeId: STORE,
    number: 'A001',
    channel: 'dine-in',
    tableId: 't1',
    now: Date.now(),
  });
  o = addLine(o, {
    lineId: 'l1',
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
  await saveOrder(null, o);
};
const mount = () =>
  mountEn(
    <OrderPage ctx={pageCtx(posClient(baseTables()), { path: `/order/${ID}` })} orderId={ID} />,
  );
const remember = (printers: unknown) =>
  localStorage.setItem(
    `bestie-printers:${STORE}`,
    JSON.stringify({ printers, default_printer: null }),
  );
const kitchenPrinter = {
  id: 'hot',
  name: 'Hot kitchen',
  kind: 'network',
  paper: 80,
  cutter: true,
  drawer: false,
  bridge_url: 'http://192.168.1.77:9101/print',
  stations: ['kitchen'],
};

describe('kitchen tickets on the order screen', () => {
  it('"Send to kitchen" prints the ticket on the kitchen printer and the order still goes', async () => {
    bindTablet();
    await seed();
    remember([kitchenPrinter]);
    const f = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', f);
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Send to kitchen / bar' }));
    await waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe('http://192.168.1.77:9101/print');
    expect(await screen.findByRole('button', { name: 'Nothing new to send' })).toBeTruthy();
    expect(
      await screen.findByRole('button', { name: 'Print the kitchen ticket again' }),
    ).toBeTruthy();
  });

  it('a printer that fails is reported, and the order is still sent', async () => {
    bindTablet();
    await seed();
    remember([kitchenPrinter]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('x', { status: 502 })),
    );
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Send to kitchen / bar' }));
    expect(await screen.findByText(/did not print on Hot kitchen/)).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Nothing new to send' })).toBeTruthy();
  });

  it('with no ticket printer nothing is printed and nothing is said', async () => {
    bindTablet();
    await seed();
    const f = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', f);
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Send to kitchen / bar' }));
    expect(await screen.findByRole('button', { name: 'Nothing new to send' })).toBeTruthy();
    expect(f).not.toHaveBeenCalled();
    expect(screen.queryByText(/did not print/)).toBeNull();
  });

  it('"Print the kitchen ticket again" sends the latest batch once more and says so', async () => {
    bindTablet();
    await seed();
    remember([kitchenPrinter]);
    const f = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', f);
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Send to kitchen / bar' }));
    await waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    await userEvent.click(
      await screen.findByRole('button', { name: 'Print the kitchen ticket again' }),
    );
    await waitFor(() => expect(f).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('The ticket was sent to the printer')).toBeTruthy();
  });
});
