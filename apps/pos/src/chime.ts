import { useEffect, useRef } from 'react';

let ctx: AudioContext | null = null;

/** A short two-note beep. Browsers only allow sound after a tap, so the screen has a "Sound on" button that calls `primeSound`. */
export function primeSound(): void {
  try {
    const AC = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    if (!AC) return;
    ctx ??= new AC();
    void ctx.resume();
  } catch {
    /* no audio: the screen still flashes */
  }
}

export function playBeep(): void {
  try {
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    [880, 1175].forEach((freq, i) => {
      const o = ctx!.createOscillator();
      const g = ctx!.createGain();
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, now + i * 0.18);
      g.gain.exponentialRampToValueAtTime(0.25, now + i * 0.18 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.18 + 0.16);
      o.connect(g).connect(ctx!.destination);
      o.start(now + i * 0.18);
      o.stop(now + i * 0.18 + 0.18);
    });
  } catch {
    /* ignore */
  }
}

/**
 * Calls `onNew` once whenever an id that was not there before appears (not for the ids present when the screen opened —
 * opening the screen must not beep for old tickets).
 */
export function useNewIds(
  ids: readonly string[],
  enabled: boolean,
  onNew: () => void = playBeep,
): void {
  const seen = useRef<Set<string> | null>(null);
  const key = [...ids].sort().join('|');
  useEffect(() => {
    const now = new Set(key === '' ? [] : key.split('|'));
    const before = seen.current;
    seen.current = now;
    if (before === null || !enabled) return;
    for (const id of now) {
      if (!before.has(id)) {
        onNew();
        return;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `onNew` is stable by contract; only a change of ids may beep
  }, [key, enabled]);
}
