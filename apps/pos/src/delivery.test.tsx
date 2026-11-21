import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageContext } from '@bestie/auth';
import { I18nProvider } from '@bestie/i18n';
import type { OnlinePay } from './onlinePay';
import { OrderDelivery } from './OrderDelivery';
import { PaySheet } from './PaySheet';

afterEach(cleanup);
const fakeDb = (
  _t: object,
  opts: { rpc?: Record<string, { error?: { code: string } | null }> } = {},
) => {
  const rpcs: { fn: string; args: unknown }[] = [];
  const client = {
    rpc: vi.fn(async (fn: string, args: unknown) => {
      rpcs.push({ fn, args });
      return { data: null, error: opts.rpc?.[fn]?.error ?? null };
    }),
  };
  return { client, rpcs };
};
const wrap = (ui: React.ReactNode) => render(<I18nProvider initialLang="en">{ui}</I18nProvider>);

const online: OnlinePay = {
  available: true,
  hasReader: false,
  start: vi.fn(),
  cancel: vi.fn(),
  status: vi.fn(),
  findLive: vi.fn(async () => null),
  finish: vi.fn(),
} as unknown as OnlinePay;

describe('<PaySheet> Platform tab', () => {
  const sheet = (
    platform: { name: string | null; commissionBps: number } | null,
    onPlatformClose = vi.fn(async () => null),
  ) => {
    wrap(
      <PaySheet
        total={20000}
        rule="none"
        online={online}
        platform={platform}
        onPlatformClose={onPlatformClose}
        onPay={async () => null}
        onClose={() => {}}
      />,
    );
    return onPlatformClose;
  };
  it('is offered only for a delivery bill', () => {
    sheet(null);
    expect(screen.queryByRole('tab', { name: 'Platform pays' })).toBeNull();
  });
  it('shows what the platform keeps and closes the bill', async () => {
    const close = sheet({ name: 'Grab', commissionBps: 2500 });
    await userEvent.click(screen.getByRole('tab', { name: 'Platform pays' }));
    expect(screen.getByText(/The platform keeps about ฿50; the shop gets about ฿150/)).toBeTruthy();
    await userEvent.click(
      screen.getByRole('button', { name: 'Close the bill — Grab pays the shop later' }),
    );
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });
  it('asks for a platform first when the bill has none', async () => {
    const close = sheet({ name: null, commissionBps: 0 });
    await userEvent.click(screen.getByRole('tab', { name: 'Platform pays' }));
    expect(screen.getByText(/Choose this bill’s platform first/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Close the bill/ })).toBeNull();
    expect(close).not.toHaveBeenCalled();
  });
  it('shows the error when the server refuses', async () => {
    const close = vi.fn(async () => 'err_pay_failed' as const);
    sheet({ name: 'Grab', commissionBps: 0 }, close as never);
    await userEvent.click(screen.getByRole('tab', { name: 'Platform pays' }));
    await userEvent.click(screen.getByRole('button', { name: /Close the bill/ }));
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});

describe('<OrderDelivery>', () => {
  const ctx = (client: unknown): PageContext => ({
    path: '/order/o1',
    navigate: () => {},
    client: client as never,
    orgId: 'o1',
    storeId: 's1',
    permissions: ['order.create'],
    isOwner: false,
    isPlatformAdmin: false,
  });
  const bill = (over: Record<string, unknown> = {}) => ({
    platforms: [
      {
        id: 'p1',
        code: 'lineman' as const,
        name: 'LINE MAN',
        commissionBps: 3000,
        active: true,
        tokenHint: null,
      },
      {
        id: 'p2',
        code: 'grab' as const,
        name: 'Grab',
        commissionBps: 2500,
        active: true,
        tokenHint: null,
      },
    ],
    info: { platformId: null, ref: null, name: null, phone: null, address: null },
    ...over,
  });
  it('saves the platform, its order number and the customer', async () => {
    const db = fakeDb({});
    const reload = vi.fn();
    wrap(<OrderDelivery ctx={ctx(db.client)} orderId="o1" bill={bill()} reload={reload} online />);
    expect(
      (screen.getByRole('button', { name: 'Save the delivery details' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await userEvent.selectOptions(screen.getByLabelText('Platform'), 'p2');
    await userEvent.type(screen.getByLabelText('The platform’s order number'), 'GF-77');
    await userEvent.type(screen.getByLabelText('Customer name'), 'Mia');
    await userEvent.click(screen.getByRole('button', { name: 'Save the delivery details' }));
    await waitFor(() => expect(db.rpcs.length).toBe(1));
    expect(db.rpcs[0]).toEqual({
      fn: 'set_delivery_info',
      args: {
        p: {
          order_id: 'o1',
          platform_id: 'p2',
          external_ref: 'GF-77',
          name: 'Mia',
          phone: null,
          address: null,
        },
      },
    });
    expect(await screen.findByText('Saved')).toBeTruthy();
    expect(reload).toHaveBeenCalled();
  });
  it('says when the order number is already used', async () => {
    const db = fakeDb({}, { rpc: { set_delivery_info: { error: { code: '23505' } } } });
    wrap(
      <OrderDelivery
        ctx={ctx(db.client)}
        orderId="o1"
        bill={bill({
          info: { platformId: 'p2', ref: 'GF-77', name: null, phone: null, address: null },
        })}
        reload={() => {}}
        online
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save the delivery details' }));
    expect(
      await screen.findByText('That order number is already used for this platform.'),
    ).toBeTruthy();
  });
  it('needs the internet, and the list is empty without platforms', () => {
    const db = fakeDb({});
    wrap(
      <OrderDelivery
        ctx={ctx(db.client)}
        orderId="o1"
        bill={bill({ platforms: [] })}
        reload={() => {}}
        online={false}
      />,
    );
    expect(screen.getByText(/No platform yet/)).toBeTruthy();
    expect(screen.getByText('Saving delivery details needs the internet.')).toBeTruthy();
  });
});
