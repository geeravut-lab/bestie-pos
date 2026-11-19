import { useEffect, useState } from 'react';
import {
  cashSettlement,
  formatTHB,
  parsePriceInput,
  priceInputValue,
  quickCashAmounts,
} from '@bestie/core';
import type { OnlineTender, RoundingRule, Satang, SplitLeg } from '@bestie/core';
import { errorText, fmt, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { Charge, OnlinePay } from './onlinePay';
import { SplitPane } from './SplitPane';

type Tab = 'cash' | 'split' | OnlineTender;

/** Choose how the guest pays: cash (works offline), PromptPay QR or the card reader (both need the network). */
export function PaySheet({
  total,
  rule,
  online,
  shiftBlocked = false,
  onOpenShift,
  onPay,
  onSplitPay,
  splitCredit = null,
  methods = { promptpay: true, gateway: true },
  onClose,
}: {
  /** The bill total BEFORE cash rounding. */
  total: Satang;
  rule: RoundingRule;
  online: OnlinePay;
  /** The shop wants an open cash shift before any payment, and there is none on this device. */
  shiftBlocked?: boolean;
  onOpenShift?: () => void;
  onPay: (tendered: Satang) => Promise<ErrorKey | null>;
  /** Several payers, cash and / or Credit, one receipt (online). */
  onSplitPay?: (legs: SplitLeg[]) => Promise<ErrorKey | null>;
  /** The customer on the bill and their Credit here; null = Credit not usable. */
  splitCredit?: { name: string; balance: Satang } | null;
  /** The owner's payment-method switches for this shop (cash is always on). */
  methods?: { promptpay: boolean; gateway: boolean };
  onClose: () => void;
}) {
  const { t, lang } = useI18n();
  const locale = lang === 'th' ? ('th-TH' as const) : ('en-GB' as const);
  const [tab, setTab] = useState<Tab>('cash');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [onClose]);

  const tabs: { id: Tab; label: string }[] = [
    { id: 'cash', label: t.payTabCash },
    ...(onSplitPay ? [{ id: 'split' as const, label: t.paySplitTab }] : []),
    ...(methods.promptpay ? [{ id: 'promptpay' as const, label: t.payTabPromptPay }] : []),
    ...(methods.gateway ? [{ id: 'gateway' as const, label: t.payTabCard }] : []),
  ];

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t.payTitle}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>{t.payTitle}</h2>
        {shiftBlocked ? (
          <>
            <Notice kind="info">{t.shiftOpenFirst}</Notice>
            <div className="actions">
              <AsyncButton onClick={() => onOpenShift?.()}>{t.shiftGo}</AsyncButton>
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                {t.menuCancel}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="tabs" role="tablist" aria-label={t.payTitle}>
              {tabs.map((x) => (
                <button
                  key={x.id}
                  type="button"
                  role="tab"
                  className="tab"
                  aria-selected={tab === x.id}
                  onClick={() => setTab(x.id)}
                >
                  {x.label}
                </button>
              ))}
            </div>
            {tab === 'cash' ? (
              <CashPane total={total} rule={rule} locale={locale} onPay={onPay} onClose={onClose} />
            ) : tab === 'split' && onSplitPay ? (
              <SplitPane
                total={total}
                rule={rule}
                locale={locale}
                online={online.available}
                credit={splitCredit}
                onPay={onSplitPay}
                onClose={onClose}
              />
            ) : tab === 'split' ? null : (
              <OnlinePane
                key={tab}
                tender={tab}
                total={total}
                locale={locale}
                online={online}
                onClose={onClose}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function CashPane({
  total,
  rule,
  locale,
  onPay,
  onClose,
}: {
  total: Satang;
  rule: RoundingRule;
  locale: 'th-TH' | 'en-GB';
  onPay: (tendered: Satang) => Promise<ErrorKey | null>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [error, setError] = useState<ErrorKey | null>(null);
  const tendered = parsePriceInput(text) ?? 0;
  const s = cashSettlement(total, rule, tendered);

  const confirm = async () => {
    setError(null);
    if (s.payable <= 0 || s.short > 0 || parsePriceInput(text) === null)
      return setError('err_pay_failed');
    const err = await onPay(tendered);
    if (err) setError(err);
  };

  return (
    <>
      <dl className="preview-list tabular">
        {s.rounding !== 0 ? (
          <div>
            <dt>{t.payRounding}</dt>
            <dd>
              {s.rounding > 0 ? '+' : '−'}
              {formatTHB(Math.abs(s.rounding), locale)}
            </dd>
          </div>
        ) : null}
        <div>
          <dt>
            <strong>{t.payDue}</strong>
          </dt>
          <dd>
            <strong>{formatTHB(s.payable, locale)}</strong>
          </dd>
        </div>
      </dl>
      <div className="chips" role="group" aria-label={t.payDue}>
        {quickCashAmounts(s.payable).map((a) => (
          <button
            key={a}
            type="button"
            className="chip"
            onClick={() => setText(priceInputValue(a))}
          >
            {a === s.payable ? t.payExact : formatTHB(a, locale)}
          </button>
        ))}
      </div>
      <div className="form-row">
        <label className="label" htmlFor="pay-received">
          {t.payReceived}
        </label>
        <input
          id="pay-received"
          className="field tabular"
          inputMode="decimal"
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      <p aria-live="polite" className="tabular pay-result">
        {text === '' ? null : s.short > 0 ? (
          <span className="pay-short">
            {fmt(t.payShort, { amount: formatTHB(s.short, locale) })}
          </span>
        ) : (
          <strong>
            {t.payChange}: {formatTHB(s.change, locale)}
          </strong>
        )}
      </p>
      <p className="muted">{t.payNote}</p>
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      <div className="actions">
        <AsyncButton disabled={s.payable <= 0 || s.short > 0 || text === ''} onClick={confirm}>
          {t.payConfirm}
        </AsyncButton>
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          {t.menuCancel}
        </button>
      </div>
    </>
  );
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'waiting'; charge: Charge; resumed: boolean }
  | { kind: 'problem'; message: string; review: boolean };

const POLL_MS = 2000;

function OnlinePane({
  tender,
  total,
  locale,
  online,
  onClose,
}: {
  tender: OnlineTender;
  total: Satang;
  locale: 'th-TH' | 'en-GB';
  online: OnlinePay;
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
          await online.finish();
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
  }, [attemptId, online, t]);

  const start = async () => {
    setError(null);
    const r = await online.start(tender);
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
