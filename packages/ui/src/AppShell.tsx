import { useState } from 'react';
import type { ReactNode } from 'react';
import { useI18n } from '@bestie/i18n';
import { Icon } from './Icons';
import { Brand } from './Logo';
import {
  NAV_BY_ID,
  activeNavId,
  disabledNavIds,
  layoutFor,
  moreItems,
  ungatePlatform,
} from './nav';
import type { AppRole, ArtId, NavContext, NavItem } from './nav';
import { Spinner } from './Spinner';
import { useBackClosableSheet } from './useBackClosableSheet';

export type ShellProps = {
  role: AppRole;
  /** A platform administrator also reaches the platform pages (AI provider, branding, flags …) from any app. */
  platformAdmin?: boolean;
  ctx: NavContext;
  path: string;
  /** Called when an item is tapped. May return a promise / start a transition; use `pendingPath` to show progress. */
  /** `replace`: a page opened from the "More" sheet takes the place of the history entry the sheet reserved. */
  onNavigate: (path: string, replace?: boolean) => void;
  /** Path being loaded right now → spinner on that item + progress bar (spinner rule). */
  pendingPath?: string | null;
  /** Right side of the top bar (language switch, bell, …). */
  headerRight?: ReactNode;
  children: ReactNode;
};

/** Every id the role can reach, in a stable order: home first, then bar items, then the rest. */
export function roleNavIds(role: AppRole, platformAdmin = false): ArtId[] {
  const l = layoutFor(role, platformAdmin);
  return [...new Set<ArtId>(['home', ...l.tabs, ...(l.center ? [l.center] : []), ...l.cards])];
}

function NavLink({
  navItem,
  active,
  disabled,
  pending,
  onNavigate,
  className,
  children,
}: {
  navItem: NavItem;
  active: boolean;
  disabled: boolean;
  pending: boolean;
  onNavigate: (p: string) => void;
  className: string;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const label = t[navItem.label];
  if (disabled) {
    return (
      <span
        className={`${className} is-disabled`}
        role="link"
        aria-disabled="true"
        title={t.navDisabled}
        aria-label={`${label} — ${t.navDisabled}`}
      >
        {children}
      </span>
    );
  }
  return (
    <a
      className={`${className}${active ? ' is-active' : ''}`}
      href={navItem.path}
      aria-current={active ? 'page' : undefined}
      aria-busy={pending || undefined}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // let "open in new tab" work
        e.preventDefault();
        if (!pending && !active) onNavigate(navItem.path);
      }}
    >
      {children}
      {pending ? <Spinner className="nav-spinner" /> : null}
    </a>
  );
}

/**
 * One shell, three layouts (single breakpoint 768 px, tablet rail is CSS only):
 * phone = top bar + bottom bar (4 tabs + raised centre action + More sheet); tablet = icon rail; desktop = sidebar.
 */
export function AppShell({
  role,
  platformAdmin = false,
  ctx,
  path,
  onNavigate,
  pendingPath = null,
  headerRight,
  children,
}: ShellProps) {
  const { t } = useI18n();
  const [moreOpen, setMoreOpen] = useState(false);
  const sheet = useBackClosableSheet(moreOpen, () => setMoreOpen(false));

  const layout = layoutFor(role, platformAdmin);
  const disabled = ungatePlatform(disabledNavIds(ctx), platformAdmin);
  const active = activeNavId(path);
  const pendingId = pendingPath ? activeNavId(pendingPath) : undefined;
  const more = moreItems(role, platformAdmin);
  const moreActive = active !== undefined && more.includes(active);

  const link = (id: ArtId, className: string, content: (n: NavItem) => ReactNode) => {
    const n = NAV_BY_ID[id];
    return (
      <NavLink
        key={id}
        navItem={n}
        active={active === id}
        disabled={disabled.has(id)}
        pending={pendingId === id}
        onNavigate={(p) => {
          if (moreOpen) {
            sheet.keepEntry();
            setMoreOpen(false);
            onNavigate(p, true);
          } else onNavigate(p);
        }}
        className={className}
      >
        {content(n)}
      </NavLink>
    );
  };

  const tabs = layout.tabs;
  const barItem = (id: ArtId) =>
    link(id, 'bar-item', (n) => (
      <>
        <Icon name={id} />
        <span className="bar-label">{t[n.label]}</span>
      </>
    ));

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        {t.skipToContent}
      </a>
      {pendingPath ? (
        <div className="nav-progress" role="progressbar" aria-label={t.navOpening} />
      ) : null}

      <aside className="sidebar" aria-label={t.navMain}>
        <div className="sidebar-brand">
          <Brand />
        </div>
        <nav className="sidebar-nav">
          {roleNavIds(role, platformAdmin).map((id) =>
            link(id, 'side-item', (n) => (
              <>
                <Icon name={id} />
                <span className="side-label">{t[n.label]}</span>
              </>
            )),
          )}
        </nav>
      </aside>

      <div className="shell-body">
        <header className="topbar">
          <span className="topbar-brand">
            <Brand />
          </span>
          <div className="topbar-right">{headerRight}</div>
        </header>
        <main id="main" className="shell-main">
          {children}
        </main>
      </div>

      <nav className="bar" aria-label={t.navMain}>
        {barItem(tabs[0])}
        {barItem(tabs[1])}
        {layout.center ? (
          link(layout.center, 'bar-item bar-center', (n) => (
            <>
              <span className="bar-center-disc">
                <Icon name={layout.center!} size={28} />
              </span>
              <span className="bar-label">{t[n.label]}</span>
            </>
          ))
        ) : (
          <span className="bar-spacer" aria-hidden="true" />
        )}
        {barItem(tabs[2])}
        {more.length > 0 ? (
          <button
            type="button"
            className={`bar-item${moreActive ? ' is-active' : ''}`}
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen(true)}
          >
            <Icon name="more" />
            <span className="bar-label">{t.navMore}</span>
          </button>
        ) : (
          <span className="bar-spacer" aria-hidden="true" />
        )}
      </nav>

      {moreOpen ? (
        <div className="more-root">
          <button
            type="button"
            className="more-backdrop"
            aria-label={t.navMoreClose}
            onClick={() => setMoreOpen(false)}
          />
          <div className="more-sheet" role="dialog" aria-modal="true" aria-label={t.navMore}>
            <div className="sheet-head">
              <h2>{t.navMore}</h2>
              <button
                type="button"
                className="sheet-close"
                aria-label={t.navMoreClose}
                onClick={() => setMoreOpen(false)}
              >
                <Icon name="close" />
              </button>
            </div>
            <div className="sheet-list">
              {more.map((id) =>
                link(id, 'sheet-item', (n) => (
                  <>
                    <Icon name={id} />
                    <span className="sheet-text">
                      <span className="sheet-title">{t[n.label]}</span>
                      {n.hint ? <span className="sheet-hint">{t[n.hint]}</span> : null}
                    </span>
                  </>
                )),
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
