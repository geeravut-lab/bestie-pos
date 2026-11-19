import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Printer } from '@bestie/core';
import { STORE, bindTablet, mountEn, pageCtx, posClient, baseTables } from '../testKit';
import { setDeviceBinding } from '@bestie/offline';
import { PrintStationPage } from './PrintStationPage';
import type { Picture } from './print';
import { printStationTick } from './station';

vi.mock('./browser', () => ({
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
beforeEach(() => localStorage.clear());

const hot: Printer = {
  id: 'hot',
  name: 'Hot kitchen',
  kind: 'network',
  paperMm: 80,
  cutter: true,
  drawer: true,
  bridgeUrl: 'http://192.168.1.77:9101/print',
  stations: ['kitchen'],
};
const job = {
  id: 'j1',
  station: 'kitchen',
  printer_id: 'hot',
  order_number: 'QR001',
  table_name: 'T1',
  sent_at: '2026-11-19T05:00:00Z',
  lines: [{ quantity: 2, name_th: 'ผัดไทย', modifiers: [], seat: null, note: null }],
};
const rpcClient = (jobs: unknown[]) => {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    client: {
      rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        return { data: fn === 'claim_print_jobs' ? jobs : null, error: null };
      }),
    } as never,
  };
};
const deps = (ok: boolean) => () => ({
  draw: async (): Promise<Picture> => ({
    width: 576,
    height: 8,
    rgba: () => new Uint8Array(576 * 8 * 4),
    jpeg: async () => new Uint8Array(),
  }),
  savePdf: vi.fn(),
  env: { navigator: {}, fetch: (async () => ({ ok })) as never },
});

describe('printStationTick', () => {
  it('claims the jobs of the served printers, prints them without opening the drawer, and reports success', async () => {
    const c = rpcClient([job]);
    const res = await printStationTick({
      client: c.client,
      storeId: 's',
      served: [hot],
      deps: deps(true),
    });
    expect(res).toEqual([expect.objectContaining({ jobId: 'j1', ok: true })]);
    expect(c.calls[0]).toEqual({
      fn: 'claim_print_jobs',
      args: { p_store: 's', p_printers: ['hot'], p_limit: 5 },
    });
    expect(c.calls[1]).toEqual({ fn: 'report_print_job', args: { p_job: 'j1', p_ok: true } });
  });
  it('a printer that refuses is reported as failed so the server can try again', async () => {
    const c = rpcClient([job]);
    const res = await printStationTick({
      client: c.client,
      storeId: 's',
      served: [hot],
      deps: deps(false),
    });
    expect(res[0]!.ok).toBe(false);
    expect(c.calls[1]).toEqual({ fn: 'report_print_job', args: { p_job: 'j1', p_ok: false } });
  });
  it('serving no printer asks for nothing; a lost connection is just an empty round', async () => {
    const c = rpcClient([job]);
    expect(await printStationTick({ client: c.client, storeId: 's', served: [] })).toEqual([]);
    expect(c.calls).toEqual([]);
    const broken = { rpc: async () => Promise.reject(new Error('offline')) } as never;
    expect(
      await printStationTick({ client: broken, storeId: 's', served: [hot], deps: deps(true) }),
    ).toEqual([]);
  });
});

describe('<PrintStationPage>', () => {
  it('lists the ticket printers, remembers which ones it serves, then claims and prints', async () => {
    bindTablet();
    localStorage.setItem(
      `bestie-printers:${STORE}`,
      JSON.stringify({
        printers: [
          {
            id: 'hot',
            name: 'Hot kitchen',
            kind: 'network',
            paper: 80,
            bridge_url: hot.bridgeUrl,
            stations: ['kitchen'],
          },
        ],
      }),
    );
    const base = posClient(baseTables());
    const claims: unknown[] = [];
    const client = {
      ...(base as object),
      rpc: vi.fn(async (fn: string) => {
        claims.push(fn);
        return { data: fn === 'claim_print_jobs' && claims.length === 1 ? [job] : [], error: null };
      }),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('ok')),
    );
    mountEn(<PrintStationPage ctx={pageCtx(client)} pollMs={50} />);
    await userEvent.click(await screen.findByRole('checkbox', { name: /Hot kitchen/ }));
    expect(localStorage.getItem(`bestie-print-station:${STORE}`)).toBe('["hot"]');
    expect(await screen.findByText('Ticket QR001 printed on Hot kitchen')).toBeTruthy();
    await waitFor(() => expect(claims).toContain('report_print_job'));
  });
});
