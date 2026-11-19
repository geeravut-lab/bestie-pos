import { useState } from 'react';
import { ART_IDS, AsyncButton, Illustration, NAV_BY_ID, Spinner } from '@bestie/ui';
import { cardImageUrl, parseCardImages } from '@bestie/core';
import type { CardImages } from '@bestie/core';
import { errorText, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { Notice, useLiveSync } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { removeCardImage, uploadCardImage } from './cardImageActions';
import { useRemote } from './useRemote';

/** Platform admin: replace the picture on a home card, or go back to the built-in illustration. */
export function CardImagesPage({ ctx }: { ctx: PageContext }) {
  const { t } = useI18n();
  const { status, data, reload } = useRemote(async () => {
    const { data: row, error } = await ctx.client
      .from('platform_settings')
      .select('card_images')
      .maybeSingle();
    if (error) throw new Error(error.code ?? 'query');
    return parseCardImages((row as { card_images?: unknown } | null)?.card_images);
  }, 'card-images');
  useLiveSync(ctx.client, ['platform'], reload);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [saved, setSaved] = useState(false);

  if (!ctx.isPlatformAdmin)
    return (
      <div className="admin-page">
        <Notice kind="error">{t.brandAdminOnly}</Notice>
      </div>
    );
  if (status === 'loading')
    return (
      <p className="sso-working" role="status">
        <Spinner /> {t.loading}
      </p>
    );
  if (status === 'error' || !data)
    return (
      <div className="admin-page">
        <Notice kind="error">{t.err_load_failed}</Notice>
        <AsyncButton variant="secondary" onClick={reload}>
          {t.retry}
        </AsyncButton>
      </div>
    );

  const images: CardImages = data;
  const run = (work: () => Promise<unknown>) => async () => {
    setError(null);
    setSaved(false);
    await work();
    setSaved(true);
    reload();
  };

  return (
    <div className="admin-page">
      <h1>{t.cardsTitle}</h1>
      <Notice kind="info">{t.cardsIntro}</Notice>
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      {saved ? <Notice kind="success">{t.brandSaved}</Notice> : null}
      <ul className="card-grid">
        {ART_IDS.filter((id) => id !== 'home').map((id) => (
          <li key={id} className="card-cell">
            <CardRow
              id={id}
              title={t[NAV_BY_ID[id].label]}
              images={images}
              onUpload={(file) => run(() => uploadCardImage(ctx.client, id, file, images))()}
              onRemove={run(() => removeCardImage(ctx.client, id, images))}
              onError={setError}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function CardRow({
  id,
  title,
  images,
  onUpload,
  onRemove,
  onError,
}: {
  id: string;
  title: string;
  images: CardImages;
  onUpload: (file: File) => Promise<void>;
  onRemove: () => Promise<void>;
  onError: (e: ErrorKey) => void;
}) {
  const { t } = useI18n();
  const [file, setFile] = useState<File | null>(null);
  const url = cardImageUrl(id, images[id]);
  return (
    <section className="card admin-card">
      <h2>{title}</h2>
      <span className="card-art">
        {url ? <img src={url} alt="" loading="lazy" /> : <Illustration art={id as never} />}
      </span>
      <span className="badge">{url ? t.brandCurrent : t.brandDefaultBadge}</span>
      <div className="form-row">
        <label className="label" htmlFor={`card-file-${id}`}>
          {t.brandChoose}
        </label>
        <input
          id={`card-file-${id}`}
          className="field"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </div>
      <div className="actions">
        <AsyncButton
          disabled={!file}
          onClick={async () => {
            if (file) await onUpload(file);
            setFile(null);
          }}
          onActionError={onError}
        >
          {t.brandUpload}
        </AsyncButton>
        {url ? (
          <AsyncButton variant="secondary" onClick={onRemove} onActionError={onError}>
            {t.brandUseDefault}
          </AsyncButton>
        ) : null}
      </div>
    </section>
  );
}
