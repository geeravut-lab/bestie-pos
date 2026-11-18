import { beforeEach, describe, expect, it } from 'vitest';
import { closeShift, openShift } from '@bestie/core';
import {
  flush,
  getOpenShift,
  listClosedShifts,
  listOutbox,
  pullShifts,
  resetOfflineDb,
  saveShift,
} from './index';
import type { RemoteClient } from './index';

beforeEach(async () => {
  await resetOfflineDb();
});

const NOW = Date.UTC(2026, 10, 18, 3, 0);
const shift = () =>
  openShift({
    id: 's1',
    orgId: 'o',
    storeId: 'st',
    deviceId: 'dev',
    openedBy: 'p',
    openingCash: 100000,
    now: NOW,
  });

describe('shifts on the tablet', () => {
  it('opening saves the shift and queues exactly one open_shift call', async () => {
    await saveShift(shift(), 'open', 'p');
    expect((await getOpenShift('dev'))?.openingCash).toBe(100000);
    const q = await listOutbox();
    expect(q).toHaveLength(1);
    expect(q[0]!.op).toMatchObject({
      kind: 'rpc',
      fn: 'open_shift',
      args: {
        p: {
          id: 's1',
          device_id: 'dev',
          opening_cash: 100000,
          opened_at: '2026-11-18T03:00:00.000Z',
        },
      },
    });
  });

  it('closing keeps it as history, queues close_shift after open_shift, and both reach the server in order', async () => {
    const s = shift();
    await saveShift(s, 'open', 'p');
    const closed = closeShift(s, {
      countedCash: 123500,
      expectedCash: 124000,
      now: NOW + 3_600_000,
    });
    await saveShift(closed, 'close', 'p');
    expect(await getOpenShift('dev')).toBeNull();
    expect((await listClosedShifts('dev'))[0]).toMatchObject({ variance: -500 });
    const seen: string[] = [];
    const client = {
      from: () => ({}),
      rpc: async (fn: string, args: unknown) => (
        seen.push(
          `${fn}:${JSON.stringify((args as { p: { counted_cash?: number } }).p.counted_cash ?? '')}`,
        ),
        { error: null }
      ),
    } as unknown as RemoteClient;
    await flush(client);
    expect(seen).toEqual(['open_shift:""', 'close_shift:123500']);
  });

  it('a wiped tablet learns about the shift that is open on the server, but never overwrites local work', async () => {
    const row = {
      id: 's9',
      org_id: 'o',
      store_id: 'st',
      device_id: 'dev',
      opened_at: '2026-11-18T03:00:00Z',
      opening_cash: '50000',
      status: 'open',
    };
    const server = {
      from: () => {
        const c: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'order', 'limit']) c[m] = () => c;
        c.then = (r: (v: unknown) => unknown) =>
          Promise.resolve({ data: [row], error: null }).then(r);
        return c;
      },
    } as unknown as Pick<RemoteClient, 'from'>;
    await pullShifts(server, 'dev');
    expect((await getOpenShift('dev'))?.id).toBe('s9');
    await resetOfflineDb();
    await saveShift(shift(), 'open', 'p'); // something is waiting to be sent
    await pullShifts(server, 'dev');
    expect((await getOpenShift('dev'))?.id).toBe('s1');
  });
});
