/**
 * Offline-first write queue — the PURE rules (CLAUDE.md rule 5, docs/DECISIONS.md "Offline-first").
 *
 * Every write made on a tablet is first stored locally as an `OutboxEntry` with a client-generated uuid, then replayed
 * to the server in order. This file decides: what counts as "already applied", what is worth retrying, how long to wait,
 * and which conflict rule each kind of data follows. IndexedDB and the network live in `@bestie/offline`.
 */

export type OutboxOp =
  | { kind: 'insert'; table: string; values: Record<string, unknown> }
  | { kind: 'update'; table: string; id: string; values: Record<string, unknown> }
  | { kind: 'rpc'; fn: string; args: Record<string, unknown> };

export type OutboxStatus = 'pending' | 'dead';

export type OutboxEntry = {
  /** uuid made on the device; also the idempotency key. */
  id: string;
  op: OutboxOp;
  createdAt: number; // ms since epoch — replay order
  attempts: number;
  /** Earliest time the next try may happen (ms). */
  nextTryAt: number;
  status: OutboxStatus;
  /** Last failure, a short code only (never a payload — it may contain customer data). */
  lastError?: string;
};

/** What a failed attempt means. */
export type FailureClass =
  | 'applied' // the server already has it (duplicate key on an insert): treat as success
  | 'retry' // network / server trouble: try again later, keep order
  | 'dead'; // the server refused it for good (permission, validation, conflict): keep for a human, do not block the queue

export type RemoteError = { code?: string; status?: number; message?: string } | null | undefined;

/**
 * PostgREST / Postgres codes:
 *  23505 unique violation → an insert replayed twice: the first one won → applied
 *  42501 insufficient privilege / RLS, 23xxx constraint, 22xxx data, P0xxx raised → refused for good
 *  anything without a code, 5xx, 408, 429, "Failed to fetch", PGRST301 (JWT expired) → retry
 */
/** Not a database code: our own marker for "the update touched no row" (hidden by RLS or deleted elsewhere). */
export const CONFLICT_CODE = 'BESTIE_CONFLICT';

export function classifyFailure(op: OutboxOp, err: RemoteError): FailureClass {
  if (!err) return 'retry';
  const code = err.code ?? '';
  if (code === CONFLICT_CODE) return 'dead';
  if (code === '23505' && op.kind === 'insert') return 'applied';
  if (code === 'PGRST301' || code === 'PGRST303') return 'retry'; // expired session: sign in again, the queue keeps waiting
  if (/^(42|23|22|P0|PGRST1|PGRST2)/.test(code)) return 'dead';
  const status = err.status ?? 0;
  if (status === 408 || status === 429 || status >= 500) return 'retry';
  if (status >= 400 && status < 500) return 'dead';
  return 'retry';
}

export const MAX_ATTEMPTS = 12;
const BASE_DELAY_MS = 2_000;
const MAX_DELAY_MS = 5 * 60_000;

/** 2 s, 4 s, 8 s … capped at 5 min, with ±20 % jitter so a shop's devices do not all knock at once. `rand` is injectable. */
export function retryDelayMs(attempts: number, rand: () => number = Math.random): number {
  const exp = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1));
  return Math.round(exp * (0.8 + 0.4 * rand()));
}

export type FlushStep =
  | { type: 'wait'; entry: OutboxEntry } // head of the queue is not due yet: stop (order must be kept)
  | { type: 'send'; entry: OutboxEntry }
  | { type: 'idle' };

/** Strict FIFO over entries that are not dead. A head that is still waiting blocks the ones behind it. */
export function nextStep(entries: readonly OutboxEntry[], now: number): FlushStep {
  const live = entries
    .filter((e) => e.status === 'pending')
    .sort((a, b) => a.createdAt - b.createdAt);
  const head = live[0];
  if (!head) return { type: 'idle' };
  return head.nextTryAt > now ? { type: 'wait', entry: head } : { type: 'send', entry: head };
}

/** The entry after a failed attempt: later retry, or dead when it keeps failing. */
export function afterFailure(
  entry: OutboxEntry,
  cls: Exclude<FailureClass, 'applied'>,
  now: number,
  code: string,
  rand: () => number = Math.random,
): OutboxEntry {
  const attempts = entry.attempts + 1;
  if (cls === 'dead' || attempts >= MAX_ATTEMPTS) {
    return { ...entry, attempts, status: 'dead', lastError: code.slice(0, 40) };
  }
  return {
    ...entry,
    attempts,
    nextTryAt: now + retryDelayMs(attempts, rand),
    lastError: code.slice(0, 40),
  };
}

// ── conflict rules (one per kind of data) ───────────────────────────────────
/**
 * - `insert-once`   created on one device with a fresh uuid; replays are harmless (orders, order lines, payments requests)
 * - `last-write-wins` a screen edit where the newest edit is what the owner wants (menu, settings)
 * - `server-wins`   the server decides and the device only asks (payment confirmation, stock, Credit / Points balances):
 *                   the device never writes these directly, it calls an RPC and takes the answer
 */
export type ConflictRule = 'insert-once' | 'last-write-wins' | 'server-wins';

export const CONFLICT_RULES: Readonly<Record<string, ConflictRule>> = {
  orders: 'insert-once',
  order_lines: 'insert-once',
  order_events: 'insert-once',
  menu_categories: 'last-write-wins',
  menu_items: 'last-write-wins',
  modifier_groups: 'last-write-wins',
  modifier_options: 'last-write-wins',
  payments: 'server-wins',
  credit_ledger: 'server-wins',
  points_ledger: 'server-wins',
};

/** Unknown tables get the safest rule: the server decides. */
export const conflictRuleFor = (table: string): ConflictRule =>
  CONFLICT_RULES[table] ?? 'server-wins';

/** What the sync indicator shows. */
export type SyncState = 'offline' | 'syncing' | 'attention' | 'queued' | 'synced';
export function syncState(s: {
  online: boolean;
  syncing: boolean;
  pending: number;
  dead: number;
}): SyncState {
  if (!s.online) return 'offline';
  if (s.dead > 0) return 'attention';
  if (s.syncing) return 'syncing';
  return s.pending > 0 ? 'queued' : 'synced';
}
