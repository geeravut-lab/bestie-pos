import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  discardDead,
  enqueue,
  flush,
  listOutbox,
  outboxCounts,
  resetOfflineDb,
  retryDead,
} from './index';
import type { RemoteClient } from './index';

type Reply = {
  error?: { code?: string; status?: number; message?: string } | null;
  data?: unknown;
};

/** A fake Supabase client that answers from a script and remembers what it was asked. */
function fake(
  script: (call: { kind: string; table?: string; fn?: string; values?: unknown }) => Reply,
) {
  const calls: { kind: string; table?: string; fn?: string; values?: unknown }[] = [];
  const reply = (c: { kind: string; table?: string; fn?: string; values?: unknown }) => {
    calls.push(c);
    return script(c);
  };
  const client = {
    from: (table: string) => ({
      insert: async (values: unknown) => ({
        error: reply({ kind: 'insert', table, values }).error ?? null,
      }),
      update: (values: unknown) => ({
        eq: () => ({
          select: async () => {
            const r = reply({ kind: 'update', table, values });
            return { data: r.error ? null : (r.data ?? [{ id: 'x' }]), error: r.error ?? null };
          },
        }),
      }),
    }),
    rpc: async (fn: string, args: unknown) => ({
      error: reply({ kind: 'rpc', fn, values: args }).error ?? null,
    }),
  } as unknown as RemoteClient;
  return { client, calls };
}

beforeEach(async () => {
  await resetOfflineDb();
});

describe('outbox', () => {
  it('stores a write locally first, with a client uuid, before anything is sent', async () => {
    const id = await enqueue({ kind: 'insert', table: 'orders', values: { id: 'o1' } });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await outboxCounts()).toEqual({ pending: 1, dead: 0 });
  });

  it('replays in the order the writes were made and empties the queue', async () => {
    let t = 1000;
    const now = () => t++;
    await enqueue({ kind: 'insert', table: 'orders', values: { id: 'a' } }, now);
    await enqueue({ kind: 'insert', table: 'order_lines', values: { id: 'b' } }, now);
    await enqueue({ kind: 'rpc', fn: 'send_to_kitchen', args: { p_order: 'a' } }, now);
    const { client, calls } = fake(() => ({}));
    const r = await flush(client);
    expect(calls.map((c) => c.table ?? c.fn)).toEqual(['orders', 'order_lines', 'send_to_kitchen']);
    expect(r).toMatchObject({ sent: 3, pending: 0, dead: 0, blocked: false });
  });

  it('a network failure stops the run, keeps the entry, and nothing behind it overtakes it', async () => {
    let t = 1;
    const now = () => t++;
    await enqueue({ kind: 'insert', table: 'orders', values: { id: 'a' } }, now);
    await enqueue({ kind: 'insert', table: 'order_lines', values: { id: 'b' } }, now);
    const { client, calls } = fake(() => ({ error: { message: 'Failed to fetch' } }));
    const r = await flush(client, { now: () => 10_000, rand: () => 0.5 });
    expect(calls).toHaveLength(1);
    expect(r).toMatchObject({ sent: 0, pending: 2, blocked: true });
    const [head] = await listOutbox();
    expect(head).toMatchObject({ attempts: 1, status: 'pending', nextTryAt: 12_000 });
  });

  it('waits for the retry time, then sends', async () => {
    await enqueue({ kind: 'insert', table: 'orders', values: { id: 'a' } }, () => 1);
    let fail = true;
    const { client, calls } = fake(() => (fail ? { error: { status: 503 } } : {}));
    await flush(client, { now: () => 10_000, rand: () => 0.5 });
    fail = false;
    const early = await flush(client, { now: () => 10_500 });
    expect(early.blocked).toBe(true);
    expect(calls).toHaveLength(1); // not even tried yet
    const later = await flush(client, { now: () => 13_000 });
    expect(later).toMatchObject({ sent: 1, pending: 0 });
  });

  it('a duplicate-key answer to an insert means "already there": removed, not retried', async () => {
    await enqueue({ kind: 'insert', table: 'orders', values: { id: 'a' } });
    const { client } = fake(() => ({
      error: {
        code: '23505',
        message: 'duplicate key value violates unique constraint "orders_pkey"',
      },
    }));
    expect(await flush(client)).toMatchObject({ sent: 1, pending: 0, dead: 0 });
  });

  it('a refusal marks only that entry dead; the rest still go through', async () => {
    let t = 1;
    const now = () => t++;
    await enqueue({ kind: 'insert', table: 'orders', values: { id: 'bad' } }, now);
    await enqueue({ kind: 'insert', table: 'orders', values: { id: 'good' } }, now);
    const { client, calls } = fake((c) =>
      (c.values as { id: string }).id === 'bad' ? { error: { code: '42501' } } : {},
    );
    const r = await flush(client);
    expect(calls).toHaveLength(2);
    expect(r).toMatchObject({ sent: 1, pending: 0, dead: 1 });
    const [dead] = await listOutbox();
    expect(dead).toMatchObject({ status: 'dead', lastError: '42501' });
  });

  it('an update that touches no row is a refusal, not a success', async () => {
    await enqueue({ kind: 'update', table: 'menu_items', id: 'i1', values: { available: false } });
    const { client } = fake(() => ({ data: [] }));
    expect(await flush(client)).toMatchObject({ sent: 0, dead: 1 });
  });

  it('a dead entry can be retried or discarded by a person', async () => {
    const id = await enqueue({ kind: 'insert', table: 'orders', values: { id: 'a' } });
    const { client } = fake(() => ({ error: { code: '42501' } }));
    await flush(client);
    await retryDead(id);
    expect(await outboxCounts()).toEqual({ pending: 1, dead: 0 });
    await flush(client);
    await discardDead(id);
    expect(await outboxCounts()).toEqual({ pending: 0, dead: 0 });
  });

  it('two flushes at once send each write once', async () => {
    await enqueue({ kind: 'insert', table: 'orders', values: { id: 'a' } });
    const { client, calls } = fake(() => ({}));
    await Promise.all([flush(client), flush(client)]);
    expect(calls).toHaveLength(1);
  });

  it('a fetch that THROWS (airplane mode) is treated as offline, never an unhandled error', async () => {
    await enqueue({ kind: 'insert', table: 'orders', values: { id: 'a' } });
    const client = {
      from: () => ({
        insert: vi.fn(async () => {
          throw new TypeError('Failed to fetch');
        }),
      }),
      rpc: vi.fn(),
    } as unknown as RemoteClient;
    expect(await flush(client)).toMatchObject({ sent: 0, pending: 1, blocked: true });
  });

  it('sends RPC writes with their arguments', async () => {
    await enqueue({ kind: 'rpc', fn: 'verify_staff_pin', args: { p_staff: 's1' } });
    const { client, calls } = fake(() => ({}));
    await flush(client);
    expect(calls[0]).toMatchObject({
      kind: 'rpc',
      fn: 'verify_staff_pin',
      values: { p_staff: 's1' },
    });
  });
});
