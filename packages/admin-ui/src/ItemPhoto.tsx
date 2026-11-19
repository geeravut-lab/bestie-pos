import { useRef, useState } from 'react';
import { menuImageUrl, pictureFileProblem } from '@bestie/core';
import { fmt, useI18n } from '@bestie/i18n';
import { AsyncButton, Spinner, useAsyncAction } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { preparePicture } from './imagePrep';
import type { PreparedPicture } from './imagePrep';

type Problem = 'type' | 'size' | 'decode' | 'toobig' | 'failed' | 'forbidden' | null;

/** The picture of one menu item: shown, replaced by choosing a file (shrunk here first) or removed. Needs an item that already exists. */
export function ItemPhoto({
  ctx,
  itemId,
  itemName,
  version,
  onChanged,
  prepare = preparePicture,
}: {
  ctx: PageContext;
  itemId: string;
  itemName: string;
  version: number | null | undefined;
  onChanged: () => void;
  /** Injected in tests (a canvas is not available there). */
  prepare?: (file: File) => Promise<PreparedPicture>;
}) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<Problem>(null);
  const [saved, setSaved] = useState(false);
  const url = menuImageUrl(itemId, version);

  const send = useAsyncAction(async (file: File) => {
    setProblem(null);
    setSaved(false);
    const bad = pictureFileProblem(file);
    if (bad) return setProblem(bad === 'type' || bad === 'empty' ? 'type' : 'size');
    let pic: PreparedPicture;
    try {
      pic = await prepare(file);
    } catch (e) {
      return setProblem(e instanceof Error && e.message === 'toobig' ? 'toobig' : 'decode');
    }
    const { error } = await ctx.client.rpc('save_menu_image', {
      p_item: itemId,
      p_mime: pic.mime,
      p_data: pic.base64,
    });
    if (error) return setProblem(error.code === '42501' ? 'forbidden' : 'failed');
    setSaved(true);
    onChanged();
  });
  const remove = async () => {
    setProblem(null);
    setSaved(false);
    const { error } = await ctx.client.rpc('remove_menu_image', { p_item: itemId });
    if (error) return setProblem(error.code === '42501' ? 'forbidden' : 'failed');
    onChanged();
  };
  const text: Record<Exclude<Problem, null>, string> = {
    type: t.menuPhotoType,
    size: t.menuPhotoSize,
    decode: t.menuPhotoDecode,
    toobig: t.menuPhotoTooBig,
    failed: t.err_save_failed,
    forbidden: t.err_forbidden,
  };

  return (
    <div className="form-row item-photo">
      <span className="label">{t.menuPhoto}</span>
      <div className="item-photo-box">
        {url ? (
          <img className="item-photo-img" src={url} alt={fmt(t.menuPhotoAlt, { name: itemName })} />
        ) : (
          <span className="item-photo-empty muted">{t.menuPhotoNone}</span>
        )}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="visually-hidden"
        aria-label={t.menuPhotoFile}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void send.run(f);
        }}
      />
      <div className="actions">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={send.pending}
          onClick={() => input.current?.click()}
        >
          {url ? t.menuPhotoReplace : t.menuPhotoChoose}
        </button>
        {url ? (
          <AsyncButton variant="secondary" onClick={remove}>
            {t.menuPhotoRemove}
          </AsyncButton>
        ) : null}
        {send.pending ? (
          <span className="sso-working" role="status">
            <Spinner /> {t.menuPhotoSending}
          </span>
        ) : null}
      </div>
      <p className="muted">{t.menuPhotoHint}</p>
      {problem ? <Notice kind="error">{text[problem]}</Notice> : null}
      {saved ? <Notice kind="success">{t.menuPhotoSaved}</Notice> : null}
    </div>
  );
}
