import { useState } from 'react';
import { formatTHB, parsePriceInput } from '@bestie/core';
import { errorText, fmt, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { flush, outboxCounts, pullOrderNow } from '@bestie/offline';
import { useRemote } from '@bestie/admin-ui';
import { AsyncButton } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';

type Approver = { id: string; name: string };

/**
 * A discount on the whole bill, approved by a manager's PIN (online only): the server lowers the prices of the bill's lines in proportion, so the receipt,
 * VAT, split tender and Points all see the discounted bill. Who approved, how much and why is a permanent audit record. Nothing stays unlocked on the tablet.
 */
export function OrderDiscount({
  ctx,
  orderId,
  storeId,
  online,
}: {
  ctx: PageContext;
  orderId: string;
  storeId: string;
  online: boolean;
}) {
  const { t, lang } = useI18n();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<'percent' | 'amount'>('percent');
  const [value, setValue] = useState('');
  const [manager, setManager] = useState('');
  const [pin, setPin] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState<'pin' | 'reason' | 'value' | 'done' | null>(null);
  const [applied, setApplied] = useState(0);
  const [error, setError] = useState<ErrorKey | null>(null);

  const approvers = useRemote(async (): Promise<Approver[]> => {
    if (!open || !online) return [];
    const { data, error: err } = await ctx.client.rpc('discount_approvers', { p_store: storeId });
    if (err || !Array.isArray(data)) return [];
    return (data as Approver[]).filter(
      (a) => typeof a.id === 'string' && typeof a.name === 'string',
    );
  }, `${open}:${online}:${storeId}`);

  if (!open)
    return (
      <div className="actions">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => {
            setNote(null);
            setOpen(true);
          }}
        >
          {t.odButton}
        </button>
        {note === 'done' ? (
          <span role="status">
            {fmt(t.odDone, { amount: formatTHB(applied, lang === 'th' ? 'th-TH' : 'en-GB') })}
          </span>
        ) : null}
      </div>
    );
  if (!online) return <Notice kind="info">{t.odOnline}</Notice>;

  const chosen = manager || approvers.data?.[0]?.id || '';
  const approve = async () => {
    setError(null);
    setNote(null);
    const v =
      kind === 'percent' ? Number(value.replace(',', '.')) : (parsePriceInput(value) ?? 0) / 100;
    if (!Number.isFinite(v) || v <= 0 || (kind === 'percent' && v > 100)) return setNote('value');
    if (reason.trim().length === 0) return setNote('reason');
    await flush(ctx.client as never); // the server must see the bill exactly as the tablet does
    if ((await outboxCounts()).pending > 0) return setError('err_pay_sync');
    const { data, error: err } = await ctx.client.rpc('discount_with_manager', {
      p: {
        order_id: orderId,
        kind,
        value: kind === 'percent' ? Math.round(v * 100) : Math.round(v * 100),
        reason: reason.trim(),
        manager_id: chosen,
        manager_pin: pin,
      },
    });
    setPin('');
    if (err) return setError(err.code === '42501' ? 'err_forbidden' : 'err_save_failed');
    const out = (data ?? {}) as { ok?: boolean; applied?: number };
    if (out.ok !== true) return setNote('pin');
    await pullOrderNow(ctx.client as never, orderId);
    setApplied(out.applied ?? 0);
    setNote('done');
    setOpen(false);
  };

  return (
    <div className="confirm-box">
      <h4>{t.odTitle}</h4>
      <p className="muted">{t.odIntro}</p>
      {approvers.data && approvers.data.length === 0 ? (
        <Notice kind="info">{t.voidMgrNoApprovers}</Notice>
      ) : null}
      <div className="chips" role="group" aria-label={t.odTitle}>
        {(['percent', 'amount'] as const).map((k) => (
          <button
            key={k}
            type="button"
            className="chip"
            aria-pressed={kind === k}
            onClick={() => setKind(k)}
          >
            {k === 'percent' ? t.odPercent : t.odAmount}
          </button>
        ))}
      </div>
      <div className="form-row">
        <label className="label" htmlFor="od-value">
          {kind === 'percent' ? t.odPercent : t.odAmount}
        </label>
        <input
          id="od-value"
          className="field tabular"
          inputMode="decimal"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
      <div className="form-row">
        <label className="label" htmlFor="od-who">
          {t.voidMgrApprover}
        </label>
        <select
          id="od-who"
          className="field"
          value={chosen}
          onChange={(e) => setManager(e.target.value)}
        >
          {(approvers.data ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>
      <div className="form-row">
        <label className="label" htmlFor="od-pin">
          {t.voidMgrPin}
        </label>
        <input
          id="od-pin"
          className="field tabular"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={8}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
        />
      </div>
      <div className="form-row">
        <label className="label" htmlFor="od-reason">
          {t.voidMgrReason}
        </label>
        <input
          id="od-reason"
          className="field"
          maxLength={100}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      {note === 'pin' ? <Notice kind="error">{t.voidMgrBadPin}</Notice> : null}
      {note === 'reason' ? <Notice kind="error">{t.voidMgrNeedReason}</Notice> : null}
      {note === 'value' ? <Notice kind="error">{t.odBadValue}</Notice> : null}
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      <div className="actions">
        <AsyncButton disabled={chosen === '' || pin.length < 4} onClick={approve}>
          {t.odConfirm}
        </AsyncButton>
        <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
          {t.menuCancel}
        </button>
      </div>
    </div>
  );
}
