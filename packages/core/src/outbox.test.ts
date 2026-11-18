import { describe, expect, it } from 'vitest';
import {
  MAX_ATTEMPTS,
  afterFailure,
  classifyFailure,
  conflictRuleFor,
  nextStep,
  retryDelayMs,
  syncState,
} from './outbox';
import type { OutboxEntry, OutboxOp } from './outbox';

const insert: OutboxOp = { kind: 'insert', table: 'orders', values: { id: 'a' } };
const update: OutboxOp = { kind: 'update', table: 'menu_items', id: 'a', values: {} };
const entry = (over: Partial<OutboxEntry> = {}): OutboxEntry => ({
  id: 'e1',
  op: insert,
  createdAt: 100,
  attempts: 0,
  nextTryAt: 0,
  status: 'pending',
  ...over,
});

describe('classifyFailure', () => {
  it('a replayed insert (duplicate PRIMARY key) counts as already applied — only for inserts', () => {
    const pk = 'duplicate key value violates unique constraint "orders_pkey"';
    expect(classifyFailure(insert, { code: '23505', message: pk })).toBe('applied');
    expect(classifyFailure(update, { code: '23505', message: pk })).toBe('dead');
  });
  it('a duplicate of some OTHER unique rule (two orders, same number) is never swallowed', () => {
    const num =
      'duplicate key value violates unique constraint "orders_store_id_business_date_number_key"';
    expect(classifyFailure(insert, { code: '23505', message: num })).toBe('dead');
    expect(classifyFailure(insert, { code: '23505' })).toBe('dead');
  });
  it('permission, constraint, data and raised errors are refused for good', () => {
    for (const code of ['42501', '23514', '23503', '22P02', 'P0001', 'PGRST116'])
      expect(classifyFailure(insert, { code }), code).toBe('dead');
  });
  it('network trouble, server errors, throttling and an expired session are retried', () => {
    expect(classifyFailure(insert, { message: 'Failed to fetch' })).toBe('retry');
    expect(classifyFailure(insert, { status: 503 })).toBe('retry');
    expect(classifyFailure(insert, { status: 429 })).toBe('retry');
    expect(classifyFailure(insert, { status: 408 })).toBe('retry');
    expect(classifyFailure(insert, { code: 'PGRST301' })).toBe('retry');
    expect(classifyFailure(insert, undefined)).toBe('retry');
  });
  it('other 4xx answers are dead', () => {
    expect(classifyFailure(insert, { status: 400 })).toBe('dead');
    expect(classifyFailure(insert, { status: 403 })).toBe('dead');
  });
});

describe('retryDelayMs', () => {
  it('doubles from 2 s and is capped at 5 minutes (±20 % jitter)', () => {
    const mid = () => 0.5; // factor 1.0
    expect(retryDelayMs(1, mid)).toBe(2_000);
    expect(retryDelayMs(2, mid)).toBe(4_000);
    expect(retryDelayMs(3, mid)).toBe(8_000);
    expect(retryDelayMs(30, mid)).toBe(300_000);
    expect(retryDelayMs(3, () => 0)).toBe(6_400);
    expect(retryDelayMs(3, () => 1)).toBe(9_600);
  });
});

describe('nextStep', () => {
  it('is idle for an empty or all-dead queue', () => {
    expect(nextStep([], 0)).toEqual({ type: 'idle' });
    expect(nextStep([entry({ status: 'dead' })], 0)).toEqual({ type: 'idle' });
  });
  it('sends the oldest entry first', () => {
    const a = entry({ id: 'a', createdAt: 5 });
    const b = entry({ id: 'b', createdAt: 1 });
    const s = nextStep([a, b], 10);
    expect(s.type).toBe('send');
    expect(s.type === 'send' && s.entry.id).toBe('b');
  });
  it('a head that is waiting for its retry blocks the ones behind it (order is kept)', () => {
    const head = entry({ id: 'h', createdAt: 1, nextTryAt: 1_000 });
    const later = entry({ id: 'l', createdAt: 2, nextTryAt: 0 });
    expect(nextStep([later, head], 500).type).toBe('wait');
    expect(nextStep([later, head], 1_000).type).toBe('send');
  });
  it('a dead entry does not block the queue', () => {
    const dead = entry({ id: 'd', createdAt: 1, status: 'dead' });
    const ok = entry({ id: 'o', createdAt: 2 });
    const s = nextStep([dead, ok], 10);
    expect(s.type === 'send' && s.entry.id).toBe('o');
  });
});

describe('afterFailure', () => {
  it('schedules a retry and remembers only a short code', () => {
    const e = afterFailure(entry(), 'retry', 1_000, 'x'.repeat(100), () => 0.5);
    expect(e).toMatchObject({ attempts: 1, status: 'pending', nextTryAt: 3_000 });
    expect(e.lastError).toHaveLength(40);
  });
  it('goes dead when refused, or after too many tries', () => {
    expect(afterFailure(entry(), 'dead', 0, '42501').status).toBe('dead');
    expect(afterFailure(entry({ attempts: MAX_ATTEMPTS - 1 }), 'retry', 0, 'net').status).toBe(
      'dead',
    );
  });
});

describe('conflict rules & sync state', () => {
  it('known data has its rule, unknown data is server-wins', () => {
    expect(conflictRuleFor('orders')).toBe('insert-once');
    expect(conflictRuleFor('menu_items')).toBe('last-write-wins');
    expect(conflictRuleFor('payments')).toBe('server-wins');
    expect(conflictRuleFor('anything_new')).toBe('server-wins');
  });
  it('the indicator prefers the most important truth', () => {
    const base = { online: true, syncing: false, pending: 0, dead: 0 };
    expect(syncState({ ...base, online: false, pending: 3 })).toBe('offline');
    expect(syncState({ ...base, dead: 1, syncing: true })).toBe('attention');
    expect(syncState({ ...base, syncing: true, pending: 2 })).toBe('syncing');
    expect(syncState({ ...base, pending: 2 })).toBe('queued');
    expect(syncState(base)).toBe('synced');
  });
});

describe('conflict marker', () => {
  it('an update that touched no row is refused for good', () => {
    expect(classifyFailure(update, { code: 'BESTIE_CONFLICT' })).toBe('dead');
  });
});
