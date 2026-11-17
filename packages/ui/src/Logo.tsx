import { fmt, useI18n } from '@bestie/i18n';
import defaultMark from '../brand/logo-mark.svg';

/**
 * The platform logo. Always render the brand through this component (never a raw <img src>)
 * so the admin-uploaded logo (docs/BRANDING-KNOWLEDGE.md) can replace the default in one place.
 *
 * `src` is the override hook: the branding feature passes `/brand/logo?v=<version>` here.
 */
export function LogoMark({ src, size = 40 }: { src?: string; size?: number }) {
  const { t } = useI18n();
  return (
    <img
      className="brand-mark"
      src={src ?? defaultMark}
      width={size}
      height={size}
      alt={fmt(t.logoAlt, { name: t.appName })}
    />
  );
}

/** Mark + product name, e.g. in headers. The name comes from the dictionary, never from code. */
export function Brand({ logoSrc }: { logoSrc?: string }) {
  const { t } = useI18n();
  return (
    <span className="brand">
      <LogoMark src={logoSrc} />
      <span className="brand-name">{t.appName}</span>
    </span>
  );
}
