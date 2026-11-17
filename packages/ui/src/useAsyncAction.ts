import { useCallback, useEffect, useRef, useState } from 'react';
import { toErrorCode } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';

/**
 * Wraps any click / submit handler so that:
 *  - `pending` is true from the moment it starts until it settles (drives the spinner),
 *  - a second call while one is running is ignored (no double submit / double charge),
 *  - failures never escape as unhandled rejections: they become an `err_*` code.
 *
 * The re-entry guard is a ref, not state: two clicks in the same frame both see the same
 * render, so a state flag alone would let both through.
 *
 * Project rule (CLAUDE.md): every button / menu that triggers work uses this (directly or via
 * <AsyncButton>) so the user always sees a spinner while the system is busy.
 */
export function useAsyncAction<A extends unknown[], R>(
  action: (...args: A) => Promise<R> | R,
  options: { onError?: (code: ErrorKey) => void } = {},
) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ErrorKey | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const actionRef = useRef(action);
  const onErrorRef = useRef(options.onError);

  useEffect(() => {
    actionRef.current = action;
    onErrorRef.current = options.onError;
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async (...args: A): Promise<R | undefined> => {
    if (inFlight.current) return undefined;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      return await actionRef.current(...args);
    } catch (e) {
      const code = toErrorCode(e);
      if (mounted.current) setError(code);
      onErrorRef.current?.(code);
      return undefined;
    } finally {
      inFlight.current = false;
      if (mounted.current) setPending(false);
    }
  }, []);

  return { run, pending, error };
}
