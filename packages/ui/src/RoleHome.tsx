import { useEffect, useRef, useState } from 'react';
import { fmt, useI18n } from '@bestie/i18n';
import { Illustration } from './Illustration';
import { NAV_BY_ID, ROLE_LAYOUT, WIDE_CARDS, disabledNavIds, roleLabelKey } from './nav';
import type { AppRole, ArtId, NavContext } from './nav';
import { Spinner } from './Spinner';

export type RoleHomeProps = {
  role: AppRole;
  ctx: NavContext;
  onNavigate: (path: string) => void;
  pendingPath?: string | null;
  /** Admin-uploaded replacements per card (docs/UX-DESIGN.md §7). Missing = built-in illustration. */
  imageUrls?: Partial<Record<ArtId, string>>;
};

/**
 * The landing screen of every role: a greeting band and illustrated cards built from the same nav list as the
 * menus. Cards of switched-off modules stay visible but grey and not clickable.
 */
export function RoleHome({
  role,
  ctx,
  onNavigate,
  pendingPath = null,
  imageUrls = {},
}: RoleHomeProps) {
  const { t } = useI18n();
  const layout = ROLE_LAYOUT[role];
  const disabled = disabledNavIds(ctx);

  return (
    <div className="home">
      <section className="home-hero">
        <p className="badge">{t[roleLabelKey(role)]}</p>
        <h1>{t.homeGreeting}</h1>
      </section>

      <ul className="card-grid">
        {layout.cards.map((id) => {
          const n = NAV_BY_ID[id];
          const off = disabled.has(id);
          const pending = pendingPath === n.path;
          const title = t[n.label];
          const body = (
            <>
              <span className="card-art">
                {imageUrls[id] ? (
                  <img
                    src={imageUrls[id]}
                    alt={fmt(t.cardImageAlt, { name: title })}
                    loading="lazy"
                  />
                ) : (
                  <Illustration art={id} />
                )}
                {off ? <span className="card-off">{t.navDisabled}</span> : null}
              </span>
              <span className="card-text">
                <span className="card-title">
                  {title}
                  {pending ? <Spinner /> : null}
                </span>
                {n.hint ? <span className="card-hint">{t[n.hint]}</span> : null}
              </span>
            </>
          );
          return (
            <li key={id} className={`card-cell${WIDE_CARDS.has(id) ? ' is-wide' : ''}`}>
              {off ? (
                <span className="card nav-card is-disabled" role="link" aria-disabled="true">
                  {body}
                </span>
              ) : (
                <a
                  className="card nav-card"
                  href={n.path}
                  aria-busy={pending || undefined}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                    e.preventDefault();
                    if (!pending) onNavigate(n.path);
                  }}
                >
                  {body}
                </a>
              )}
            </li>
          );
        })}
      </ul>
      <ScrollHint />
    </div>
  );
}

/**
 * Floating "scroll down" for people who do not realise there are more cards below (RESPONSIVE knowledge §3.4), and — once the page has
 * been scrolled — a matching "scroll up" so the top of the home page is one tap away.
 */
function ScrollHint() {
  const { t } = useI18n();
  const sentinel = useRef<HTMLDivElement>(null);
  const [atEnd, setAtEnd] = useState(true);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([entry]) => setAtEnd(Boolean(entry?.isIntersecting)));
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 240);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <>
      <div ref={sentinel} className="scroll-sentinel" />
      {!atEnd || scrolled ? (
        <div className="scroll-hints">
          {scrolled ? (
            <button
              type="button"
              className="scroll-hint"
              onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
            >
              {t.scrollUp} <span aria-hidden="true">↑</span>
            </button>
          ) : null}
          {!atEnd ? (
            <button
              type="button"
              className="scroll-hint"
              onClick={() => window.scrollBy({ top: window.innerHeight * 0.7, behavior: 'smooth' })}
            >
              {t.scrollDown} <span aria-hidden="true">↓</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
