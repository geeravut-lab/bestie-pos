import { useState } from 'react';
import { nameProblems, toLocalizedText } from '@bestie/core';
import type { LocalizedText } from '@bestie/core';
import { errorText, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { Notice } from '@bestie/auth';

/** Thai (required) + English (optional) name fields with their own labels. */
export function NameFields({
  idPrefix,
  th,
  en,
  onTh,
  onEn,
}: {
  idPrefix: string;
  th: string;
  en: string;
  onTh: (v: string) => void;
  onEn: (v: string) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <div className="form-row">
        <label className="label" htmlFor={`${idPrefix}-th`}>
          {t.menuNameTh}
        </label>
        <input
          id={`${idPrefix}-th`}
          className="field"
          value={th}
          maxLength={120}
          onChange={(e) => onTh(e.target.value)}
        />
      </div>
      <div className="form-row">
        <label className="label" htmlFor={`${idPrefix}-en`}>
          {t.menuNameEn}
        </label>
        <input
          id={`${idPrefix}-en`}
          className="field"
          value={en}
          maxLength={120}
          onChange={(e) => onEn(e.target.value)}
        />
      </div>
    </>
  );
}

/** A small "name only" form (category / new option group). `save` returns an error key, or null when it worked. */
export function NameForm({
  idPrefix,
  initial,
  submitLabel,
  onSave,
  onCancel,
  clearOnSave = false,
}: {
  idPrefix: string;
  initial?: LocalizedText;
  submitLabel: string;
  onSave: (name: LocalizedText) => Promise<ErrorKey | null>;
  onCancel?: () => void;
  clearOnSave?: boolean;
}) {
  const { t } = useI18n();
  const [th, setTh] = useState(initial?.th ?? '');
  const [en, setEn] = useState(initial?.en ?? '');
  const [error, setError] = useState<ErrorKey | null>(null);

  const save = async () => {
    setError(null);
    if (nameProblems({ th, en }).length > 0) return setError('err_menu_invalid');
    const err = await onSave(toLocalizedText(th, en));
    if (err) return setError(err);
    if (clearOnSave) {
      setTh('');
      setEn('');
    }
  };

  return (
    <form className="auth-form" onSubmit={(e) => e.preventDefault()}>
      <div className="filters">
        <NameFields idPrefix={idPrefix} th={th} en={en} onTh={setTh} onEn={setEn} />
      </div>
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      <div className="actions">
        <AsyncButton type="submit" onClick={save}>
          {submitLabel}
        </AsyncButton>
        {onCancel ? (
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            {t.menuCancel}
          </button>
        ) : null}
      </div>
    </form>
  );
}

/** "Delete X?" confirmation with the spinner button; shown inline, no browser dialog. */
export function ConfirmDelete({
  label,
  onConfirm,
  onCancel,
}: {
  label: string;
  onConfirm: () => Promise<unknown>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="confirm-box" role="alertdialog" aria-label={label}>
      <p>{label}</p>
      <div className="actions">
        <AsyncButton variant="danger" onClick={onConfirm}>
          {t.menuDeleteYes}
        </AsyncButton>
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          {t.menuCancel}
        </button>
      </div>
    </div>
  );
}
