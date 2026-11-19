import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { THEME_KEYS, isHex6, parseTheme, themeProblems, themeVars } from '@bestie/core';
import type { FixedColours, StoreTheme, ThemeKey } from '@bestie/core';
import { errorText, fmt, useI18n } from '@bestie/i18n';
import type { Dict, ErrorKey } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useRemote } from './useRemote';

const tx = (t: Dict, key: string): string => (t as Record<string, string>)[key] ?? key;

/** The colours the theme does not choose, read from the live stylesheet (the colour tokens live only in theme.css). */
export function readFixedColours(): FixedColours {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string) => cs.getPropertyValue(`--bp-${name}`).trim();
  return { ink: v('ink'), muted: v('muted'), white: v('on-primary'), surface: v('surface') };
}
const readDefault = (key: ThemeKey): string =>
  getComputedStyle(document.documentElement).getPropertyValue(`--bp-${key}`).trim();

/**
 * Owner: the five colours of one shop. Every pairing that carries text is checked (WCAG AA) as they type; a theme that breaks a
 * rule cannot be saved. Empty = the built-in "Island Breeze" colour.
 */
export function ThemePage({
  ctx,
  fixedOverride,
}: {
  ctx: PageContext;
  /** Tests only: jsdom has no stylesheet. */
  fixedOverride?: FixedColours;
}) {
  const { t } = useI18n();
  const canEdit = ctx.isOwner || ctx.permissions.includes('settings.manage');
  const { status, data, reload } = useRemote(async () => {
    const r = await ctx.client
      .from('stores')
      .select('id, name, theme')
      .eq('org_id', ctx.orgId)
      .is('deleted_at', null)
      .order('created_at');
    if (r.error) throw new Error('load');
    return (r.data ?? []) as { id: string; name: string; theme: unknown }[];
  }, ctx.orgId);
  const [storeId, setStoreId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, StoreTheme>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<ErrorKey | null>(null);
  const fixed = useMemo(() => fixedOverride ?? readFixedColours(), [fixedOverride]);

  if (status === 'loading')
    return (
      <p className="sso-working" role="status">
        <Spinner /> {t.loading}
      </p>
    );
  if (status === 'error' || !data || data.length === 0)
    return (
      <div className="admin-page">
        <Notice kind="error">{t.err_load_failed}</Notice>
        <AsyncButton variant="secondary" onClick={reload}>
          {t.retry}
        </AsyncButton>
      </div>
    );

  const store = data.find((s) => s.id === (storeId ?? ctx.homeStoreId)) ?? data[0]!;
  const saved = parseTheme(store.theme);
  const theme: StoreTheme = draft[store.id] ?? saved;
  const problems = themeProblems(theme, fixed);
  const dirty = JSON.stringify(theme) !== JSON.stringify(saved);
  const setKey = (k: ThemeKey, v: string) => {
    setMessage(null);
    const next: StoreTheme = { ...theme };
    if (isHex6(v)) next[k] = v.toLowerCase();
    else delete next[k];
    setDraft({ ...draft, [store.id]: next });
  };

  const save = async (value: StoreTheme) => {
    setError(null);
    setMessage(null);
    const { data: ok, error: err } = await ctx.client
      .from('stores')
      .update({ theme: value })
      .eq('id', store.id)
      .select('id');
    if (err || ok?.length !== 1)
      return setError(err?.code === '42501' ? 'err_forbidden' : 'err_save_failed');
    setDraft({ ...draft, [store.id]: value });
    setMessage(t.modulesSaved);
    reload();
  };

  const preview = themeVars(theme, fixed.ink) as CSSProperties;

  return (
    <div className="admin-page">
      <h1>{t.themeTitle}</h1>
      <Notice kind="info">{t.themeIntro}</Notice>
      {!canEdit ? <Notice kind="info">{t.modulesReadOnly}</Notice> : null}
      <section className="card admin-card">
        {data.length > 1 ? (
          <div className="form-row">
            <label className="label" htmlFor="theme-store">
              {t.modulesStore}
            </label>
            <select
              id="theme-store"
              className="field"
              value={store.id}
              onChange={(e) => {
                setStoreId(e.target.value);
                setMessage(null);
                setError(null);
              }}
            >
              {data.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <h2>{store.name}</h2>
        )}
        <div className="filters">
          {THEME_KEYS.map((k) => (
            <div key={k} className="form-row">
              <label className="label" htmlFor={`theme-${k}`}>
                {tx(t, `themeKey_${k}`)}
              </label>
              <div className="theme-input">
                <input
                  type="color"
                  aria-label={tx(t, `themeKey_${k}`)}
                  value={theme[k] ?? (isHex6(readDefault(k)) ? readDefault(k) : fixed.white)}
                  disabled={!canEdit}
                  onChange={(e) => setKey(k, e.target.value)}
                />
                <input
                  id={`theme-${k}`}
                  className="field tabular"
                  value={theme[k] ?? ''}
                  placeholder={t.themeDefault}
                  maxLength={7}
                  disabled={!canEdit}
                  onChange={(e) => setKey(k, e.target.value.trim())}
                />
              </div>
              <p className="muted">{tx(t, `themeHint_${k}`)}</p>
            </div>
          ))}
        </div>

        <h3>{t.themePreview}</h3>
        <div className="theme-preview card" style={preview} aria-label={t.themePreview}>
          <button type="button" className="btn btn-primary">
            {t.themeSampleButton}
          </button>
          <span className="badge theme-chip-brand">{tx(t, 'themeKey_brand')}</span>
          <span className="badge theme-chip-accent">{tx(t, 'themeKey_accent')}</span>
          <span className="badge theme-chip-sun">{tx(t, 'themeKey_sun')}</span>
          <p className="theme-mint">{t.themeSampleText}</p>
        </div>

        {problems.length === 0 ? (
          <Notice kind="success">{t.themeContrastOk}</Notice>
        ) : (
          <Notice kind="error">
            <ul>
              {problems.map((p) => (
                <li key={`${p.key}-${p.pair}`}>
                  {fmt(t.themeProblem, {
                    pair: tx(t, `themePair_${p.pair.replaceAll(' ', '_')}`),
                    ratio: p.ratio,
                    min: p.min,
                  })}
                </li>
              ))}
            </ul>
          </Notice>
        )}
        {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
        {message ? <Notice kind="success">{message}</Notice> : null}
        {canEdit ? (
          <div className="actions">
            <AsyncButton onClick={() => save(theme)} disabled={!dirty || problems.length > 0}>
              {t.menuSave}
            </AsyncButton>
            <AsyncButton
              variant="secondary"
              onClick={() => save({})}
              disabled={Object.keys(saved).length === 0 && Object.keys(theme).length === 0}
            >
              {t.themeReset}
            </AsyncButton>
          </div>
        ) : null}
      </section>
    </div>
  );
}
