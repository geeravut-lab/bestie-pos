import { LANGS, useI18n } from '@bestie/i18n';
import type { Lang } from '@bestie/i18n';

export function LangSwitch() {
  const { lang, t, setLang } = useI18n();
  const label: Record<Lang, string> = { th: t.langTh, en: t.langEn };

  return (
    <div className="lang-switch" role="group" aria-label={t.langGroup}>
      {LANGS.map((l) => (
        <button key={l} type="button" lang={l} aria-pressed={l === lang} onClick={() => setLang(l)}>
          {label[l]}
        </button>
      ))}
    </div>
  );
}
