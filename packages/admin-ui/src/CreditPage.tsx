import { useI18n } from '@bestie/i18n';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { CreditLiabilityPanel } from './CreditLiabilityPanel';

/** The "Credit" page: what each company owes its customers in unspent Bestie Credit. Topping up and spending happen on the member page and at the till. */
export function CreditPage({ ctx }: { ctx: PageContext }) {
  const { t } = useI18n();
  const canView = ctx.isOwner || ctx.permissions.includes('report.view');
  return (
    <div className="admin-page">
      <h1>{t.crpTitle}</h1>
      <Notice kind="info">{t.crpIntro}</Notice>
      {!(ctx.isModuleOn?.('tender.credit') ?? false) ? (
        <Notice kind="info">{t.crpOff}</Notice>
      ) : null}
      {canView ? (
        <CreditLiabilityPanel ctx={ctx} />
      ) : (
        <Notice kind="info">{t.err_forbidden}</Notice>
      )}
      <button
        type="button"
        className="btn btn-secondary"
        onClick={() => ctx.navigate('/customers')}
      >
        {t.crpOpenMembers}
      </button>
    </div>
  );
}
