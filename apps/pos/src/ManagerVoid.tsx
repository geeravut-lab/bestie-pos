import { useState } from 'react';
import { errorText, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { flush, outboxCounts, pullOrderNow } from '@bestie/offline';
import { useRemote } from '@bestie/admin-ui';
import { AsyncButton } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';

type Approver = { id: string; name: string };

/**
 * Cancel a SENT line without owning `order.void`: a manager types their PIN, the server checks it (lock-out rules included),
 * performs this one cancellation and records who approved it. Nothing stays unlocked on the tablet.
 */
export function ManagerVoid({
  ctx,
  orderId,
  lineId,
  online,
}: {
  ctx: PageContext;
  orderId: string;
  lineId: string;
  online: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [manager, setManager] = useState('');
  const [pin, setPin] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState<'pin' | 'reason' | null>(null);
  const [error, setError] = useState<ErrorKey | null>(null);

  const approvers = useRemote(async (): Promise<Approver[]> => {
    if (!open || !online) return [];
    const { data, error: err } = await ctx.client.rpc('void_approvers', { p_org: ctx.orgId });
    if (err || !Array.isArray(data)) return [];
    return (data as Approver[]).filter(
      (a) => typeof a.id === 'string' && typeof a.name === 'string',
    );
  }, `${open}:${online}:${ctx.orgId}`);

  if (!open)
    return (
      <button type="button" className="btn btn-secondary" onClick={() => setOpen(true)}>
        {t.voidMgrButton}
      </button>
    );
  if (!online) return <Notice kind="info">{t.voidMgrOnline}</Notice>;

  const chosen = manager || approvers.data?.[0]?.id || '';
  const approve = async () => {
    setError(null);
    setNote(null);
    if (reason.trim().length === 0) return setNote('reason');
    // the server must see the line exactly as the tablet does
    await flush(ctx.client as never);
    if ((await outboxCounts()).pending > 0) return setError('err_pay_sync');
    const { data, error: err } = await ctx.client.rpc('void_line_with_manager', {
      p: { line_id: lineId, reason: reason.trim(), manager_id: chosen, manager_pin: pin },
    });
    setPin('');
    if (err) return setError(err.code === '42501' ? 'err_forbidden' : 'err_save_failed');
    if ((data as { ok?: boolean } | null)?.ok !== true) return setNote('pin');
    await pullOrderNow(ctx.client as never, orderId);
    setOpen(false);
  };

  return (
    <div className="confirm-box">
      <h4>{t.voidMgrTitle}</h4>
      {approvers.data && approvers.data.length === 0 ? (
        <Notice kind="info">{t.voidMgrNoApprovers}</Notice>
      ) : null}
      <div className="form-row">
        <label className="label" htmlFor={`vm-who-${lineId}`}>
          {t.voidMgrApprover}
        </label>
        <select
          id={`vm-who-${lineId}`}
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
        <label className="label" htmlFor={`vm-pin-${lineId}`}>
          {t.voidMgrPin}
        </label>
        <input
          id={`vm-pin-${lineId}`}
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
        <label className="label" htmlFor={`vm-reason-${lineId}`}>
          {t.voidMgrReason}
        </label>
        <input
          id={`vm-reason-${lineId}`}
          className="field"
          maxLength={100}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      {note === 'pin' ? <Notice kind="error">{t.voidMgrBadPin}</Notice> : null}
      {note === 'reason' ? <Notice kind="error">{t.voidMgrNeedReason}</Notice> : null}
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      <div className="actions">
        <AsyncButton variant="danger" disabled={chosen === '' || pin.length < 4} onClick={approve}>
          {t.voidMgrConfirm}
        </AsyncButton>
        <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
          {t.menuCancel}
        </button>
      </div>
    </div>
  );
}
