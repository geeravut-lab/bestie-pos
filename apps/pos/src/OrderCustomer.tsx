import { useState } from 'react';
import { parseCustomerCard } from '@bestie/core';
import { CustomerPicker, useRemote } from '@bestie/admin-ui';
import { errorText, fmt, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';

/** Who this bill belongs to (earns Bestie Points when it is paid). Online only; the till never needs it to sell. */
export function OrderCustomer({
  ctx,
  orderId,
  open,
  online,
}: {
  ctx: PageContext;
  orderId: string;
  open: boolean;
  online: boolean;
}) {
  const { t } = useI18n();
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<ErrorKey | null>(null);
  const canSee = ctx.isOwner || ctx.permissions.includes('customer.view');

  const { data, reload } = useRemote(async () => {
    if (!online || !canSee) return null;
    const o = await ctx.client.from('orders').select('customer_id').eq('id', orderId).maybeSingle();
    const cid = (o.data as { customer_id?: string | null } | null)?.customer_id;
    if (o.error || !cid) return null;
    const [c, bal] = await Promise.all([
      ctx.client
        .from('customers')
        .select('id, name, phone, member_code')
        .eq('id', cid)
        .maybeSingle(),
      ctx.client.rpc('points_balance', { p_customer: cid }),
    ]);
    if (c.error || !c.data) return null;
    return parseCustomerCard({ ...(c.data as object), balance: Number(bal.data ?? 0) });
  }, `${orderId}:${online}:${canSee}`);

  if (!online || !canSee) return null;

  const attach = async (customerId: string | null) => {
    setError(null);
    const { error: err } = await ctx.client.rpc('set_order_customer', {
      p_order: orderId,
      p_customer: customerId,
    });
    if (err) return setError(err.code === '42501' ? 'err_forbidden' : 'err_save_failed');
    setPicking(false);
    reload();
  };

  return (
    <div className="order-customer">
      {data ? (
        <p>
          {fmt(t.custOnBill, { name: data.name, points: data.points })}{' '}
          {open ? (
            <AsyncButton variant="secondary" onClick={() => attach(null)}>
              {t.custRemove}
            </AsyncButton>
          ) : null}
        </p>
      ) : open && !picking ? (
        <button type="button" className="btn btn-secondary" onClick={() => setPicking(true)}>
          {t.custAttach}
        </button>
      ) : null}
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      {picking && open && !data ? (
        <section className="card admin-card">
          <CustomerPicker ctx={ctx} idPrefix="order-cust" onPick={(c) => attach(c.id)} />
          <button type="button" className="btn btn-secondary" onClick={() => setPicking(false)}>
            {t.custClose}
          </button>
        </section>
      ) : null}
    </div>
  );
}
