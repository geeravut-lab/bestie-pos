import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Printer } from '@bestie/core';
import { STORE, mountEn, pageCtx } from '../testKit';
import { OpenDrawer, drawerPrinter } from './OpenDrawer';
import type { PrintEnv } from './drivers';

afterEach(cleanup);
beforeEach(() => localStorage.clear());

const mk = (id: string, kind: Printer['kind'], drawer: boolean): Printer => ({
  id,
  name: id,
  kind,
  paperMm: 80,
  cutter: true,
  drawer,
  ...(kind === 'network' ? { bridgeUrl: 'http://192.168.1.5:9101/print' } : {}),
});
const all = {
  pdf: true,
  browser: true,
  network: true,
  usb: false,
  serial: false,
  bluetooth: false,
};

describe('drawerPrinter', () => {
  it('prefers this tablet’s printer when it has the drawer, else any usable printer with the drawer ticked, never the PDF', () => {
    const pdf = mk('pdf', 'pdf', true);
    const net = mk('hot', 'network', true);
    const usb = mk('usb1', 'usb', true);
    expect(drawerPrinter([pdf, net], net, all)).toBe(net);
    expect(
      drawerPrinter([pdf, mk('c', 'network', false), net], mk('c', 'network', false), all),
    ).toBe(net);
    expect(drawerPrinter([pdf, usb], usb, all)).toBeNull(); // this browser cannot reach USB
    expect(drawerPrinter([pdf], pdf, all)).toBeNull();
  });
});

describe('<OpenDrawer>', () => {
  const client = (rpc: ReturnType<typeof vi.fn>) =>
    ({
      rpc,
      from: () => {
        const c: Record<string, unknown> = {};
        for (const m of ['select', 'eq']) c[m] = () => c;
        c.maybeSingle = async () => ({
          data: {
            printers: [
              {
                id: 'counter',
                name: 'Counter',
                kind: 'network',
                paper: 80,
                drawer: true,
                bridge_url: 'http://192.168.1.5:9101/print',
              },
            ],
            default_printer: 'counter',
          },
          error: null,
        });
        return c;
      },
    }) as never;
  const env = (ok: boolean) => {
    const posted: Uint8Array[] = [];
    const e: PrintEnv = {
      navigator: {},
      fetch: (async (_u: unknown, init?: RequestInit) => {
        posted.push(init!.body as Uint8Array);
        return { ok };
      }) as never,
    };
    return { e, posted };
  };

  it('sends ONLY the drawer pulse to the printer and records it', async () => {
    const rpc = vi.fn(async () => ({ data: 1, error: null }));
    const { e, posted } = env(true);
    mountEn(
      <OpenDrawer
        ctx={pageCtx(client(rpc), { permissions: ['drawer.open'] })}
        storeId={STORE}
        deviceId="dev-1"
        env={e}
      />,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Open the cash drawer' }));
    expect(await screen.findByText(/Open command sent/)).toBeTruthy();
    expect(Array.from(posted[0]!)).toEqual([0x1b, 0x40, 0x1b, 0x70, 0x00, 0x19, 0xfa]); // no receipt, just ESC p
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    expect(
      (rpc.mock.calls[0] as unknown as [string, { p_device: string; p_times: string[] }])[1]
        .p_device,
    ).toBe('dev-1');
    expect(localStorage.getItem('bestie-drawer-pending')).toBeNull();
  });

  it('an opening made offline is kept and reported with the next one', async () => {
    const rpc = vi.fn(async () => {
      throw new Error('offline');
    });
    const { e } = env(true);
    mountEn(
      <OpenDrawer
        ctx={pageCtx(client(rpc), { permissions: ['drawer.open'] })}
        storeId={STORE}
        deviceId="dev-1"
        env={e}
      />,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Open the cash drawer' }));
    await screen.findByText(/Open command sent/);
    expect(JSON.parse(localStorage.getItem('bestie-drawer-pending')!)).toHaveLength(1);
    const ok = vi.fn(async () => ({ data: 2, error: null }));
    cleanup();
    mountEn(
      <OpenDrawer
        ctx={pageCtx(client(ok), { permissions: ['drawer.open'] })}
        storeId={STORE}
        deviceId="dev-1"
        env={e}
      />,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Open the cash drawer' }));
    await waitFor(() => expect(ok).toHaveBeenCalled());
    expect(
      (ok.mock.calls[0] as unknown as [string, { p_times: string[] }])[1].p_times,
    ).toHaveLength(2);
    await waitFor(() => expect(localStorage.getItem('bestie-drawer-pending')).toBeNull());
  });

  it('says so when the printer fails or no printer has a drawer, and is hidden without drawer.open', async () => {
    const rpc = vi.fn(async () => ({ data: 1, error: null }));
    mountEn(
      <OpenDrawer
        ctx={pageCtx(client(rpc), { permissions: ['drawer.open'] })}
        storeId={STORE}
        deviceId="dev-1"
        env={env(false).e}
      />,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Open the cash drawer' }));
    expect(await screen.findByText(/did not open/)).toBeTruthy();
    expect(rpc).not.toHaveBeenCalled(); // nothing opened, nothing recorded
    cleanup();
    mountEn(
      <OpenDrawer
        ctx={pageCtx(client(rpc), { permissions: ['order.create', 'payment.take'] })}
        storeId={STORE}
        deviceId="dev-1"
      />,
    );
    expect(screen.queryByRole('button', { name: 'Open the cash drawer' })).toBeNull();
  });
});
