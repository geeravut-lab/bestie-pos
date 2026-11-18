import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Session, SupabaseClient, User } from '@supabase/supabase-js';
import { loadMyContext } from './myContext';
import { useLiveSync } from './useLiveSync';
import type { MyContext } from './myContext';

export type AuthStatus = 'unconfigured' | 'loading' | 'signedOut' | 'signedIn';

type AuthValue = {
  client: SupabaseClient | null;
  status: AuthStatus;
  session: Session | null;
  user: User | null;
  /** Re-read the session from storage. The SSO path calls this directly after setSession (never rely on the listener). */
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  /** Org / store / role data for the signed-in user. */
  my: {
    status: 'idle' | 'loading' | 'ready' | 'error';
    data: MyContext | null;
    reload: () => Promise<void>;
  };
};

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({
  client,
  children,
}: {
  client: SupabaseClient | null;
  children: ReactNode;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<AuthStatus>(client ? 'loading' : 'unconfigured');

  const refresh = useCallback(async () => {
    if (!client) return;
    const { data } = await client.auth.getSession();
    setSession(data.session);
    setStatus(data.session ? 'signedIn' : 'signedOut');
  }, [client]);

  useEffect(() => {
    if (!client) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial read of an EXTERNAL store (Supabase session); state is set after the await
    void refresh();
    const { data } = client.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setStatus(next ? 'signedIn' : 'signedOut');
    });
    return () => data.subscription.unsubscribe();
  }, [client, refresh]);

  const userId = session?.user.id;
  // Result of the last load, tagged with WHO it was for — so a different / signed-out user never sees stale data
  // and no setState has to run synchronously inside an effect.
  const [result, setResult] = useState<{
    userId: string;
    status: 'ready' | 'error';
    data: MyContext | null;
  } | null>(null);

  const load = useCallback(async () => {
    if (!client || !userId) return;
    try {
      setResult({ userId, status: 'ready', data: await loadMyContext(client) });
    } catch (e) {
      console.error('[auth] loading shop data failed', e instanceof Error ? e.message : 'unknown');
      setResult({ userId, status: 'error', data: null });
    }
  }, [client, userId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch from an EXTERNAL system; state is set after the await
    void load();
  }, [load]);

  /** For buttons (retry, after onboarding): show "loading" again, then load. */
  const reload = useCallback(async () => {
    setResult(null);
    await load();
  }, [load]);

  const current = userId && result?.userId === userId ? result : null;
  const myState: AuthValue['my']['status'] = !userId ? 'idle' : (current?.status ?? 'loading');
  const myData = current?.data ?? null;

  // Roles, modules and store settings change on one device → every other open screen of the org updates by itself.
  const liveOrg = myData?.memberships[0]?.orgId;
  useLiveSync(client, liveOrg ? [`org:${liveOrg}`] : [], load);

  const signOut = useCallback(async () => {
    if (!client) return;
    await client.auth.signOut();
  }, [client]);

  const value = useMemo<AuthValue>(
    () => ({
      client,
      status,
      session,
      user: session?.user ?? null,
      refresh,
      signOut,
      my: { status: myState, data: myData, reload },
    }),
    [client, status, session, refresh, signOut, myState, myData, reload],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
