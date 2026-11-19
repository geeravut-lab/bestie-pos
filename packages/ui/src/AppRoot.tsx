import { useEffect, useState, useTransition } from 'react';
import type { ReactNode } from 'react';
import { BrowserRouter, useLocation, useNavigate } from 'react-router';
import { brandImageUrl } from '@bestie/core';
import type { Brand } from '@bestie/core';
import { I18nProvider, useI18n } from '@bestie/i18n';
import type { StoreModuleConfig } from '@bestie/core';
import { AppShell } from './AppShell';
import { LangSwitch } from './LangSwitch';
import { BrandProvider } from './Logo';
import { NAV_ITEMS, roleLabelKey } from './nav';
import type { AppRole, NavContext } from './nav';
import { PageSoon } from './PageSoon';
import { RoleHome } from './RoleHome';

export type AppId = 'pos' | 'admin' | 'guest';

/** Real session data: replaces the preview chips (role + store come from the database, not from a picker). */
export type LiveSession = {
  role: AppRole;
  ctx: NavContext;
  /** The name of a role the shop made itself (null for the built-in roles). */
  roleName?: string | null;
};

export type AppRootProps = {
  app: AppId;
  /** Present = signed-in mode. Absent = preview mode (no backend configured). */
  live?: LiveSession;
  /** Takes over the whole screen before the shell (login, SSO callback, onboarding). Return null to continue. */
  gate?: (p: { path: string; navigate: (path: string) => void }) => ReactNode | null;
  /** Real pages; return null to fall back to the "being built" placeholder. */
  renderPage?: (p: { path: string; navigate: (path: string) => void }) => ReactNode | null;
  /** Extra controls on the right of the top bar (account link). */
  headerExtra?: ReactNode;
  /** Admin-chosen product name / logo / tab icon (BRANDING-KNOWLEDGE). Absent = Bestie defaults. */
  brand?: Brand;
  /** Admin-uploaded home-card pictures by card id (docs/UX-DESIGN.md §7). Missing = built-in illustration. */
  cardImages?: Record<string, string>;
};

/** Roles each app can preview until sign-in + roles arrive (Phase 1 §12). First = default. */
const APP_ROLES_PREVIEW: Record<AppId, readonly AppRole[]> = {
  pos: ['cashier', 'waiter', 'kitchen', 'manager'],
  admin: ['owner', 'manager', 'platformAdmin'],
  guest: ['guest'],
};

const PREVIEW_PROFILES = ['restaurant', 'cafe'] as const;
type PreviewProfile = (typeof PREVIEW_PROFILES)[number];

const ROLE_KEY = 'bestie-preview-role';
const PROFILE_KEY = 'bestie-preview-profile';

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = globalThis.localStorage?.getItem(key);
    return (allowed as readonly string[]).includes(v ?? '') ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}
function remember(key: string, value: string) {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* best effort */
  }
}

const demoStore = (profile: PreviewProfile): StoreModuleConfig => ({
  profile,
  plan: 'pro',
  moduleOverrides: {},
  legalSignOff: { cryptoTopup: false },
});

function Frame({ app, live, gate, renderPage, headerExtra, cardImages }: AppRootProps) {
  const { t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const [pending, startTransition] = useTransition();
  const [target, setTarget] = useState<string | null>(null);
  const roles = APP_ROLES_PREVIEW[app];
  const [role, setRole] = useState<AppRole>(() => stored(ROLE_KEY + app, roles, roles[0]!));
  const [profile, setProfile] = useState<PreviewProfile>(() =>
    stored(PROFILE_KEY, PREVIEW_PROFILES, 'restaurant'),
  );

  const previewCtx: NavContext = { store: demoStore(profile) };
  const ctx = live?.ctx ?? previewCtx;
  const activeRole = live?.role ?? role;
  // Spinner + progress bar from the moment an item is tapped until the next screen is ready.
  const go = (path: string, replace = false) => {
    setTarget(path);
    startTransition(() => navigate(path, replace ? { replace: true } : undefined));
  };
  const pendingPath = pending ? target : null;

  const profileLabel = { restaurant: t.profileRestaurant, cafe: t.profileCafe };
  const current = NAV_ITEMS.find((n) => n.path === location.pathname);

  const gated = gate?.({ path: location.pathname, navigate });
  if (gated) return <>{gated}</>;
  const page = renderPage?.({ path: location.pathname, navigate: go });

  return (
    <AppShell
      role={activeRole}
      ctx={ctx}
      path={location.pathname}
      onNavigate={go}
      pendingPath={pendingPath}
      headerRight={
        <>
          {headerExtra}
          <LangSwitch />
        </>
      }
    >
      {live ? null : (
        <div className="preview-strip" role="group" aria-label={t.homePreviewNote}>
          <p className="muted preview-note">{t.homePreviewNote}</p>
          <div className="chips" role="group" aria-label={t.homePreviewLabel}>
            {roles.map((r) => (
              <button
                key={r}
                type="button"
                className="chip"
                aria-pressed={r === role}
                onClick={() => {
                  setRole(r);
                  remember(ROLE_KEY + app, r);
                }}
              >
                {t[roleLabelKey(r)]}
              </button>
            ))}
          </div>
          <div className="chips" role="group" aria-label={t.profileLabel}>
            {PREVIEW_PROFILES.map((p) => (
              <button
                key={p}
                type="button"
                className="chip"
                aria-pressed={p === profile}
                onClick={() => {
                  setProfile(p);
                  remember(PROFILE_KEY, p);
                }}
              >
                {profileLabel[p]}
              </button>
            ))}
          </div>
        </div>
      )}
      {page ? (
        page
      ) : location.pathname === '/' ? (
        <RoleHome
          role={activeRole}
          ctx={ctx}
          onNavigate={go}
          pendingPath={pendingPath}
          imageUrls={cardImages}
          roleName={live?.roleName ?? null}
        />
      ) : (
        <PageSoon art={current?.id ?? 'home'} onNavigate={go} />
      )}
    </AppShell>
  );
}

/** Whole app frame shared by pos / admin / guest: i18n + router + shell + role home. */
export function AppRoot(props: AppRootProps) {
  return (
    <I18nProvider brand={props.brand}>
      <BrandProvider logoSrc={brandImageUrl('logo', props.brand?.logo)}>
        <DocumentBrand brand={props.brand} />
        <BrowserRouter>
          <Frame {...props} />
        </BrowserRouter>
      </BrandProvider>
    </I18nProvider>
  );
}

/** Tab title and tab icon follow the admin's brand (the static index.html carries the defaults). */
function DocumentBrand({ brand }: { brand?: Brand }) {
  const { t } = useI18n();
  const favicon = brandImageUrl('favicon', brand?.favicon);
  useEffect(() => {
    document.title = t.appName;
  }, [t.appName]);
  useEffect(() => {
    if (!favicon) return;
    const links = document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]');
    const previous = [...links].map((l) => [l, l.href, l.type] as const);
    links.forEach((l) => {
      l.href = favicon;
      l.type = 'image/png';
    });
    return () =>
      previous.forEach(([l, href, type]) => {
        l.href = href;
        l.type = type;
      });
  }, [favicon]);
  return null;
}
