import { useEffect, useState } from 'react';
import { formatTHB, localizedName, validateSelection } from '@bestie/core';
import type { Channel, OrderGroupInput, OrderItemInput } from '@bestie/core';
import { fmt, useI18n } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';

/** Pick the options of one menu item (min / max per group are checked as you go), a quantity and a note. */
export function ModifierSheet({
  item,
  groups,
  channel,
  onAdd,
  onClose,
}: {
  item: OrderItemInput;
  groups: readonly OrderGroupInput[];
  channel: Channel;
  onAdd: (selected: string[], quantity: number, note: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const { t, lang } = useI18n();
  const locale = lang === 'th' ? 'th-TH' : 'en-GB';
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState('');
  const itemName = localizedName(item.name, lang);
  const selected = Object.values(picked).flat();
  const ok = validateSelection(groups, selected).length === 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggle = (g: OrderGroupInput, id: string) =>
    setPicked((p) => {
      const cur = p[g.id] ?? [];
      if (g.max === 1) return { ...p, [g.id]: cur[0] === id ? [] : [id] }; // radio-like: choosing another replaces it
      return {
        ...p,
        [g.id]: cur.includes(id)
          ? cur.filter((x) => x !== id)
          : cur.length < g.max
            ? [...cur, id]
            : cur,
      };
    });

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={fmt(t.orderChoose, { name: itemName })}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>{itemName}</h2>
        {groups.map((g) => {
          const chosen = picked[g.id] ?? [];
          return (
            <fieldset key={g.id} className="audit-group">
              <legend>
                {g.name ? localizedName(g.name, lang) : ''}{' '}
                <span className="muted">
                  {g.min > 0 ? `${t.orderPickRequired} · ` : ''}
                  {fmt(t.orderPickRule, { min: g.min, max: g.max })}
                </span>
              </legend>
              {g.options.map((o) => {
                const delta = o.channelDelta?.[channel] ?? o.priceDelta;
                const disabled = g.max > 1 && !chosen.includes(o.id) && chosen.length >= g.max;
                return (
                  <label key={o.id} className="check-row">
                    <input
                      type={g.max === 1 ? 'radio' : 'checkbox'}
                      name={g.id}
                      checked={chosen.includes(o.id)}
                      disabled={disabled}
                      onChange={() => toggle(g, o.id)}
                    />
                    <span>{localizedName(o.name, lang)}</span>
                    {delta !== 0 ? (
                      <span className="muted tabular">
                        {delta > 0 ? '+' : '−'}
                        {formatTHB(Math.abs(delta), locale)}
                      </span>
                    ) : null}
                  </label>
                );
              })}
            </fieldset>
          );
        })}
        <div className="form-row">
          <label className="label" htmlFor="sheet-note">
            {t.orderNote}
          </label>
          <input
            id="sheet-note"
            className="field"
            value={note}
            maxLength={200}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <div className="qty-stepper" role="group" aria-label={fmt(t.orderQty, { name: itemName })}>
          <button
            type="button"
            aria-label={fmt(t.orderLess, { name: itemName })}
            disabled={qty <= 1}
            onClick={() => setQty(qty - 1)}
          >
            −
          </button>
          <output className="tabular">{qty}</output>
          <button
            type="button"
            aria-label={fmt(t.orderMore, { name: itemName })}
            disabled={qty >= 99}
            onClick={() => setQty(qty + 1)}
          >
            +
          </button>
        </div>
        <div className="actions">
          <AsyncButton disabled={!ok} onClick={() => onAdd(selected, qty, note)}>
            {t.orderAddToBill}
          </AsyncButton>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            {t.menuCancel}
          </button>
        </div>
      </div>
    </div>
  );
}
