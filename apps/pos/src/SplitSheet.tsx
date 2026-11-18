import { useState } from 'react';
import { formatTHB, liveLines, localizedName, picksForSeat, seatsOf } from '@bestie/core';
import type { OrderDoc, SplitPick } from '@bestie/core';
import { errorText, fmt, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { Notice } from '@bestie/auth';

/** Split a bill: pick items (any quantity, sent or not) or take a whole seat. Each result is paid on its own. */
export function SplitSheet({
  order,
  onSplit,
  onClose,
}: {
  order: OrderDoc;
  onSplit: (picks: SplitPick[]) => Promise<ErrorKey | null>;
  onClose: () => void;
}) {
  const { t, lang } = useI18n();
  const locale = lang === 'th' ? ('th-TH' as const) : ('en-GB' as const);
  const lines = liveLines(order);
  const seats = seatsOf(order);
  const [mode, setMode] = useState<'items' | 'seats'>('items');
  const [qty, setQty] = useState<Record<string, number>>({});
  const [seat, setSeat] = useState<number | null>(seats[0] ?? null);
  const [error, setError] = useState<ErrorKey | null>(null);

  const picks: SplitPick[] =
    mode === 'seats'
      ? seat === null
        ? []
        : picksForSeat(order, seat)
      : lines.filter((l) => (qty[l.id] ?? 0) > 0).map((l) => ({ lineId: l.id, qty: qty[l.id]! }));
  const left = lines.reduce((a, l) => a + l.quantity, 0) - picks.reduce((a, p) => a + p.qty, 0);
  const ok = picks.length > 0 && left > 0;

  const confirm = async () => {
    setError(null);
    if (!ok) return setError('err_split_failed');
    const err = await onSplit(picks);
    if (err) setError(err);
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t.splitTitle}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>{t.splitTitle}</h2>
        <p className="muted">{t.splitIntro}</p>
        <div className="tabs" role="tablist" aria-label={t.splitTitle}>
          {(['items', 'seats'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              className="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
            >
              {m === 'items' ? t.splitModeItems : t.splitModeSeats}
            </button>
          ))}
        </div>

        {mode === 'items' ? (
          <ul className="member-list">
            {lines.map((l) => {
              const name = localizedName(l.name, lang);
              const n = qty[l.id] ?? 0;
              return (
                <li key={l.id} className="member-row">
                  <div className="member-head">
                    <strong>{name}</strong>
                    <span className="muted tabular">
                      {l.quantity} × {formatTHB(l.unitPrice, locale)}
                    </span>
                  </div>
                  <div
                    className="qty-stepper"
                    role="group"
                    aria-label={fmt(t.splitMove, { n: name })}
                  >
                    <button
                      type="button"
                      aria-label={fmt(t.orderLess, { name })}
                      disabled={n <= 0}
                      onClick={() => setQty({ ...qty, [l.id]: n - 1 })}
                    >
                      −
                    </button>
                    <output className="tabular">{n}</output>
                    <button
                      type="button"
                      aria-label={fmt(t.orderMore, { name })}
                      disabled={n >= l.quantity}
                      onClick={() => setQty({ ...qty, [l.id]: n + 1 })}
                    >
                      +
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : seats.length === 0 ? (
          <Notice kind="info">{t.splitSeatNone}</Notice>
        ) : (
          <div className="chips" role="radiogroup" aria-label={t.splitModeSeats}>
            {seats.map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={seat === s}
                className="chip"
                aria-pressed={seat === s}
                onClick={() => setSeat(s)}
              >
                {fmt(t.splitSeat, { n: s })}
              </button>
            ))}
          </div>
        )}

        {!ok && picks.length > 0 ? <p className="muted">{t.splitNeedSome}</p> : null}
        {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
        <div className="actions">
          <AsyncButton disabled={!ok} onClick={confirm}>
            {t.splitConfirm}
          </AsyncButton>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            {t.menuCancel}
          </button>
        </div>
      </div>
    </div>
  );
}
