import { vi } from 'vitest';

/** Test double for the Supabase client: table rows in, recorded writes + RPC calls out. */
export type Write = { table: string; op: 'update' | 'insert'; values: unknown };
export type RpcCall = { fn: string; args: unknown };

export function fakeDb(
  tables: Record<string, unknown[]>,
  opts: {
    /** rows an update "touches" (0 = RLS refused it silently) */
    updatedRows?: number;
    rpc?: Record<string, { data?: unknown; error?: { code: string } | null }>;
    insertError?: { code: string } | null;
  } = {},
) {
  const writes: Write[] = [];
  const rpcs: RpcCall[] = [];
  const from = vi.fn((table: string) => {
    let op: 'select' | 'update' | 'insert' = 'select';
    const result = () => {
      if (op === 'insert') return { data: null, error: opts.insertError ?? null };
      if (op === 'update')
        return {
          data: Array.from({ length: opts.updatedRows ?? 1 }, () => ({ id: 'x' })),
          error: null,
        };
      return { data: tables[table] ?? [], error: null };
    };
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'is', 'gt', 'order', 'limit']) chain[m] = () => chain;
    chain.update = (values: unknown) => {
      op = 'update';
      writes.push({ table, op, values });
      return chain;
    };
    chain.insert = (values: unknown) => {
      op = 'insert';
      writes.push({ table, op, values });
      return chain;
    };
    chain.maybeSingle = async () => ({ data: (tables[table] ?? [])[0] ?? null, error: null });
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result()).then(resolve, reject);
    return chain;
  });
  const rpc = vi.fn(async (fn: string, args: unknown) => {
    rpcs.push({ fn, args });
    const r = opts.rpc?.[fn];
    return { data: r?.data ?? null, error: r?.error ?? null };
  });
  return { client: { from, rpc } as never, writes, rpcs };
}
