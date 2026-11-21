import { LANGS, useI18n } from '@bestie/i18n';
import type { Lang } from '@bestie/i18n';

/** Staff screens: Thai / English. Guest pages pass `langs={GUEST_LANGS}` for the six guest languages. */
export function LangSwitch({ langs = LANGS }: { langs?: readonly Lang[] }) {
  const { lang, t, setLang } = useI18n();
  const label: Record<Lang, string> = {
    th: t.langTh,
    en: t.langEn,
    ru: t.langRu,
    he: t.langHe,
    de: t.langDe,
    zh: t.langZh,
  };

  return (
    <div className="lang-switch" role="group" aria-label={t.langGroup}>
      {langs.map((l) => (
        <button key={l} type="button" lang={l} aria-pressed={l === lang} onClick={() => setLang(l)}>
          {label[l]}
        </button>
      ))}
    </div>
  );
}
