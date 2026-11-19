import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { errorText, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { isInviteCodeShape, normalizeInviteCode } from '@bestie/core';
import { AsyncButton, Brand, LangSwitch, Spinner } from '@bestie/ui';
import type { PublicEnv } from '@bestie/supabase';
import { accountLabel, isAivoraUser } from './account';
import { useAuth } from './context';
import { LineConnect } from './LineConnect';
import { authErrorCode, passwordChangeProblem, signUpProblem } from './errors';
import { aivoraAuthorizeUrl, fetchEnabledProviders } from './providers';
import type { EnabledProviders } from './providers';

/** Full-screen centred card used by login / onboarding / SSO. */
export function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className="auth-screen">
      <header className="auth-top">
        <Brand />
        <LangSwitch />
      </header>
      <main className="auth-main">{children}</main>
    </div>
  );
}

export function Notice({
  kind,
  children,
}: {
  kind: 'error' | 'success' | 'info';
  children: ReactNode;
}) {
  return (
    <p className={`notice notice-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <span aria-hidden="true">{kind === 'error' ? '✕' : kind === 'success' ? '✓' : 'ⓘ'}</span>{' '}
      {children}
    </p>
  );
}

export function PasswordField({
  id,
  label,
  value,
  onChange,
  hint,
  autoComplete,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  autoComplete: string;
}) {
  const { t } = useI18n();
  const [shown, setShown] = useState(false);
  return (
    <div className="form-row">
      <label htmlFor={id} className="label">
        {label}
      </label>
      <div className="password-box">
        <input
          id={id}
          className="field"
          type={shown ? 'text' : 'password'}
          value={value}
          autoComplete={autoComplete}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="password-toggle"
          aria-pressed={shown}
          onClick={() => setShown((v) => !v)}
        >
          {shown ? t.authHidePassword : t.authShowPassword}
        </button>
      </div>
      {hint ? <span className="muted hint">{hint}</span> : null}
    </div>
  );
}

// ── login / sign up ─────────────────────────────────────────────────────────
export function LoginPage({ env }: { env: PublicEnv }) {
  const { t } = useI18n();
  const { client } = useAuth();
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<ErrorKey | null>(null);
  const [checkEmail, setCheckEmail] = useState(false);
  const [providers, setProviders] = useState<EnabledProviders>({ google: false });

  useEffect(() => {
    let alive = true;
    void fetchEnabledProviders(env.supabaseUrl, env.supabaseAnonKey).then(
      (p) => alive && setProviders(p),
    );
    return () => {
      alive = false;
    };
  }, [env.supabaseUrl, env.supabaseAnonKey]);

  const submit = async () => {
    if (!client) return;
    setError(null);
    setCheckEmail(false);
    if (mode === 'up') {
      const problem = signUpProblem(email, password);
      if (problem) return setError(problem);
      const { data, error: err } = await client.auth.signUp({
        email: email.trim(),
        password,
        options: { emailRedirectTo: env.siteUrl },
      });
      if (err) return setError(authErrorCode(err));
      if (!data.session) setCheckEmail(true); // e-mail confirmation is on: no session until the link is opened
      return;
    }
    const { error: err } = await client.auth.signInWithPassword({ email: email.trim(), password });
    if (err) setError(authErrorCode(err));
  };

  const google = async () => {
    if (!client) return;
    setError(null);
    const { error: err } = await client.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: env.siteUrl },
    });
    if (err) setError(authErrorCode(err));
  };

  const lineUrl = env.aivora
    ? aivoraAuthorizeUrl(env.aivora.hubUrl, env.aivora.appSlug, `${env.siteUrl}/sso/callback`)
    : null;

  return (
    <AuthFrame>
      <section className="card auth-card">
        <h1>{mode === 'in' ? t.authTitleSignIn : t.authTitleSignUp}</h1>
        <p className="muted">{t.appTagline}</p>
        <form className="auth-form" onSubmit={(e) => e.preventDefault()} noValidate>
          <div className="form-row">
            <label htmlFor="auth-email" className="label">
              {t.authEmail}
            </label>
            <input
              id="auth-email"
              className="field"
              type="email"
              inputMode="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <PasswordField
            id="auth-password"
            label={t.authPassword}
            value={password}
            onChange={setPassword}
            autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
            hint={mode === 'up' ? t.authPasswordHint : undefined}
          />
          {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
          {checkEmail ? <Notice kind="success">{t.authCheckEmail}</Notice> : null}
          <AsyncButton type="submit" onClick={submit}>
            {mode === 'in' ? t.authSignIn : t.authSignUp}
          </AsyncButton>
        </form>

        {providers.google || lineUrl ? <p className="auth-or muted">{t.authOr}</p> : null}
        {providers.google ? (
          <AsyncButton variant="secondary" onClick={google}>
            {t.authGoogle}
          </AsyncButton>
        ) : null}
        {lineUrl ? (
          <a className="btn btn-secondary" href={lineUrl}>
            {t.authLine}
          </a>
        ) : null}

        <button
          type="button"
          className="link-button"
          onClick={() => {
            setMode(mode === 'in' ? 'up' : 'in');
            setError(null);
            setCheckEmail(false);
          }}
        >
          {mode === 'in' ? t.authSwitchToSignUp : t.authSwitchToSignIn}
        </button>
      </section>
    </AuthFrame>
  );
}

// ── first-run: create the shop (create_org RPC makes the caller its owner) ──
const PROFILE_CHOICES = [
  { id: 'restaurant', live: true },
  { id: 'cafe', live: true },
  { id: 'salon', live: true },
  { id: 'spa', live: true },
  { id: 'resort', live: false },
  { id: 'retail', live: false },
  { id: 'tours', live: false },
] as const;

export function OnboardingPage({ onCreated }: { onCreated: () => Promise<void> }) {
  const { t } = useI18n();
  const { client } = useAuth();
  const [orgName, setOrgName] = useState('');
  const [storeName, setStoreName] = useState('');
  const [profile, setProfile] = useState<string>('restaurant');
  const [error, setError] = useState<ErrorKey | null>(null);
  const names: Record<string, string> = {
    restaurant: t.profileRestaurant,
    cafe: t.profileCafe,
    salon: t.profileSalon,
    spa: t.profileSpa,
    resort: t.profileResort,
    retail: t.profileRetail,
    tours: t.profileTours,
  };

  const create = async () => {
    if (!client) return;
    setError(null);
    if (orgName.trim().length < 1) return setError('err_invalid_input');
    const { error: err } = await client.rpc('create_org', {
      p_org_name: orgName.trim(),
      p_store_name: storeName.trim() || orgName.trim(),
      p_profile: profile,
    });
    if (err) {
      console.error('[onboarding] create_org failed', err.code ?? 'unknown');
      return setError('err_save_failed');
    }
    await onCreated();
  };

  return (
    <AuthFrame>
      <section className="card auth-card">
        <h1>{t.onboardingTitle}</h1>
        <p className="muted">{t.onboardingBody}</p>
        <form className="auth-form" onSubmit={(e) => e.preventDefault()}>
          <div className="form-row">
            <label htmlFor="ob-org" className="label">
              {t.onboardingOrgName}
            </label>
            <input
              id="ob-org"
              className="field"
              value={orgName}
              maxLength={120}
              onChange={(e) => setOrgName(e.target.value)}
            />
          </div>
          <div className="form-row">
            <label htmlFor="ob-store" className="label">
              {t.onboardingStoreName}
            </label>
            <input
              id="ob-store"
              className="field"
              value={storeName}
              maxLength={120}
              onChange={(e) => setStoreName(e.target.value)}
            />
          </div>
          <div className="form-row" role="group" aria-label={t.onboardingProfile}>
            <span className="label">{t.onboardingProfile}</span>
            <div className="chips">
              {PROFILE_CHOICES.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="chip"
                  aria-pressed={profile === p.id}
                  aria-disabled={!p.live || undefined}
                  disabled={!p.live}
                  onClick={() => setProfile(p.id)}
                >
                  {names[p.id]}
                  {!p.live ? <small className="chip-note"> · {t.onboardingSoon}</small> : null}
                </button>
              ))}
            </div>
          </div>
          {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
          <AsyncButton type="submit" onClick={create}>
            {t.onboardingCreate}
          </AsyncButton>
        </form>
      </section>
      <AcceptInviteCard onJoined={onCreated} />
    </AuthFrame>
  );
}

/** A person invited by an owner / manager redeems the one-time code here (the server checks it; nothing is trusted here). */
export function AcceptInviteCard({ onJoined }: { onJoined: () => Promise<void> }) {
  const { t } = useI18n();
  const { client } = useAuth();
  const [code, setCode] = useState('');
  const [error, setError] = useState<ErrorKey | null>(null);

  const join = async () => {
    if (!client) return;
    setError(null);
    if (!isInviteCodeShape(code)) return setError('err_invite_invalid');
    const { error: err } = await client.rpc('accept_staff_invite', {
      p_code: normalizeInviteCode(code),
    });
    if (err) {
      console.error('[invite] accept failed', err.code ?? 'unknown');
      return setError(err.code === 'P0002' ? 'err_invite_invalid' : 'err_save_failed');
    }
    await onJoined();
  };

  return (
    <section className="card auth-card">
      <h2>{t.acceptTitle}</h2>
      <p className="muted">{t.acceptBody}</p>
      <form className="auth-form" onSubmit={(e) => e.preventDefault()}>
        <div className="form-row">
          <label htmlFor="accept-code" className="label">
            {t.acceptLabel}
          </label>
          <input
            id="accept-code"
            className="field mono"
            value={code}
            maxLength={20}
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setCode(e.target.value)}
          />
        </div>
        {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
        <AsyncButton type="submit" variant="secondary" onClick={join}>
          {t.acceptButton}
        </AsyncButton>
      </form>
    </section>
  );
}

// ── Aivora SSO callback ─────────────────────────────────────────────────────
const SSO_TIMEOUT_MS = 15_000;

/**
 * /sso/callback?sso_ticket=… — docs/SSO-Aivora-Supabase.md steps 4, 5 and 7:
 *  1. remove the ticket from the URL BEFORE the first await (single use, 60 s: a refresh must not replay it);
 *  2. exchange it on the SERVER (/api/sso-exchange) — never from the browser;
 *  3. setSession, then call the real bootstrap (`refresh`) directly — never wait for the auth listener;
 *  4. never spin silently: 15 s timeout, a real message and a way back, console checkpoints.
 */
export function SsoCallbackPage({
  search,
  pathname,
  onDone,
  onBack,
}: {
  search: string;
  pathname: string;
  onDone: () => void;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const { client, refresh } = useAuth();
  // No ticket (or no client) is known on the very first render: no state update inside the effect needed.
  const hasTicket = Boolean(new URLSearchParams(search).get('sso_ticket')) && Boolean(client);
  const [error, setError] = useState<ErrorKey | null>(hasTicket ? null : 'err_sso_invalid_ticket');
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // React StrictMode runs effects twice in dev
    started.current = true;
    const ticket = new URLSearchParams(search).get('sso_ticket');
    history.replaceState(null, '', pathname); // (1) before any await
    if (!ticket || !client) {
      console.info('[sso] no ticket in the URL');
      return; // the error screen is already showing (initial state)
    }
    console.info('[sso] ticket found');
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), SSO_TIMEOUT_MS),
    );
    const run = async () => {
      const res = await fetch('/api/sso-exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        console.info('[sso] exchange rejected', res.status, body.error ?? '');
        throw Object.assign(new Error('exchange'), {
          sso:
            body.error === 'invalid_ticket' || res.status === 401
              ? 'err_sso_invalid_ticket'
              : 'err_sso_failed',
        });
      }
      const tokens = (await res.json()) as { access_token: string; refresh_token: string };
      console.info('[sso] ticket exchanged');
      const { data, error: err } = await client.auth.setSession({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
      });
      if (err || !data.session)
        throw Object.assign(new Error('setSession'), { sso: 'err_sso_failed' });
      console.info('[sso] session set for user', data.session.user.id);
      console.info('[sso] bootstrap starting');
      await refresh(); // explicit — do not rely on onAuthStateChange ordering
      console.info('[sso] bootstrap done');
    };
    Promise.race([run(), timeout])
      .then(onDone)
      .catch((e: unknown) => {
        const code =
          (e as { sso?: ErrorKey }).sso ??
          ((e as Error)?.message === 'timeout' ? 'err_sso_timeout' : 'err_sso_failed');
        console.error('[sso] failed:', (e as Error)?.message ?? 'unknown');
        setError(code);
      });
  }, [client, search, pathname, refresh, onDone]);

  return (
    <AuthFrame>
      <section className="card auth-card">
        {error ? (
          <>
            <h1>{t.ssoFailedTitle}</h1>
            <Notice kind="error">{errorText(error, t)}</Notice>
            <AsyncButton onClick={onBack}>{t.ssoBack}</AsyncButton>
          </>
        ) : (
          <p className="sso-working" role="status">
            <Spinner /> {t.ssoWorking}
          </p>
        )}
      </section>
    </AuthFrame>
  );
}

// ── account ─────────────────────────────────────────────────────────────────
export function AccountPage() {
  const { t } = useI18n();
  const { client, user, signOut } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<ErrorKey | null>(null);
  const [done, setDone] = useState(false);

  // Only accounts that actually have an e-mail password can change one (Google / LINE accounts have none).
  const providers = (user?.app_metadata?.providers as string[] | undefined) ?? [];
  const hasPassword = Boolean(user?.email) && providers.includes('email') && !isAivoraUser(user);
  // a LINE account made before the hub name was kept in the account: the profile row may still have it
  const [profileName, setProfileName] = useState<string | null>(null);
  useEffect(() => {
    if (!client || !user || !isAivoraUser(user)) return;
    let alive = true;
    void client
      .from('profiles')
      .select('display_name')
      .eq('user_id', user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (alive) setProfileName((data as { display_name?: string } | null)?.display_name ?? null);
      });
    return () => {
      alive = false;
    };
  }, [client, user]);
  const who = accountLabel(user, profileName);

  const change = async () => {
    if (!client || !user?.email) return;
    setError(null);
    setDone(false);
    const problem = passwordChangeProblem({ current, next, confirm });
    if (problem) return setError(problem);
    // Prove the current password by signing in again — this also gives Supabase the "fresh session" it wants.
    const { error: reauth } = await client.auth.signInWithPassword({
      email: user.email,
      password: current,
    });
    if (reauth)
      return setError(
        authErrorCode(reauth) === 'err_auth_invalid'
          ? 'err_password_current_wrong'
          : authErrorCode(reauth),
      );
    const { error: upd } = await client.auth.updateUser({ password: next });
    if (upd) return setError(authErrorCode(upd));
    await client.auth.signOut({ scope: 'others' }); // every other device is signed out; this one stays
    setCurrent('');
    setNext('');
    setConfirm('');
    setDone(true);
  };

  return (
    <div className="account">
      <section className="card auth-card">
        <h1>{t.accountTitle}</h1>
        <p className="muted">
          {t.accountSignedInAs}{' '}
          <strong className="account-name">
            {who.kind === 'text'
              ? who.text
              : who.kind === 'line-anonymous'
                ? t.accountLineUser
                : ''}
          </strong>
        </p>
        <AsyncButton variant="secondary" onClick={signOut}>
          {t.authSignOut}
        </AsyncButton>
      </section>
      <LineConnect />
      <section className="card auth-card">
        <h2>{t.pwTitle}</h2>
        {hasPassword ? (
          <form className="auth-form" onSubmit={(e) => e.preventDefault()}>
            <PasswordField
              id="pw-current"
              label={t.pwCurrent}
              value={current}
              onChange={setCurrent}
              autoComplete="current-password"
            />
            <PasswordField
              id="pw-new"
              label={t.pwNew}
              value={next}
              onChange={setNext}
              autoComplete="new-password"
              hint={t.authPasswordHint}
            />
            <PasswordField
              id="pw-confirm"
              label={t.pwConfirm}
              value={confirm}
              onChange={setConfirm}
              autoComplete="new-password"
            />
            {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
            {done ? <Notice kind="success">{t.pwDone}</Notice> : null}
            <AsyncButton type="submit" onClick={change}>
              {t.pwSave}
            </AsyncButton>
          </form>
        ) : (
          <Notice kind="info">{t.pwNotAvailable}</Notice>
        )}
      </section>
    </div>
  );
}
