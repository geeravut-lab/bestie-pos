import { useEffect, useState } from 'react';
import { formatTHB } from '@bestie/core';
import type { OnlineTender, Satang } from '@bestie/core';
import { errorText, fmt, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { Charge, OnlinePay, SplitStep } from './onlinePay';

type Phase =
  | { kind: 'idle' }
  | { kind: 'waiting'; charge: Charge; resumed: boolean }
  | { kind: 'problem'; message: string; review: boolean };

const POLL_MS = 2000;

export function OnlinePane({
  tender,
  total,
  locale,
  online,
  split,
  onPaid,
  onClose,
}: {
  tender: OnlineTender;
  total: Satang;
  locale: 'th-TH' | 'en-GB';
  online: OnlinePay;
  /** A split bill: all its shares and which PromptPay / card share this pane charges. */
  split?: SplitStep;
  /** An EARLIER share of a split bill: when it is paid (held on the bill) go on to the next one instead of finishing. */
  onPaid?: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [error, setError] = useState<ErrorKey | null>(null);
  const blocked = !online.available
    ? t.payOnlineOnly
    : tender === 'gateway' && !online.hasReader
      ? t.payNoReader
      : null;

  // a payment for this bill that is already waiting (refresh, another tablet) is shown again, never duplicated
  useEffect(() => {
    if (blocked) return;
    let alive = true;
    online.findLive().then(
      (c) =>
        alive &&
        c &&
        c.tender === tender &&
        setPhase({ kind: 'waiting', charge: c, resumed: true }),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [blocked, online, tender]);

  const attemptId = phase.kind === 'waiting' ? phase.charge.attemptId : null;
  useEffect(() => {
    if (!attemptId) return;
    let alive = true;
    const tick = async () => {
      try {
        const s = await online.status(attemptId);
        if (!alive || !s) return;
        if (s.status === 'succeeded') {
          if (onPaid) onPaid();
          else await online.finish();
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
  }, [attemptId, online, onPaid, t]);

  const start = async () => {
    setError(null);
    const r = split ? await online.start(tender, split) : await online.start(tender);
    if ('error' in r) return setError(r.error);
    setPhase({ kind: 'waiting', charge: r.charge, resumed: false });
  };

  return (
    <>
      <p className="tabular">
        <strong>
          {t.payDue}: {formatTHB(total, locale)}
        </strong>
      </p>
      {blocked ? <Notice kind="info">{blocked}</Notice> : null}
      {phase.kind === 'idle' && !blocked ? (
        <AsyncButton onClick={start}>
          {tender === 'promptpay' ? t.payShowQr : t.payStartCard}
        </AsyncButton>
      ) : null}
      {phase.kind === 'waiting' ? (
        <div className="pay-waiting" aria-live="polite">
          {phase.resumed ? <Notice kind="info">{t.payResumed}</Notice> : null}
          <p>
            {fmt(tender === 'promptpay' ? t.payScanThis : t.payTapCard, {
              amount: formatTHB(phase.charge.amount, locale),
            })}
          </p>
          {tender === 'promptpay' && phase.charge.qrImageUrl ? (
            <img
              className="pay-qr"
              src={phase.charge.qrImageUrl}
              alt={t.payQrAlt}
              width={240}
              height={240}
            />
          ) : null}
          <p className="sso-working" role="status">
            <Spinner /> {t.payWaiting}
          </p>
          <AsyncButton
            variant="secondary"
            onClick={async () => {
              await online.cancel(phase.charge.attemptId);
              setPhase({ kind: 'idle' });
            }}
          >
            {t.payCancel}
          </AsyncButton>
        </div>
      ) : null}
      {phase.kind === 'problem' ? (
        <>
          <Notice kind="error">{phase.message}</Notice>
          {!phase.review ? (
            <AsyncButton onClick={() => setPhase({ kind: 'idle' })}>{t.retry}</AsyncButton>
          ) : null}
        </>
      ) : null}
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      <div className="actions">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          {t.menuCancel}
        </button>
      </div>
    </>
  );
}
