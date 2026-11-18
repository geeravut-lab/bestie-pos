import type { ReactNode } from 'react';
import { useI18n } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';

/** A till screen that needs this tablet to be set up as a device (its code makes order numbers unique). */
export function NeedsDevice({ ctx }: { ctx: PageContext }) {
  const { t } = useI18n();
  return (
    <div className="admin-page">
      <Notice kind="info">{t.posNeedsDevice}</Notice>
      <div className="actions">
        <AsyncButton onClick={() => ctx.navigate('/devices')}>{t.posGoDevices}</AsyncButton>
      </div>
    </div>
  );
}

export function Loading() {
  const { t } = useI18n();
  return (
    <p className="sso-working" role="status">
      <Spinner /> {t.loading}
    </p>
  );
}

export function LoadFailed({ onRetry }: { onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div className="admin-page">
      <Notice kind="error">{t.err_load_failed}</Notice>
      <AsyncButton variant="secondary" onClick={onRetry}>
        {t.retry}
      </AsyncButton>
    </div>
  );
}

export function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="admin-page">
      <h1>{title}</h1>
      {children}
    </div>
  );
}
