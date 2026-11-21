import { useEffect, useState } from 'react';
import {
  cashSettlement,
  deliveryCommission,
  formatTHB,
  parsePriceInput,
  priceInputValue,
  quickCashAmounts,
} from '@bestie/core';
import type { OnlineTender, RoundingRule, Satang, SplitLeg } from '@bestie/core';
import { errorText, fmt, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { OnlinePay } from './onlinePay';
import { OnlinePane } from './OnlinePane';
import { SplitPane } from './SplitPane';

type Tab = 'cash' | 'split' | 'room' | 'platform' | OnlineTender;

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
  held = 0,
  heldDeposit = false,
  onRelease,
  roomStays,
  onRoomCharge,
  platform,
  onPlatformClose,
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
  onSplitPay?: (legs: SplitLeg[], held: Satang) => Promise<ErrorKey | null>;
  /** PromptPay / card shares already held on this bill (the bill is locked; only the split screen can finish it). */
  held?: Satang;
  /** All of `held` is a deposit taken before the visit (shown as such; nobody "gives up" a deposit here). */
  heldDeposit?: boolean;
  /** A manager gives up on a bill that holds shares (they are marked for refund, the bill is unlocked). */
  onRelease?: () => Promise<ErrorKey | null>;
  /** The customer on the bill and their Credit here; null = Credit not usable. */
  splitCredit?: { name: string; balance: Satang } | null;
  /** Guests in the house the bill may be charged to (module `folio`); empty / absent = no Room tab. */
  roomStays?: { id: string; label: string }[];
  /** `amount` is the room's share in satang; below the total means the rest is paid in cash (exact). */
  onRoomCharge?: (folioId: string, amount: Satang) => Promise<ErrorKey | null>;
  /** A delivery bill the platform pays later (module `delivery`); null / absent = no Platform tab. `name` is null until the cashier picks the platform. */
  platform?: { name: string | null; commissionBps: number } | null;
  onPlatformClose?: () => Promise<ErrorKey | null>;
  /** The owner's payment-method switches for this shop (cash is always on). */
  methods?: { promptpay: boolean; gateway: boolean };
  onClose: () => void;
}) {
  const { t, lang } = useI18n();
  const locale = lang === 'th' ? ('th-TH' as const) : ('en-GB' as const);
  const [tab, setTab] = useState<Tab>(held > 0 ? 'split' : 'cash');
  const [releaseError, setReleaseError] = useState<ErrorKey | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [onClose]);

  // with shares held on the bill only the split screen can finish it (the rest is split between cash, Credit and further QR / card)
  const tabs: { id: Tab; label: string }[] =
    held > 0
      ? [{ id: 'split', label: t.paySplitTab }]
      : [
          { id: 'cash', label: t.payTabCash },
          ...(onSplitPay ? [{ id: 'split' as const, label: t.paySplitTab }] : []),
          ...(methods.promptpay ? [{ id: 'promptpay' as const, label: t.payTabPromptPay }] : []),
          ...(methods.gateway ? [{ id: 'gateway' as const, label: t.payTabCard }] : []),
          ...(roomStays && roomStays.length > 0 && onRoomCharge
            ? [{ id: 'room' as const, label: t.payTabRoom }]
            : []),
          ...(platform && onPlatformClose
            ? [{ id: 'platform' as const, label: t.payTabPlatform }]
            : []),
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
            {held > 0 && onRelease ? (
              <div className="actions">
                <AsyncButton
                  variant="secondary"
                  onClick={async () => {
                    setReleaseError(null);
                    if (
                      !globalThis.confirm(
                        fmt(t.payHeldGiveUpConfirm, { amount: formatTHB(held, locale) }),
                      )
                    )
                      return;
                    const err = await onRelease();
                    if (err) setReleaseError(err);
                  }}
                >
                  {t.payHeldGiveUp}
                </AsyncButton>
              </div>
            ) : null}
            {releaseError ? <Notice kind="error">{errorText(releaseError, t)}</Notice> : null}
            {tab === 'cash' ? (
              <CashPane total={total} rule={rule} locale={locale} onPay={onPay} onClose={onClose} />
            ) : tab === 'split' && onSplitPay ? (
              <SplitPane
                total={total}
                rule={rule}
                locale={locale}
                online={online.available}
                pay={online}
                methods={methods}
                credit={splitCredit}
                held={held}
                heldDeposit={heldDeposit}
                onPay={onSplitPay}
                onClose={onClose}
              />
            ) : tab === 'room' && roomStays && onRoomCharge ? (
              <RoomPane stays={roomStays} total={total} locale={locale} onCharge={onRoomCharge} />
            ) : tab === 'platform' && platform && onPlatformClose ? (
              <PlatformPane
                platform={platform}
                total={total}
                locale={locale}
                onClose={onPlatformClose}
              />
            ) : tab === 'split' || tab === 'room' || tab === 'platform' ? null : (
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

/** Charge the whole bill to the room of a guest who is staying (module `folio`). */
function RoomPane({
  stays,
  total,
  locale,
  onCharge,
}: {
  stays: { id: string; label: string }[];
  total: Satang;
  locale: 'th-TH' | 'en-GB';
  onCharge: (folioId: string, amount: Satang) => Promise<ErrorKey | null>;
}) {
  const { t } = useI18n();
  const [folio, setFolio] = useState(stays[0]?.id ?? '');
  const [part, setPart] = useState(priceInputValue(total));
  const [error, setError] = useState<ErrorKey | null>(null);
  const typed = parsePriceInput(part);
  const share = typed !== null && typed > 0 && typed <= total ? typed : null;
  const go = async () => {
    setError(null);
    if (share === null) return setError('err_pay_failed');
    const err = await onCharge(folio, share);
    if (err) setError(err);
  };
  return (
    <>
      <p className="muted">{t.payRoomNote}</p>
      <dl className="preview-list tabular">
        <div>
          <dt>{t.previewTotal}</dt>
          <dd>{formatTHB(total, locale)}</dd>
        </div>
      </dl>
      <div className="form-row">
        <label className="label" htmlFor="pay-room">
          {t.payRoomPick}
        </label>
        <select
          id="pay-room"
          className="field"
          value={folio}
          onChange={(e) => setFolio(e.target.value)}
        >
          {stays.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      <div className="form-row">
        <label className="label" htmlFor="pay-room-part">
          {t.payRoomPart}
        </label>
        <input
          id="pay-room-part"
          className="field"
          inputMode="decimal"
          value={part}
          onChange={(e) => setPart(e.target.value)}
        />
        {share !== null && share < total ? (
          <p className="muted">
            {fmt(t.payRoomRest, { amount: formatTHB(total - share, locale) })}
          </p>
        ) : null}
      </div>
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      <div className="actions">
        <AsyncButton onClick={go} disabled={share === null}>
          {t.payRoomCharge}
        </AsyncButton>
      </div>
    </>
  );
}

/** Close a delivery bill the platform pays later (module `delivery`): full receipt, no cash in the drawer, the commission is worked out by the server. */
function PlatformPane({
  platform,
  total,
  locale,
  onClose,
}: {
  platform: { name: string | null; commissionBps: number };
  total: Satang;
  locale: 'th-TH' | 'en-GB';
  onClose: () => Promise<ErrorKey | null>;
}) {
  const { t } = useI18n();
  const [error, setError] = useState<ErrorKey | null>(null);
  const go = async () => {
    setError(null);
    const err = await onClose();
    if (err) setError(err);
  };
  const commission = deliveryCommission(total, platform.commissionBps);
  return (
    <>
      <p className="muted">{t.payPlatformNote}</p>
      <dl className="preview-list tabular">
        <div>
          <dt>{t.previewTotal}</dt>
          <dd>{formatTHB(total, locale)}</dd>
        </div>
      </dl>
      {platform.name ? (
        <>
          <p className="muted">
            {fmt(t.payPlatformCommission, {
              amount: formatTHB(commission, locale),
              net: formatTHB(total - commission, locale),
            })}
          </p>
          {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
          <div className="actions">
            <AsyncButton onClick={go}>
              {fmt(t.payPlatformClose, { name: platform.name })}
            </AsyncButton>
          </div>
        </>
      ) : (
        <Notice kind="info">{t.payPlatformNone}</Notice>
      )}
    </>
  );
}
