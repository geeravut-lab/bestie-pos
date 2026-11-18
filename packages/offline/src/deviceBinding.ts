import type { DeviceRole } from '@bestie/core';

/** "This tablet is device X of shop Y" — chosen once by an owner / manager, kept in localStorage on that tablet. */
export type DeviceBinding = {
  deviceId: string;
  storeId: string;
  orgId: string;
  name: string;
  role: DeviceRole;
  station: 'kitchen' | 'bar' | null;
  posId: string | null;
};

const KEY = 'bestie-device';
const EVENT = 'bestie-device-change';

const isBinding = (v: unknown): v is DeviceBinding => {
  if (!v || typeof v !== 'object') return false;
  const b = v as Record<string, unknown>;
  return (
    typeof b.deviceId === 'string' &&
    typeof b.storeId === 'string' &&
    typeof b.orgId === 'string' &&
    typeof b.name === 'string' &&
    (b.role === 'cashier' || b.role === 'staff' || b.role === 'kds') &&
    (b.station === null || b.station === 'kitchen' || b.station === 'bar') &&
    (b.posId === null || typeof b.posId === 'string')
  );
};

export function getDeviceBinding(): DeviceBinding | null {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    const v: unknown = raw ? JSON.parse(raw) : null;
    return isBinding(v) ? v : null;
  } catch {
    return null;
  }
}

export function setDeviceBinding(b: DeviceBinding | null): void {
  try {
    if (b) globalThis.localStorage?.setItem(KEY, JSON.stringify(b));
    else globalThis.localStorage?.removeItem(KEY);
  } catch {
    /* storage blocked: the tablet then simply behaves as an unbound browser */
  }
  globalThis.dispatchEvent?.(new Event(EVENT));
}

export function subscribeDeviceBinding(cb: () => void): () => void {
  globalThis.addEventListener?.(EVENT, cb);
  globalThis.addEventListener?.('storage', cb);
  return () => {
    globalThis.removeEventListener?.(EVENT, cb);
    globalThis.removeEventListener?.('storage', cb);
  };
}
