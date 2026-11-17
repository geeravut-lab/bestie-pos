import { useState } from 'react';
import { errorText, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton } from './AsyncButton';
import { Brand } from './Logo';
import { LangSwitch } from './LangSwitch';

export type AppId = 'pos' | 'admin' | 'guest';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Placeholder landing screen shared by the three apps until the real screens land
 * (role-aware home + bottom bar are the next PR). It already proves the pipeline end to end:
 * tokens, fonts, brand, i18n, language switch and the loading button.
 */
export function ScaffoldPage({ app }: { app: AppId }) {
  const { t } = useI18n();
  const [done, setDone] = useState(false);
  const [error, setError] = useState<ErrorKey | null>(null);
  const appLabel = { pos: t.appPos, admin: t.appAdmin, guest: t.appGuest }[app];

  return (
    <div className="scaffold">
      <a className="skip-link" href="#main">
        {t.skipToContent}
      </a>
      <header className="scaffold-header">
        <Brand />
        <LangSwitch />
      </header>
      <div className="scaffold-hero">
        <div className="scaffold-main" style={{ flex: 'none', paddingBottom: '1.5rem' }}>
          <p className="badge">{appLabel}</p>
          <h1 style={{ fontSize: '1.875rem', marginTop: '0.5rem' }}>{t.appTagline}</h1>
        </div>
      </div>
      <main id="main" className="scaffold-main">
        <section className="card scaffold-card">
          <span className="badge">{t.scaffoldPhase}</span>
          <h2 style={{ fontSize: '1.25rem' }}>{t.scaffoldTitle}</h2>
          <p style={{ margin: 0, color: 'var(--bp-muted)' }}>{t.scaffoldBody}</p>
          <div>
            <AsyncButton
              onClick={async () => {
                setDone(false);
                await wait(1200);
                setDone(true);
              }}
              onActionError={setError}
            >
              {t.scaffoldDemoAction}
            </AsyncButton>
          </div>
          {done ? (
            <p className="notice notice-success" role="status">
              <span aria-hidden="true">✓</span> {t.scaffoldDemoDone}
            </p>
          ) : null}
          {error ? (
            <p className="notice notice-error" role="alert">
              <span aria-hidden="true">✕</span> {errorText(error, t)}
            </p>
          ) : null}
        </section>
      </main>
    </div>
  );
}
