import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import { closeShiftPayload, openShiftPayload, shiftFromRow } from '@bestie/core';
import type { ShiftDoc } from '@bestie/core';
import { db } from './db';
import { nextStamp } from './outbox';
import type { RemoteClient } from './outbox';

/** The shift is saved on the tablet and its server call queued in one step: opening / closing the drawer works with no signal. */
export async function saveShift(
  shift: ShiftDoc,
  kind: 'open' | 'close',
  staffId: string | null,
  now: () => number = Date.now,
): Promise<void> {
  await db.transaction('rw', db.shifts, db.outbox, async () => {
    await db.shifts.put(shift);
    await db.outbox.add({
      id: crypto.randomUUID(),
      op: {
        kind: 'rpc',
        fn: kind === 'open' ? 'open_shift' : 'close_shift',
        args: kind === 'open' ? openShiftPayload(shift) : closeShiftPayload(shift, staffId),
      },
      createdAt: await nextStamp(now),
      attempts: 0,
      nextTryAt: 0,
      status: 'pending',
    });
  });
}

export const getOpenShift = async (deviceId: string): Promise<ShiftDoc | null> =>
  (await db.shifts
    .where('deviceId')
    .equals(deviceId)
    .filter((s) => s.status === 'open')
    .first()) ?? null;

/** Closed shifts of a device, newest first (the last few are enough for the screen). */
export const listClosedShifts = async (deviceId: string, limit = 10): Promise<ShiftDoc[]> =>
  (
    await db.shifts
      .where('deviceId')
      .equals(deviceId)
      .filter((s) => s.status === 'closed')
      .toArray()
  )
    .sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''))
    .slice(0, limit);

/**
 * A new or wiped tablet learns about the shift that is already open for its device on the server. Skipped while writes wait
 * to be sent (they may be this very shift) and never overwrites a local open shift.
 */
export async function pullShifts(
  client: Pick<RemoteClient, 'from'>,
  deviceId: string,
): Promise<void> {
  if ((await db.outbox.where('status').equals('pending').count()) > 0) return;
  const r = await client
    .from('shifts')
    .select('*')
    .eq('device_id', deviceId)
    .order('opened_at', { ascending: false })
    .limit(10);
  if (r.error) return;
  for (const row of (r.data ?? []) as Record<string, unknown>[]) {
    const s = shiftFromRow(row);
    if (!s) continue;
    const local = await db.shifts.get(s.id);
    if (!local || local.status !== s.status) await db.shifts.put(s);
  }
}

export function useOpenShift(deviceId: string | null): ShiftDoc | null | undefined {
  const [state, setState] = useState<{ id: string | null; shift: ShiftDoc | null } | undefined>();
  useEffect(() => {
    if (!deviceId) return;
    const sub = liveQuery(() => getOpenShift(deviceId)).subscribe({
      next: (shift) => setState({ id: deviceId, shift }),
      error: (e: unknown) =>
        console.error('[shift] read failed', e instanceof Error ? e.message : 'unknown'),
    });
    return () => sub.unsubscribe();
  }, [deviceId]);
  return state && state.id === deviceId ? state.shift : undefined;
}

export function useClosedShifts(deviceId: string | null): ShiftDoc[] | undefined {
  const [state, setState] = useState<{ id: string | null; list: ShiftDoc[] } | undefined>();
  useEffect(() => {
    if (!deviceId) return;
    const sub = liveQuery(() => listClosedShifts(deviceId)).subscribe({
      next: (list) => setState({ id: deviceId, list }),
      error: (e: unknown) =>
        console.error('[shift] read failed', e instanceof Error ? e.message : 'unknown'),
    });
    return () => sub.unsubscribe();
  }, [deviceId]);
  return state && state.id === deviceId ? state.list : undefined;
}
