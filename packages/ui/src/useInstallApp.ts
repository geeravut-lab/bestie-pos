import { useSyncExternalStore } from 'react';

/**
 * "Install the app" support. Chrome / Edge / Android fire `beforeinstallprompt` once, early, and only if somebody keeps the event; this module
 * listens from the moment the bundle loads (not when a component mounts), so the event is never lost. iPhone / iPad Safari has no such event:
 * the person adds the page from the Share menu, so we show the steps instead of a button that cannot work.
 */
type InstallEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};
export type InstallState = 'installed' | 'available' | 'ios' | 'other';

let deferred: InstallEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const isStandalone = (): boolean => {
  try {
    return (
      window.matchMedia?.('(display-mode: standalone)').matches === true ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true
    );
  } catch {
    return false;
  }
};

/** iPhone / iPad (incl. iPadOS that reports itself as a Mac with a touch screen). */
export const isIosDevice = (ua: string, touchPoints: number): boolean =>
  /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1);

/** A smartphone (not a tablet, not a desktop): Android phones say "Mobile", iPhones say "iPhone"; an iPad / Android tablet does not match. */
export const isPhoneDevice = (ua: string): boolean =>
  /iPhone|iPod|Android.*Mobile|Windows Phone|Mobile/.test(ua);

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // keep it: the page decides when to show the browser's install dialog
    deferred = e as InstallEvent;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    installed = true;
    emit();
  });
}

const snapshot = (): InstallState => {
  if (installed || isStandalone()) return 'installed';
  if (deferred) return 'available';
  if (
    typeof navigator !== 'undefined' &&
    isIosDevice(navigator.userAgent, navigator.maxTouchPoints)
  )
    return 'ios';
  return 'other';
};
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

/** Show the browser's own install dialog (only when the browser offered one). */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const ev = deferred;
  if (!ev) return 'unavailable';
  await ev.prompt();
  const choice = await ev.userChoice;
  deferred = null; // a prompt can be used once
  if (choice.outcome === 'accepted') installed = true;
  emit();
  return choice.outcome;
}

/** Tests only: forget what the browser offered, so each test starts as a fresh page load. */
export function resetInstallForTests(): void {
  deferred = null;
  installed = false;
  emit();
}

export function useInstallApp(): InstallState {
  return useSyncExternalStore(subscribe, snapshot, () => 'other' as InstallState);
}
