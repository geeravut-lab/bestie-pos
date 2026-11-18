import { useCallback, useEffect, useState } from 'react';

/**
 * Load something from the network when `key` changes. State is only set in promise callbacks (never synchronously in
 * the effect), results are tagged with the key they belong to (a slow old answer can never overwrite a newer one),
 * and `reload()` re-runs the same request.
 */
export function useRemote<T>(
  load: () => Promise<T>,
  key: string,
): { status: 'loading' | 'ready' | 'error'; data: T | undefined; reload: () => void } {
  const [tick, setTick] = useState(0);
  const fullKey = `${key}#${tick}`;
  const [res, setRes] = useState<{ base: string; tick: number; data?: T; error?: boolean } | null>(
    null,
  );

  useEffect(() => {
    let alive = true;
    load().then(
      (data) => alive && setRes({ base: key, tick, data }),
      (e: unknown) => {
        console.error('[remote] failed', e instanceof Error ? e.message : 'unknown');
        if (alive) setRes({ base: key, tick, error: true });
      },
    );
    return () => {
      alive = false;
    };
    // `load` is a closure over the inputs that make up `key`; re-running on `key` is the contract.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullKey]);

  // Same inputs, newer tick = a silent refresh: keep showing the previous result until the new one lands.
  // An error is only shown for the request that failed (a manual retry shows "loading" again).
  const current = res?.base === key && (!res.error || res.tick === tick) ? res : null;
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return {
    status: !current ? 'loading' : current.error ? 'error' : 'ready',
    data: current?.data,
    reload,
  };
}
