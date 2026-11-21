import { useState } from 'react';
import { translateText } from '@bestie/admin-ui';
import { AppError, useI18n } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import type { PageContext } from '@bestie/auth';

/**
 * One tap to read a guest's note (a QR order may be written in Russian, Hebrew, ...): translates it into the staff screen's language.
 * Only when the module `ai.translate` is on; it needs the network (the translation is made on the server, nothing is saved).
 */
export function NoteTranslate({
  ctx,
  storeId,
  text,
}: {
  ctx: PageContext;
  storeId: string;
  text: string;
}) {
  const { t, lang } = useI18n();
  const [result, setResult] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  if (!ctx.isModuleOn?.('ai.translate') || text.trim().length === 0) return null;
  const run = async () => {
    setFailed(false);
    try {
      const out = await translateText(
        ctx.client,
        storeId,
        text.trim().slice(0, 600),
        lang === 'th' ? 'th' : 'en',
      );
      if (out === null) setFailed(true);
      else setResult(out);
    } catch (e) {
      if (e instanceof AppError || e instanceof Error) setFailed(true);
    }
  };
  return (
    <div>
      {result === null ? (
        <AsyncButton variant="secondary" onClick={run}>
          {t.noteTranslate}
        </AsyncButton>
      ) : (
        <p className="muted" lang={lang}>
          <strong>{t.noteTranslated}:</strong> {result}
        </p>
      )}
      {failed ? <p role="alert">{t.noteTranslateFailed}</p> : null}
    </div>
  );
}
