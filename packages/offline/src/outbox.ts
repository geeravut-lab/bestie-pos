import type { SupabaseClient } from '@supabase/supabase-js';
import { CONFLICT_CODE, afterFailure, classifyFailure, nextStep } from '@bestie/core';
import type { OutboxEntry, OutboxOp, RemoteError } from '@bestie/core';
import { db } from './db';

/** The only thing the sync engine needs from Supabase — easy to fake in tests. */
export type RemoteClient = Pick<SupabaseClient, 'from' | 'rpc'>;

/** Store a write locally FIRST; it is replayed to the server in order. Returns the entry id (the idempotency key). */
export async function enqueue(op: OutboxOp, now: () => number = Date.now): Promise<string> {
  const id = crypto.randomUUID();
  await db.outbox.add({ id, op, createdAt: now(), attempts: 0, nextTryAt: 0, status: 'pending' });
  return id;
}

export const listOutbox = () => db.outbox.orderBy('createdAt').toArray();

export async function outboxCounts(): Promise<{ pending: number; dead: number }> {
  const all = await db.outbox.toArray();
  return {
    pending: all.filter((e) => e.status === 'pending').length,
    dead: all.filter((e) => e.status === 'dead').length,
  };
}

/** A person looked at a refused write and wants it tried again (e.g. after fixing a permission). */
export const retryDead = (id: string) =>
  db.outbox.update(id, { status: 'pending', attempts: 0, nextTryAt: 0, lastError: undefined });
/** A person decided a refused write should be dropped. */
export const discardDead = (id: string) => db.outbox.delete(id);

async function send(client: RemoteClient, op: OutboxOp): Promise<RemoteError> {
  try {
    if (op.kind === 'insert') {
      const { error } = await client.from(op.table).insert(op.values);
      return error;
    }
    if (op.kind === 'update') {
      const { data, error } = await client
        .from(op.table)
        .update(op.values)
        .eq('id', op.id)
        .select('id');
      if (error) return error;
      // RLS or a delete elsewhere hides the row: nothing was changed — that is a refusal, not a success
      return data?.length === 1 ? null : { code: CONFLICT_CODE };
    }
    const { error } = await client.rpc(op.fn, op.args);
    return error;
  } catch (e) {
    return { message: e instanceof Error ? e.message : 'network' }; // fetch threw: offline
  }
}

export type FlushResult = { sent: number; pending: number; dead: number; blocked: boolean };

let running: Promise<FlushResult> | null = null;

/**
 * Replay the queue in order. A network / server failure stops the run (order matters, try again later); a refusal marks
 * only that entry dead and the rest go on. Never throws. One run at a time per tab, and per browser when Web Locks exist.
 */
export function flush(
  client: RemoteClient,
  opts: { now?: () => number; rand?: () => number } = {},
): Promise<FlushResult> {
  if (running) return running;
  const run = async (): Promise<FlushResult> => {
    const now = opts.now ?? Date.now;
    let sent = 0;
    let blocked = false;
    for (let guard = 0; guard < 500; guard++) {
      const entries = await db.outbox.toArray();
      const step = nextStep(entries, now());
      if (step.type === 'idle') break;
      if (step.type === 'wait') {
        blocked = true;
        break;
      }
      const err = await send(client, step.entry.op);
      if (!err) {
        await db.outbox.delete(step.entry.id);
        sent++;
        continue;
      }
      const cls = classifyFailure(step.entry.op, err);
      if (cls === 'applied') {
        await db.outbox.delete(step.entry.id);
        sent++;
        continue;
      }
      const code = err.code ?? (err.status ? `http_${err.status}` : 'network');
      const updated: OutboxEntry = afterFailure(step.entry, cls, now(), code, opts.rand);
      await db.outbox.put(updated);
      if (cls === 'retry' && updated.status === 'pending') {
        blocked = true;
        break; // keep order: nothing behind this entry may overtake it
      }
    }
    return { sent, ...(await outboxCounts()), blocked };
  };
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  const guarded: Promise<FlushResult> = locks
    ? locks
        .request('bestie-outbox-flush', { ifAvailable: true }, async (lock) =>
          lock ? run() : { sent: 0, ...(await outboxCounts()), blocked: true },
        )
        .then((r) => r as FlushResult)
    : run();
  running = guarded.finally(() => {
    running = null;
  });
  return running;
}
