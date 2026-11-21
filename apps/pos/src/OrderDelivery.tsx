import { useState } from 'react';
import { parseDeliveryInfo, parseDeliveryPlatforms } from '@bestie/core';
import type { DeliveryInfo, DeliveryPlatform } from '@bestie/core';
import { useRemote } from '@bestie/admin-ui';
import { errorText, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';

export type DeliveryBill = { platforms: DeliveryPlatform[]; info: DeliveryInfo };

/** The platforms of the shop and what this delivery bill already says about its platform and customer (online; offline nothing is shown). */
export function useDeliveryBill(ctx: PageContext, orderId: string, enabled: boolean) {
  return useRemote<DeliveryBill | null>(async () => {
    if (!enabled) return null;
    const [p, o] = await Promise.all([
      ctx.client
        .from('delivery_platforms')
        .select('id, code, name, commission_bps, active, token_hint')
        .eq('active', true),
      ctx.client
        .from('orders')
        .select('delivery_platform_id, external_ref, delivery_info')
        .eq('id', orderId)
        .maybeSingle(),
    ]);
    if (p.error || o.error) return null;
    return { platforms: parseDeliveryPlatforms(p.data), info: parseDeliveryInfo(o.data) };
  }, `${orderId}:${enabled}`);
}

/** Which platform pays for this bill, the platform's own order number and the customer (module `delivery`). */
export function OrderDelivery({
  ctx,
  orderId,
  bill,
  reload,
  online,
}: {
  ctx: PageContext;
  orderId: string;
  bill: DeliveryBill;
  reload: () => void;
  online: boolean;
}) {
  const { t } = useI18n();
  const canEdit = ctx.isOwner || ctx.permissions.includes('order.create');
  const [platformId, setPlatformId] = useState(bill.info.platformId ?? '');
  const [ref, setRef] = useState(bill.info.ref ?? '');
  const [name, setName] = useState(bill.info.name ?? '');
  const [phone, setPhone] = useState(bill.info.phone ?? '');
  const [address, setAddress] = useState(bill.info.address ?? '');
  const [note, setNote] = useState<'saved' | 'dup' | null>(null);
  const [error, setError] = useState<ErrorKey | null>(null);

  const save = async () => {
    setError(null);
    setNote(null);
    if (!platformId) return setError('err_save_failed');
    const { error: err } = await ctx.client.rpc('set_delivery_info', {
      p: {
        order_id: orderId,
        platform_id: platformId,
        external_ref: ref.trim() || null,
        name: name.trim() || null,
        phone: phone.trim() || null,
        address: address.trim() || null,
      },
    });
    if (err) {
      if (err.code === '23505') return setNote('dup');
      return setError(err.code === '42501' ? 'err_forbidden' : 'err_save_failed');
    }
    setNote('saved');
    reload();
  };

  return (
    <section className="card admin-card" aria-label={t.dlvTitle}>
      <h2>{t.dlvTitle}</h2>
      {bill.platforms.length === 0 ? <Notice kind="info">{t.dlvNoPlatforms}</Notice> : null}
      {!online ? <Notice kind="info">{t.dlvOnline}</Notice> : null}
      <div className="form-row">
        <label className="label" htmlFor="dlv-platform">
          {t.dlvPlatform}
        </label>
        <select
          id="dlv-platform"
          className="field"
          value={platformId}
          disabled={!canEdit}
          onChange={(e) => setPlatformId(e.target.value)}
        >
          <option value="">{t.dlvPick}</option>
          {bill.platforms.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      {(
        [
          ['dlv-ref', t.dlvRef, ref, setRef, 60],
          ['dlv-name', t.dlvName, name, setName, 80],
          ['dlv-phone', t.dlvPhone, phone, setPhone, 30],
          ['dlv-address', t.dlvAddress, address, setAddress, 200],
        ] as const
      ).map(([id, label, value, set, max]) => (
        <div key={id} className="form-row">
          <label className="label" htmlFor={id}>
            {label}
          </label>
          <input
            id={id}
            className="field"
            maxLength={max}
            value={value}
            disabled={!canEdit}
            onChange={(e) => set(e.target.value)}
          />
        </div>
      ))}
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      {note === 'dup' ? <Notice kind="error">{t.dlvDup}</Notice> : null}
      {note === 'saved' ? <Notice kind="success">{t.dlvSaved}</Notice> : null}
      {canEdit ? (
        <div className="actions">
          <AsyncButton onClick={save} disabled={!online || !platformId}>
            {t.dlvSave}
          </AsyncButton>
        </div>
      ) : null}
    </section>
  );
}
