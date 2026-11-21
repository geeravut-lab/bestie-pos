import { useState } from 'react';
import { AppError, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { TRANSLATE_TARGETS, translateText } from './aiApi';
import type { TranslateTarget } from './aiApi';

/** Live translation for staff (module `ai.translate`): type a message, pick the language, get a machine draft. Nothing is stored. */
export function TranslatePage({ ctx }: { ctx: PageContext }) {
  const { t } = useI18n();
  const storeId = ctx.storeId ?? ctx.homeStoreId ?? null;
  const [text, setText] = useState('');
  const [to, setTo] = useState<TranslateTarget>('en');
  const [result, setResult] = useState<string | null>(null);
  const [note, setNote] = useState<'off' | 'long' | 'failed' | 'copied' | null>(null);
  const [error, setError] = useState<ErrorKey | null>(null);
  const names: Record<TranslateTarget, string> = {
    th: t.langTh,
    en: t.langEn,
    ru: t.langRu,
    he: t.langHe,
    de: t.langDe,
    zh: t.langZh,
  };

  const run = async () => {
    setNote(null);
    setError(null);
    setResult(null);
    const body = text.trim();
    if (!storeId || body.length < 1) return;
    if (body.length > 600) return setNote('long');
    try {
      const out = await translateText(ctx.client, storeId, body, to);
      if (out === null) return setNote('off');
      setResult(out);
    } catch (e) {
      if (e instanceof AppError) return setError(e.code);
      setNote('failed');
    }
  };
  const copy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result);
      setNote('copied');
    } catch {
      /* the text stays on screen to copy by hand */
    }
  };

  return (
    <div className="admin-page">
      <h1>{t.trTitle}</h1>
      <Notice kind="info">{t.trIntro}</Notice>
      {error ? <Notice kind="error">{t[error]}</Notice> : null}
      <form
        className="card admin-card auth-form"
        onSubmit={(e) => e.preventDefault()}
        aria-label={t.trTitle}
      >
        <div className="form-row">
          <label className="label" htmlFor="tr-text">
            {t.trText}
          </label>
          <textarea
            id="tr-text"
            className="field"
            rows={4}
            maxLength={700}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <div className="form-row">
          <label className="label" htmlFor="tr-to">
            {t.trTo}
          </label>
          <select
            id="tr-to"
            className="field"
            value={to}
            onChange={(e) => setTo(e.target.value as TranslateTarget)}
          >
            {TRANSLATE_TARGETS.map((l) => (
              <option key={l} value={l}>
                {names[l]}
              </option>
            ))}
          </select>
        </div>
        <div className="actions">
          <AsyncButton type="submit" onClick={run}>
            {t.trGo}
          </AsyncButton>
        </div>
      </form>
      {note === 'off' ? <Notice kind="info">{t.trOff}</Notice> : null}
      {note === 'long' ? <Notice kind="error">{t.trTooLong}</Notice> : null}
      {note === 'failed' ? <Notice kind="error">{t.trFailed}</Notice> : null}
      {result ? (
        <section className="card admin-card" aria-label={t.trResult} dir="auto">
          <h2>{t.trResult}</h2>
          <p className="translate-result" lang={to}>
            {result}
          </p>
          <div className="actions">
            <AsyncButton variant="secondary" onClick={copy}>
              {t.trCopy}
            </AsyncButton>
          </div>
          {note === 'copied' ? <p role="status">{t.trCopied}</p> : null}
        </section>
      ) : null}
    </div>
  );
}
