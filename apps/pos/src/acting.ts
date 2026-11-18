import { useEffect } from 'react';
import { IDLE_LOCK_MS, MODULE_IDS, PERMISSIONS, isIdleExpired } from '@bestie/core';
import type { ActingIdentity } from '@bestie/auth';

/**
 * The person who unlocked the till is remembered in sessionStorage (gone when the tab / PWA closes), together with the
 * time of their last touch. Coming back after an idle gap — or opening the app fresh — asks for the PIN again.
 */
const KEY = 'bestie-acting';

type Stored = { acting: ActingIdentity; lastActive: number };

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

function parse(raw: string | null): Stored | null {
  try {
    const v: unknown = raw ? JSON.parse(raw) : null;
    if (!v || typeof v !== 'object') return null;
    const { acting: a, lastActive } = v as {
      acting?: Record<string, unknown>;
      lastActive?: unknown;
    };
    if (!a || typeof lastActive !== 'number') return null;
    if (typeof a.staffId !== 'string' || typeof a.accountId !== 'string') return null;
    return {
      lastActive,
      acting: {
        staffId: a.staffId,
        accountId: a.accountId,
        displayName: typeof a.displayName === 'string' ? a.displayName : '',
        roleName: typeof a.roleName === 'string' ? a.roleName : '',
        roleBuiltIn: ['owner', 'manager', 'cashier', 'waiter', 'kitchen'].includes(
          String(a.roleBuiltIn),
        )
          ? (a.roleBuiltIn as ActingIdentity['roleBuiltIn'])
          : null,
        // only known permissions / modules survive a read from storage
        permissions: strings(a.permissions).filter((p): p is (typeof PERMISSIONS)[number] =>
          (PERMISSIONS as readonly string[]).includes(p),
        ),
        hiddenModules: strings(a.hiddenModules).filter((m): m is (typeof MODULE_IDS)[number] =>
          (MODULE_IDS as readonly string[]).includes(m),
        ),
      },
    };
  } catch {
    return null;
  }
}

export function loadActing(now: number = Date.now()): ActingIdentity | null {
  try {
    const s = parse(globalThis.sessionStorage?.getItem(KEY) ?? null);
    return s && !isIdleExpired(s.lastActive, now) ? s.acting : null;
  } catch {
    return null;
  }
}

export function saveActing(a: ActingIdentity | null, now: number = Date.now()): void {
  try {
    if (a) globalThis.sessionStorage?.setItem(KEY, JSON.stringify({ acting: a, lastActive: now }));
    else globalThis.sessionStorage?.removeItem(KEY);
  } catch {
    /* storage blocked: the till then asks for the PIN on every reload — safe, just less convenient */
  }
}

function touch(now: number) {
  try {
    const s = parse(globalThis.sessionStorage?.getItem(KEY) ?? null);
    if (s)
      globalThis.sessionStorage?.setItem(
        KEY,
        JSON.stringify({ acting: s.acting, lastActive: now }),
      );
  } catch {
    /* best effort */
  }
}

/** While someone is working: any touch keeps the till unlocked; `IDLE_LOCK_MS` without one locks it. */
export function useIdleLock(active: boolean, onLock: () => void): void {
  useEffect(() => {
    if (!active) return;
    let last = Date.now();
    let written = last;
    const seen = () => {
      last = Date.now();
      if (last - written > 10_000) {
        written = last;
        touch(last); // storage writes are throttled — a touch screen fires many events
      }
    };
    const events = ['pointerdown', 'keydown', 'touchstart'] as const;
    for (const e of events) globalThis.addEventListener(e, seen, { passive: true });
    const timer = setInterval(
      () => {
        if (isIdleExpired(last, Date.now())) onLock();
      },
      Math.min(10_000, IDLE_LOCK_MS),
    );
    return () => {
      for (const e of events) globalThis.removeEventListener(e, seen);
      clearInterval(timer);
    };
  }, [active, onLock]);
}
