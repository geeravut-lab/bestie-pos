import { useState } from 'react';
import { DIET_TAGS, foodProblems } from '@bestie/core';
import type { DietTag, ItemFood } from '@bestie/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { errorText, toErrorCode, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import { draftFoodTags } from './aiApi';

/**
 * The food information of one dish. The shop sets it; the AI button only DRAFTS tags from the name and never ticks
 * "checked" — a person does (docs/AI-CUSTOMER-ASSISTANT.md §3A: AI drafts, a person signs).
 */
export function FoodInfoFields({
  idPrefix,
  food,
  onChange,
  client,
  storeId,
  name,
}: {
  idPrefix: string;
  food: ItemFood;
  onChange: (f: ItemFood) => void;
  client: SupabaseClient;
  storeId: string;
  name: { th: string; en: string };
}) {
  const { t } = useI18n();
  const [note, setNote] = useState<'drafted' | 'unavailable' | ErrorKey | null>(null);
  const problems = foodProblems(food);
  const tagText = (tag: DietTag) => (t as Record<string, string>)[`dietTag_${tag}`] ?? tag;
  const set = (patch: Partial<ItemFood>) => onChange({ ...food, ...patch });

  const draft = async () => {
    setNote(null);
    try {
      const d = await draftFoodTags(client, storeId, name);
      if (!d.available) return setNote('unavailable');
      // a draft is never "verified": whatever the AI says, a person must look
      set({ tags: d.tags, spice: d.spice, verified: false });
      setNote('drafted');
    } catch (e) {
      setNote(toErrorCode(e));
    }
  };

  return (
    <fieldset className="audit-group">
      <legend>{t.foodTitle}</legend>
      <p className="muted">{t.foodTags}</p>
      <div className="chips" role="group" aria-label={t.foodTags}>
        {DIET_TAGS.map((tag) => (
          <button
            key={tag}
            type="button"
            className="chip"
            aria-pressed={food.tags.includes(tag)}
            onClick={() =>
              set({
                tags: food.tags.includes(tag)
                  ? food.tags.filter((x) => x !== tag)
                  : [...food.tags, tag],
              })
            }
          >
            {tagText(tag)}
          </button>
        ))}
      </div>
      <div className="form-row">
        <label className="label" htmlFor={`${idPrefix}-spice`}>
          {t.foodSpice}
        </label>
        <select
          id={`${idPrefix}-spice`}
          className="field"
          value={food.spice === null ? '' : String(food.spice)}
          onChange={(e) =>
            set({ spice: e.target.value === '' ? null : (Number(e.target.value) as 0 | 1 | 2 | 3) })
          }
        >
          <option value="">{t.foodSpiceUnknown}</option>
          <option value="0">{t.foodSpice0}</option>
          <option value="1">{t.foodSpice1}</option>
          <option value="2">{t.foodSpice2}</option>
          <option value="3">{t.foodSpice3}</option>
        </select>
      </div>
      <label className="check-row">
        <input
          type="checkbox"
          checked={food.verified}
          disabled={problems.length > 0}
          onChange={(e) => set({ verified: e.target.checked })}
        />
        <span>
          <strong>{t.foodVerified}</strong>
          <span className="muted"> — {t.foodVerifiedHint}</span>
        </span>
      </label>
      <label className="check-row">
        <input
          type="checkbox"
          checked={food.highlight}
          onChange={(e) => set({ highlight: e.target.checked })}
        />
        <span>{t.foodHighlight}</span>
      </label>
      {problems.length > 0 ? <Notice kind="error">{t.foodConflict}</Notice> : null}
      <div className="actions">
        <AsyncButton
          variant="secondary"
          onClick={draft}
          disabled={!name.th.trim() && !name.en.trim()}
        >
          {t.foodAiDraft}
        </AsyncButton>
      </div>
      {note === 'drafted' ? <Notice kind="success">{t.foodAiDrafted}</Notice> : null}
      {note === 'unavailable' ? <Notice kind="error">{t.foodAiUnavailable}</Notice> : null}
      {note && note !== 'drafted' && note !== 'unavailable' ? (
        <Notice kind="error">{errorText(note, t)}</Notice>
      ) : null}
    </fieldset>
  );
}
