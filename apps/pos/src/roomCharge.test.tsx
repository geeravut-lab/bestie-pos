import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addLine, newOrder, sendNew } from '@bestie/core';
import { getOrder, resetOfflineDb, saveOrder, setDeviceBinding } from '@bestie/offline';
import { PaySheet } from './PaySheet';
import { chargeOrderToRoom } from './onlinePay';
import type { OnlinePay } from './onlinePay';
import { ORG, STORE, bindTablet, mountEn, posClient } from './testKit';

afterEach(() => {
  cleanup();
  setDeviceBinding(null);
});
beforeEach(async () => {
  await resetOfflineDb();
  localStorage.clear();
});

const online = (): OnlinePay => ({
  available: true,
  hasReader: false,
  start: async () => ({ error: 'err_pay_failed' }),
  cancel: async () => {},
  status: async () => null,
  findLive: async () => null,
  finish: async () => {},
});

describe('<PaySheet> Room tab', () => {
  it('shows the Room tab only when guests are staying, and charges the chosen stay', async () => {
    mountEn(
      <PaySheet
        total={21000}
        rule="none"
        online={online()}
        onPay={async () => null}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByRole('tab', { name: 'Charge to room' })).toBeNull();
    cleanup();
    const onRoomCharge = vi.fn(async () => null);
    mountEn(
      <PaySheet
        total={21000}
        rule="none"
        online={online()}
        onPay={async () => null}
        roomStays={[
          { id: 'f1', label: '101 · Anna' },
          { id: 'f2', label: '102 · Bob' },
        ]}
        onRoomCharge={onRoomCharge}
        onClose={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole('tab', { name: 'Charge to room' }));
    await userEvent.selectOptions(screen.getByLabelText('The guest’s room'), 'f2');
    await userEvent.click(screen.getByRole('button', { name: 'Charge to this room' }));
    expect(onRoomCharge).toHaveBeenCalledWith('f2', 21000);
  });

  it('shows the refusal and keeps the sheet', async () => {
    mountEn(
      <PaySheet
        total={21000}
        rule="none"
        online={online()}
        onPay={async () => null}
        roomStays={[{ id: 'f1', label: '101 · Anna' }]}
        onRoomCharge={async () => 'err_pay_failed'}
        onClose={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole('tab', { name: 'Charge to room' }));
    await userEvent.click(screen.getByRole('button', { name: 'Charge to this room' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});

/** A client whose every table call succeeds (the queued writes of the seeded bill go through). */
const okClient = () => {
  const base = posClient({});
  const chain: unknown = new Proxy(() => {}, {
    get: (_t, k) =>
      k === 'then'
        ? (res: (v: unknown) => unknown) =>
            Promise.resolve({ data: [{ id: 'x' }], error: null }).then(res)
        : () => chain,
    apply: () => chain,
  });
  return Object.assign(base, { from: () => chain });
};

describe('chargeOrderToRoom', () => {
  const ID = '22222222-2222-4222-8222-222222222222';
  const seed = async () => {
    let o = newOrder({
      id: ID,
      orgId: ORG,
      storeId: STORE,
      number: 'A001',
      channel: 'takeaway',
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
      quantity: 2,
    });
    o = sendNew(o, Date.now()).order;
    await saveOrder(null, o);
  };
  const config = {
    vatBps: 700,
    serviceChargeBps: 0,
    priceMode: 'inclusive' as const,
    vatRegistered: true,
  };

  it('sends the exact bill, the stay and no rounding to the server', async () => {
    bindTablet();
    await seed();
    const client = okClient();
    const binding = {
      deviceId: 'dev-1',
      storeId: STORE,
      orgId: ORG,
      name: 'Counter',
      code: 'A',
      role: 'cashier',
      station: null,
      posId: 'POS-77',
      reader: false,
    } as never;
    const err = await chargeOrderToRoom({
      client: client as never,
      orderId: ID,
      binding,
      billConfig: config as never,
      folioId: 'f1',
      staffId: 's1',
      lang: 'en',
    });
    expect(err).toBeNull();
    const call = (
      client.rpc.mock.calls as unknown as [string, { p: Record<string, unknown> }][]
    ).find((c) => c[0] === 'charge_order_to_room')!;
    expect(call[1].p).toMatchObject({
      order_id: ID,
      folio_id: 'f1',
      subtotal: 16000,
      total: 16000,
      payable: 16000,
      rounding: 0,
      vat_bps: 700,
    });
    expect(String(call[1].p.payment_id)).toMatch(/[0-9a-f-]{20,}/);
    await waitFor(async () => expect(await getOrder(ID)).toBeTruthy());
  });

  it('maps a refusal to a message and does nothing offline', async () => {
    bindTablet();
    await seed();
    const client = okClient();
    client.rpc.mockImplementation(async () => ({ data: null, error: { code: '42501' } }) as never);
    const binding = {
      deviceId: 'dev-1',
      storeId: STORE,
      orgId: ORG,
      name: 'Counter',
      code: 'A',
      role: 'cashier',
      station: null,
      posId: 'POS-77',
      reader: false,
    } as never;
    const base = {
      client: client as never,
      orderId: ID,
      binding,
      billConfig: config as never,
      folioId: 'f1',
      lang: 'en' as const,
    };
    expect(await chargeOrderToRoom(base)).toBe('err_forbidden');
    vi.spyOn(globalThis.navigator, 'onLine', 'get').mockReturnValue(false);
    expect(await chargeOrderToRoom(base)).toBe('err_pay_offline');
    vi.restoreAllMocks();
  });
});

describe('<PaySheet> part of the bill on the room', () => {
  const mount = (onRoomCharge: (id: string, amount: number) => Promise<null>) =>
    mountEn(
      <PaySheet
        total={21000}
        rule="none"
        online={online()}
        roomStays={[{ id: 'f1', label: '101 · Anna' }]}
        onRoomCharge={onRoomCharge}
        onPay={async () => null}
        onClose={() => {}}
      />,
    );
  it('puts part on the room and says the rest is taken in cash', async () => {
    const charge = vi.fn(async () => null);
    mount(charge);
    await userEvent.click(screen.getByRole('tab', { name: 'Charge to room' }));
    const amount = screen.getByLabelText('Amount to put on the room (baht)');
    expect((amount as HTMLInputElement).value).toBe('210');
    await userEvent.clear(amount);
    await userEvent.type(amount, '120');
    expect(screen.getByText(/The remaining ฿90 is taken in cash now/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Charge to this room' }));
    await waitFor(() => expect(charge).toHaveBeenCalledWith('f1', 12000));
  });
  it('refuses an amount of zero or above the bill', async () => {
    const charge = vi.fn(async () => null);
    mount(charge);
    await userEvent.click(screen.getByRole('tab', { name: 'Charge to room' }));
    const amount = screen.getByLabelText('Amount to put on the room (baht)');
    await userEvent.clear(amount);
    await userEvent.type(amount, '500');
    expect(
      (screen.getByRole('button', { name: 'Charge to this room' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await userEvent.clear(amount);
    await userEvent.type(amount, '0');
    expect(
      (screen.getByRole('button', { name: 'Charge to this room' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(charge).not.toHaveBeenCalled();
  });
});
