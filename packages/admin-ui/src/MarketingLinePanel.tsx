import { useState } from 'react';
import { fmt, useI18n } from '@bestie/i18n';
import { getDeviceBinding } from '@bestie/offline';
import { AsyncButton } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';

/** On the member page (module `marketing`): a one-time code the member sends to the shop's LINE. Sending it IS her consent to offers. */
export function MarketingLinePanel({ ctx, customerId }: { ctx: PageContext; customerId: string }) {
  const { t } = useI18n();
  const storeId = getDeviceBinding()?.storeId ?? ctx.homeStoreId ?? ctx.storeId;
  const [res, setRes] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  if (!storeId || !(ctx.isModuleOn?.('marketing') ?? false)) return null;
  if (!(ctx.isOwner || ctx.permissions.includes('order.create'))) return null;
  const make = async () => {
    setRes(null);
    const r = await ctx.client.rpc('marketing_line_code', {
      p: { store_id: storeId, customer_id: customerId },
    });
    const o = (r.data ?? {}) as { code?: string; minutes?: number };
    if (r.error || !o.code) return setRes({ kind: 'error', text: t.mklErr });
    setRes({ kind: 'success', text: fmt(t.mklCode, { code: o.code, min: o.minutes ?? 30 }) });
  };
  return (
    <section className="card admin-card" aria-label={t.mklTitle}>
      <h2>{t.mklTitle}</h2>
      {res ? <Notice kind={res.kind}>{res.text}</Notice> : null}
      <AsyncButton variant="secondary" onClick={make}>
        {t.mklBtn}
      </AsyncButton>
    </section>
  );
}
