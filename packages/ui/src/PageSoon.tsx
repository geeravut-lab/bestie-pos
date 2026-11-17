import { useI18n } from '@bestie/i18n';
import { Icon } from './Icons';
import { Illustration } from './Illustration';
import { NAV_BY_ID } from './nav';
import type { ArtId } from './nav';

/** "Back to <parent>" link: every page that is not a menu entry needs one (a PWA has no browser Back button). */
export function BackLink({
  to,
  label,
  onNavigate,
}: {
  to: string;
  label: string;
  onNavigate: (path: string) => void;
}) {
  const { t, fmt } = useI18n();
  return (
    <a
      className="back-link"
      href={to}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        onNavigate(to);
      }}
    >
      <Icon name="back" size={20} />
      {fmt(t.navBackTo, { page: label })}
    </a>
  );
}

/** Placeholder for sections that are planned but not built yet; keeps every menu entry working. */
export function PageSoon({ art, onNavigate }: { art: ArtId; onNavigate: (path: string) => void }) {
  const { t } = useI18n();
  const n = NAV_BY_ID[art];
  return (
    <div className="page-soon">
      <BackLink to="/" label={t.navHome} onNavigate={onNavigate} />
      <section className="card page-soon-card">
        <div className="page-soon-art">
          <Illustration art={art} />
        </div>
        <h1>{t[n.label]}</h1>
        <p>{t.pageSoonTitle}</p>
        <p className="muted">{t.pageSoonBody}</p>
      </section>
    </div>
  );
}
