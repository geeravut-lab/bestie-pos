import { useEffect, useState } from 'react';
import {
  cashSettlement,
  formatTHB,
  parsePriceInput,
  priceInputValue,
  quickCashAmounts,
} from '@bestie/core';
import type { RoundingRule, Satang } from '@bestie/core';
import { errorText, fmt, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { Notice } from '@bestie/auth';

/** Cash payment: the amount due (with the shop's cash rounding), quick amounts, change — and nothing else to get wrong. */
export function PaySheet({
  total,
  rule,
  onPay,
  onClose,
}: {
  /** The bill total BEFORE cash rounding. */
  total: Satang;
  rule: RoundingRule;
  onPay: (tendered: Satang) => Promise<ErrorKey | null>;
  onClose: () => void;
}) {
  const { t, lang } = useI18n();
  const locale = lang === 'th' ? ('th-TH' as const) : ('en-GB' as const);
  const [text, setText] = useState('');
  const [error, setError] = useState<ErrorKey | null>(null);
  const tendered = parsePriceInput(text) ?? 0;
  const s = cashSettlement(total, rule, tendered);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [onClose]);

  const confirm = async () => {
    setError(null);
    if (s.payable <= 0 || s.short > 0 || parsePriceInput(text) === null)
      return setError('err_pay_failed');
    const err = await onPay(tendered);
    if (err) setError(err);
  };

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
      </div>
    </div>
  );
}
