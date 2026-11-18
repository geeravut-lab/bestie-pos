import { PIN_LOCK_MINUTES, PIN_MAX_ATTEMPTS, isValidPin } from '@bestie/core';
import { db } from './db';

/**
 * Offline PIN check (docs/DECISIONS.md "Shop devices and staff PIN model"). After the server has accepted a PIN once,
 * this tablet keeps a SALTED, slow (PBKDF2) verifier of it so the same person can unlock with no signal.
 * The verifier never leaves the device; a wrong-try counter locks it like the server does.
 * It is a convenience for "who is acting", not a security boundary: whoever holds the signed-in tablet already holds its session.
 */
const ITERATIONS = 150_000;
const key = (staffId: string) => `pin:${staffId}`;

type Verifier = {
  salt: string;
  hash: string;
  iterations: number;
  failed: number;
  lockedUntil: number;
};

const b64 = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const unb64 = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

async function derive(
  pin: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<string> {
  const base = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    256,
  );
  return b64(bits);
}

/** Remember a PIN the SERVER has just accepted (or just set). */
export async function rememberPin(staffId: string, pin: string): Promise<void> {
  if (!isValidPin(pin)) return;
  const salt = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(16)));
  const v: Verifier = {
    salt: b64(salt),
    hash: await derive(pin, salt, ITERATIONS),
    iterations: ITERATIONS,
    failed: 0,
    lockedUntil: 0,
  };
  await db.kv.put({ key: key(staffId), value: v });
}

export async function forgetPin(staffId: string): Promise<void> {
  await db.kv.delete(key(staffId));
}

export type LocalPinResult = 'ok' | 'wrong' | 'locked' | 'unknown';

/** `unknown` = this tablet never saw the server accept a PIN for that person, so offline unlock is not possible for them. */
export async function verifyPinLocally(
  staffId: string,
  pin: string,
  now: () => number = Date.now,
): Promise<LocalPinResult> {
  const row = await db.kv.get(key(staffId));
  const v = row?.value as Verifier | undefined;
  if (!v) return 'unknown';
  if (v.lockedUntil > now()) return 'locked';
  const ok = isValidPin(pin) && (await derive(pin, unb64(v.salt), v.iterations)) === v.hash;
  if (ok) {
    await db.kv.put({ key: key(staffId), value: { ...v, failed: 0, lockedUntil: 0 } });
    return 'ok';
  }
  const failed = v.failed + 1;
  const locked = failed >= PIN_MAX_ATTEMPTS;
  await db.kv.put({
    key: key(staffId),
    value: {
      ...v,
      failed: locked ? 0 : failed,
      lockedUntil: locked ? now() + PIN_LOCK_MINUTES * 60_000 : 0,
    },
  });
  return locked ? 'locked' : 'wrong';
}
