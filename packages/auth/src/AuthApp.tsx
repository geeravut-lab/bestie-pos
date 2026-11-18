import { useCallback, useMemo } from 'react';
import type { ReactNode } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Permission } from '@bestie/core';
import { useI18n } from '@bestie/i18n';
import { createBrowserClient, readPublicEnv } from '@bestie/supabase';
import type { PublicEnv } from '@bestie/supabase';
import { AppRoot, AsyncButton, Icon, Spinner } from '@bestie/ui';
import type { AppId } from '@bestie/ui';
import {
  AccountPage,
  AuthFrame,
  LoginPage,
  Notice,
  OnboardingPage,
  SsoCallbackPage,
} from './components';
import { AuthProvider, useAuth } from './context';
import { useBrand } from './useBrand';
import { appRoleFor, pickStore } from './myContext';

/** What a back-office page needs to know about who is looking at it and where. */
export type PageContext = {
  path: string;
  navigate: (path: string) => void;
  client: SupabaseClient;
  orgId: string;
  storeId: string | null;
  permissions: readonly Permission[];
  isOwner: boolean;
  isPlatformAdmin: boolean;
};

function AccountLink() {
  const { t } = useI18n();
  return (
    <a className="icon-button" href="/account" aria-label={t.navAccount} title={t.navAccount}>
      <Icon name="account" />
    </a>
  );
}

function Loading() {
  const { t } = useI18n();
  return (
    <AuthFrame>
      <p className="sso-working" role="status">
        <Spinner /> {t.appLoading}
      </p>
    </AuthFrame>
  );
}

function LoadFailed({ onRetry }: { onRetry: () => Promise<void> }) {
  const { t } = useI18n();
  return (
    <AuthFrame>
      <section className="card auth-card">
        <Notice kind="error">{t.err_load_failed}</Notice>
        <AsyncButton onClick={onRetry}>{t.retry}</AsyncButton>
      </section>
    </AuthFrame>
  );
}

function Inner({
  app,
  env,
  pages,
}: {
  app: AppId;
  env: PublicEnv | undefined;
  pages?: (ctx: PageContext) => ReactNode | null;
}) {
  const auth = useAuth();
  const { my } = auth;
  const brand = useBrand(auth.client, auth.status === 'signedIn');
  const public_ = app === 'guest'; // guest pages need no account

  const gate = useCallback(
    ({ path, navigate }: { path: string; navigate: (p: string) => void }) => {
      if (!env || public_) return null; // preview mode / public app
      if (path.startsWith('/sso/callback')) {
        return (
          <SsoCallbackPage
            search={window.location.search}
            pathname={path}
            onDone={() => navigate('/')}
            onBack={() => navigate('/')}
          />
        );
      }
      if (auth.status === 'loading') return <Loading />;
      if (auth.status === 'signedOut') return <LoginPage env={env} />;
      if (my.status === 'idle' || my.status === 'loading') return <Loading />;
      if (my.status === 'error' || !my.data) return <LoadFailed onRetry={my.reload} />;
      if (my.data.memberships.length === 0 && !my.data.isPlatformAdmin)
        return <OnboardingPage onCreated={my.reload} />;
      return null;
    },
    [env, public_, auth.status, my.status, my.data, my.reload],
  );

  const live = useMemo(() => {
    if (!env || public_ || auth.status !== 'signedIn' || !my.data) return undefined;
    const membership = my.data.memberships[0];
    const store = pickStore(my.data, membership);
    if (!store && !my.data.isPlatformAdmin) return undefined;
    const role = appRoleFor(membership, { app, isPlatformAdmin: my.data.isPlatformAdmin });
    return {
      role,
      ctx: {
        store: store ?? {
          profile: 'restaurant' as const,
          plan: 'basic' as const,
          moduleOverrides: {},
          legalSignOff: { cryptoTopup: false },
        },
        role: { hiddenModules: membership?.hiddenModules ?? [] },
      },
    };
  }, [env, public_, app, auth.status, my.data]);

  return (
    <AppRoot
      app={app}
      brand={brand}
      live={live}
      gate={gate}
      renderPage={({ path, navigate }) => {
        if (!live || !my.data) return null;
        if (path === '/account') return <AccountPage />;
        const membership = my.data.memberships[0];
        if (!auth.client || !membership) return null;
        return (
          pages?.({
            path,
            navigate,
            client: auth.client,
            orgId: membership.orgId,
            storeId: membership.storeId,
            permissions: membership.permissions,
            isOwner: membership.roleBuiltIn === 'owner',
            isPlatformAdmin: my.data.isPlatformAdmin,
          }) ?? null
        );
      }}
      headerExtra={live ? <AccountLink /> : null}
    />
  );
}

/**
 * pos / admin / guest entry. Configured (Supabase env present) → sign-in → shop onboarding → live role home.
 * Not configured (local dev without keys) → the preview mode of AppRoot, so nothing crashes.
 */
export function AuthApp({
  app,
  rawEnv,
  pages,
}: {
  app: AppId;
  rawEnv: Record<string, string | boolean | undefined>;
  pages?: (ctx: PageContext) => ReactNode | null;
}) {
  const env = useMemo(() => {
    try {
      return readPublicEnv(rawEnv);
    } catch (e) {
      console.error('[env]', e instanceof Error ? e.message : 'invalid');
      return undefined;
    }
  }, [rawEnv]);
  const client = useMemo(() => (env ? createBrowserClient(env) : null), [env]);
  return (
    <AuthProvider client={client}>
      <Inner app={app} env={env} pages={pages} />
    </AuthProvider>
  );
}
