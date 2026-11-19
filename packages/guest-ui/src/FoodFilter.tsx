import { useState } from 'react';
import { EMPTY_FILTER, formatTHB, hasDietConstraint } from '@bestie/core';
import type { DietFilter, DietTag } from '@bestie/core';
import { fmt, useI18n } from '@bestie/i18n';
import type { Dict } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { askGuestAi } from './guestApi';

const COMMON_EXCLUDE: readonly DietTag[] = [
  'contains_pork',
  'contains_seafood',
  'contains_shellfish',
  'contains_egg',
  'contains_dairy',
  'contains_gluten',
  'contains_peanut',
];
const COMMON_REQUIRE: readonly DietTag[] = ['vegetarian', 'vegan', 'halal'];

export const dietName = (t: Dict, tag: DietTag): string =>
  (t as Record<string, string>)[`dietTag_${tag}`] ?? tag;

const toggle = <T,>(list: readonly T[], v: T): T[] =>
  list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
const union = <T,>(a: readonly T[], b: readonly T[]): T[] => [
  ...a,
  ...b.filter((x) => !a.includes(x)),
];

/**
 * "Find food that suits you": toggle buttons that work with no AI at all, and — when the shop switched the assistant on —
 * a box where the guest types it in their own words. Either way the result is the same `DietFilter`, applied to the menu
 * by plain code in the page; the assistant only fills the buttons in.
 */
export function FoodFilter({
  token,
  ai,
  filter,
  onChange,
}: {
  token: string;
  ai: boolean;
  filter: DietFilter;
  onChange: (f: DietFilter) => void;
}) {
  const { t, lang } = useI18n();
  const locale = lang === 'th' ? 'th-TH' : 'en-GB';
  const [text, setText] = useState('');
  const [note, setNote] = useState<'failed' | 'not_understood' | null>(null);

  const excludeChips = union(COMMON_EXCLUDE, filter.exclude);
  const requireChips = union(COMMON_REQUIRE, filter.require);
  const active =
    hasDietConstraint(filter) || filter.maxPrice !== null || filter.keywords.length > 0;

  const ask = async () => {
    const q = text.trim();
    if (q.length < 2) return;
    setNote(null);
    const a = await askGuestAi(token, q);
    if (a.kind === 'filter') onChange(a.filter);
    else setNote(a.kind === 'not_understood' ? 'not_understood' : 'failed');
  };

  return (
    <section className="card guest-filter" aria-label={t.gsFilterTitle}>
      <h2>{t.gsFilterTitle}</h2>
      <div className="chips" role="group" aria-label={t.gsFilterTitle}>
        {excludeChips.map((tag) => (
          <button
            key={tag}
            type="button"
            className="chip"
            aria-pressed={filter.exclude.includes(tag)}
            onClick={() => onChange({ ...filter, exclude: toggle(filter.exclude, tag) })}
          >
            {fmt(t.gsFilterNo, { x: dietName(t, tag) })}
          </button>
        ))}
        {requireChips.map((tag) => (
          <button
            key={tag}
            type="button"
            className="chip"
            aria-pressed={filter.require.includes(tag)}
            onClick={() => onChange({ ...filter, require: toggle(filter.require, tag) })}
          >
            {dietName(t, tag)}
          </button>
        ))}
        <button
          type="button"
          className="chip"
          aria-pressed={filter.maxSpice === 0}
          onClick={() => onChange({ ...filter, maxSpice: filter.maxSpice === 0 ? null : 0 })}
        >
          {t.gsFilterNoSpice}
        </button>
        {filter.maxSpice !== null && filter.maxSpice > 0 ? (
          <button
            type="button"
            className="chip"
            aria-pressed
            onClick={() => onChange({ ...filter, maxSpice: null })}
          >
            {fmt(t.gsSpiceLevel, { n: filter.maxSpice })}
          </button>
        ) : null}
        {filter.maxPrice !== null ? (
          <button
            type="button"
            className="chip"
            aria-pressed
            onClick={() => onChange({ ...filter, maxPrice: null })}
          >
            {fmt(t.gsFilterBudget, { price: formatTHB(filter.maxPrice, locale) })}
          </button>
        ) : null}
        {filter.keywords.map((k) => (
          <button
            key={k}
            type="button"
            className="chip"
            aria-pressed
            onClick={() =>
              onChange({ ...filter, keywords: filter.keywords.filter((x) => x !== k) })
            }
          >
            {`“${k}”`}
          </button>
        ))}
        {active ? (
          <button type="button" className="chip chip-note" onClick={() => onChange(EMPTY_FILTER)}>
            {t.gsFilterClear}
          </button>
        ) : null}
      </div>

      {ai ? (
        <form
          className="guest-ask"
          onSubmit={(e) => {
            e.preventDefault();
          }}
        >
          <input
            className="field"
            type="text"
            value={text}
            maxLength={300}
            aria-label={t.gsAskLabel}
            placeholder={t.gsAskPlaceholder}
            onChange={(e) => setText(e.target.value)}
          />
          <AsyncButton variant="secondary" onClick={ask} disabled={text.trim().length < 2}>
            {t.gsAskButton}
          </AsyncButton>
          {note ? (
            <p className="notice notice-error" role="alert">
              {note === 'failed' ? t.gsAskFailed : t.gsAskNotUnderstood}
            </p>
          ) : null}
        </form>
      ) : null}
    </section>
  );
}
