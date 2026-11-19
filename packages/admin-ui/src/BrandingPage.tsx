import { useEffect, useState } from 'react';
import { DEFAULT_BRAND_NAME, brandImageUrl, parseBrand } from '@bestie/core';
import type { Brand, BrandImageKind } from '@bestie/core';
import { errorText, toErrorCode, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice, useLiveSync } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { removeBrandImage, saveBrandNames, uploadBrandImage } from './brandingActions';
import { useRemote } from './useRemote';

/** Platform admin: rename the product and replace the logo / tab icon (defaults = Bestie's own). */
export function BrandingPage({ ctx }: { ctx: PageContext }) {
  const { t } = useI18n();
  const { status, data, reload } = useRemote(async () => {
    const { data: row, error } = await ctx.client
      .from('platform_settings')
      .select('brand')
      .maybeSingle();
    if (error) throw new Error(error.code ?? 'query');
    return parseBrand((row as { brand?: unknown } | null)?.brand);
  }, 'brand');
  useLiveSync(ctx.client, ['platform'], reload);

  if (!ctx.isPlatformAdmin) {
    return (
      <div className="admin-page">
        <Notice kind="error">{t.brandAdminOnly}</Notice>
      </div>
    );
  }
  if (status === 'loading') {
    return (
      <p className="sso-working" role="status">
        <Spinner /> {t.loading}
      </p>
    );
  }
  if (status === 'error' || !data) {
    return (
      <div className="admin-page">
        <Notice kind="error">{t.err_load_failed}</Notice>
        <AsyncButton variant="secondary" onClick={reload}>
          {t.retry}
        </AsyncButton>
      </div>
    );
  }
  return <BrandingForm ctx={ctx} brand={data} onSaved={reload} />;
}

function BrandingForm({
  ctx,
  brand,
  onSaved,
}: {
  ctx: PageContext;
  brand: Brand;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [nameTh, setNameTh] = useState(brand.nameTh ?? '');
  const [nameEn, setNameEn] = useState(brand.nameEn ?? '');
  const [error, setError] = useState<ErrorKey | null>(null);
  const [saved, setSaved] = useState(false);

  const run = async (work: () => Promise<unknown>) => {
    setError(null);
    setSaved(false);
    try {
      await work();
      setSaved(true);
      onSaved();
    } catch (e) {
      setError(toErrorCode(e));
    }
  };

  return (
    <div className="admin-page">
      <h1>{t.brandTitle}</h1>

      <section className="card admin-card">
        <h2>{t.brandNames}</h2>
        <p className="muted hint">{t.brandNameHint}</p>
        <form className="auth-form" onSubmit={(e) => e.preventDefault()}>
          <div className="form-row">
            <label className="label" htmlFor="brand-th">
              {t.brandNameTh}
            </label>
            <input
              id="brand-th"
              className="field"
              lang="th"
              value={nameTh}
              placeholder={DEFAULT_BRAND_NAME}
              maxLength={40}
              onChange={(e) => setNameTh(e.target.value)}
            />
          </div>
          <div className="form-row">
            <label className="label" htmlFor="brand-en">
              {t.brandNameEn}
            </label>
            <input
              id="brand-en"
              className="field"
              lang="en"
              value={nameEn}
              placeholder={DEFAULT_BRAND_NAME}
              maxLength={40}
              onChange={(e) => setNameEn(e.target.value)}
            />
          </div>
          <AsyncButton
            type="submit"
            onClick={() => run(() => saveBrandNames(ctx.client, brand, { nameTh, nameEn }))}
          >
            {t.brandSaveNames}
          </AsyncButton>
        </form>
      </section>

      <div className="actions">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => ctx.navigate('/admin/cards')}
        >
          {t.cardsTitle}
        </button>
      </div>

      <ImageCard
        ctx={ctx}
        kind="logo"
        title={t.brandLogo}
        hint={t.brandLogoHint}
        brand={brand}
        run={run}
      />
      <ImageCard
        ctx={ctx}
        kind="favicon"
        title={t.brandIcon}
        hint={t.brandIconHint}
        brand={brand}
        run={run}
      />

      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      {saved ? <Notice kind="success">{t.brandSaved}</Notice> : null}
    </div>
  );
}

function ImageCard({
  ctx,
  kind,
  title,
  hint,
  brand,
  run,
}: {
  ctx: PageContext;
  kind: BrandImageKind;
  title: string;
  hint: string;
  brand: Brand;
  run: (work: () => Promise<unknown>) => Promise<void>;
}) {
  const { t } = useI18n();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const current = brand[kind];
  const shown =
    preview ?? brandImageUrl(kind, current) ?? (kind === 'logo' ? '/icon-512.png' : '/favicon.svg');

  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- derived from the chosen file; revoked on cleanup
    setPreview(url);
    return () => {
      URL.revokeObjectURL(url);
      setPreview(null);
    };
  }, [file]);

  return (
    <section className="card admin-card">
      <h2>{title}</h2>
      <p className="muted hint">{hint}</p>
      <div className="brand-preview">
        <img src={shown} alt="" width={96} height={96} />
        <span className="badge">{current ? t.brandCurrent : t.brandDefaultBadge}</span>
      </div>
      <div className="form-row">
        <label className="label" htmlFor={`brand-file-${kind}`}>
          {t.brandChoose}
        </label>
        <input
          id={`brand-file-${kind}`}
          className="field"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </div>
      <div className="actions">
        <AsyncButton
          disabled={!file}
          onClick={() =>
            run(async () => {
              if (!file) return;
              await uploadBrandImage(ctx.client, kind, file, brand);
              setFile(null);
            })
          }
        >
          {t.brandUpload}
        </AsyncButton>
        {current ? (
          <AsyncButton
            variant="secondary"
            onClick={() => run(() => removeBrandImage(ctx.client, kind, brand))}
          >
            {t.brandUseDefault}
          </AsyncButton>
        ) : null}
      </div>
    </section>
  );
}
