import { useEffect, useState } from 'react';
import { formatTHB } from '@bestie/core';
import { errorText, fmt, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { cancelTopup, findLiveTopup, readTopup, startTopup } from './topupOnline';
import type { TopupCharge, TopupTender } from './topupOnline';

type Phase =
  | { kind: 'idle' }
  | { kind: 'waiting'; charge: TopupCharge; resumed: boolean }
  | { kind: 'problem'; message: string; review: boolean };

const POLL_MS = 2000;

/**
 * Top up Bestie Credit by PromptPay QR or the shop's card reader. The customer is credited ONLY when Stripe's signed
 * webhook confirms the money (never by this screen): here we show the QR / "tap the card", poll the attempt and say when it is done.
 */
export function CreditOnlineTopup({
  ctx,
  customerId,
  storeId,
  deviceId,
  hasReader,
  amount,
  amountOk,
  onBadAmount,
  onCredited,
}: {
  ctx: PageContext;
  customerId: string;
  storeId: string;
  deviceId: string | null;
  hasReader: boolean;
  /** satang, already parsed and range-checked by the parent (null = not valid yet). */
  amount: number | null;
  amountOk: boolean;
  onBadAmount: () => void;
  onCredited: () => void;
}) {
  const { t, lang } = useI18n();
  const locale = lang === 'th' ? ('th-TH' as const) : ('en-GB' as const);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [error, setError] = useState<ErrorKey | null>(null);
  const offline = globalThis.navigator?.onLine === false;

  // a top-up of this customer that is already waiting is shown again, never duplicated
  useEffect(() => {
    let alive = true;
    findLiveTopup(ctx.client, customerId).then(
      (c) => alive && c && setPhase({ kind: 'waiting', charge: c, resumed: true }),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [ctx.client, customerId]);

  const attemptId = phase.kind === 'waiting' ? phase.charge.attemptId : null;
  useEffect(() => {
    if (!attemptId) return;
    let alive = true;
    const tick = async () => {
      try {
        const s = await readTopup(ctx.client, attemptId);
        if (!alive || !s) return;
        if (s.status === 'succeeded') {
          setPhase({ kind: 'idle' });
          onCredited();
        } else if (s.status === 'needs_review') {
          setPhase({ kind: 'problem', message: t.payReview, review: true });
        } else if (s.status === 'failed' || s.status === 'canceled') {
          setPhase({
            kind: 'problem',
            message: fmt(t.payFailedWith, { reason: s.error ?? s.status }),
            review: false,
          });
        }
      } catch {
        /* a missed poll is fine: the next one asks again */
      }
    };
    const i = setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(i);
    };
  }, [attemptId, ctx.client, onCredited, t]);

  const start = async (tender: TopupTender) => {
    setError(null);
    if (!amountOk || amount === null) return onBadAmount();
    if (!deviceId) return setError('err_topup_no_device');
    const r = await startTopup({
      client: ctx.client,
      customerId,
      storeId,
      deviceId,
      tender,
      amount,
    });
    if ('error' in r) return setError(r.error);
    setPhase({ kind: 'waiting', charge: r.charge, resumed: false });
  };

  if (phase.kind === 'waiting') {
    const c = phase.charge;
    return (
      <div className="pay-waiting" aria-live="polite">
        {phase.resumed ? <Notice kind="info">{t.creditTopupResumed}</Notice> : null}
        <p>
          {fmt(c.tender === 'promptpay' ? t.payScanThis : t.payTapCard, {
            amount: formatTHB(c.amount, locale),
          })}
        </p>
        {c.tender === 'promptpay' && c.qrImageUrl ? (
          <img className="pay-qr" src={c.qrImageUrl} alt={t.payQrAlt} width={240} height={240} />
        ) : null}
        <p className="sso-working" role="status">
          <Spinner /> {t.payWaiting}
        </p>
        <AsyncButton
          variant="secondary"
          onClick={async () => {
            await cancelTopup(ctx.client, c.attemptId);
            setPhase({ kind: 'idle' });
          }}
        >
          {t.payCancel}
        </AsyncButton>
      </div>
    );
  }

  return (
    <div className="actions" role="group" aria-label={t.creditTopupOnline}>
      {phase.kind === 'problem' ? <Notice kind="error">{phase.message}</Notice> : null}
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      {offline ? <Notice kind="info">{t.payOnlineOnly}</Notice> : null}
      <AsyncButton variant="secondary" onClick={() => start('promptpay')} disabled={offline}>
        {t.creditTopupPromptPay}
      </AsyncButton>
      {hasReader ? (
        <AsyncButton variant="secondary" onClick={() => start('gateway')} disabled={offline}>
          {t.creditTopupCard}
        </AsyncButton>
      ) : null}
    </div>
  );
}
