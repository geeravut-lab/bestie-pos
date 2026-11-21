import { useState } from 'react';
import {
  HAIR_FACES,
  HAIR_LENGTHS,
  HAIR_TEXTURES,
  HAIR_UPKEEP,
  hairStylePayload,
  parseHairStyles,
} from '@bestie/core';
import type { HairFace, HairLength, HairStyle, HairTexture, HairUpkeep } from '@bestie/core';
import { errorText, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useRemote } from './useRemote';

type Form = {
  id?: string;
  nameTh: string;
  nameEn: string;
  aboutTh: string;
  aboutEn: string;
  lengths: HairLength[];
  textures: HairTexture[];
  faces: HairFace[];
  upkeep: HairUpkeep | '';
};
const blank = (): Form => ({
  nameTh: '',
  nameEn: '',
  aboutTh: '',
  aboutEn: '',
  lengths: [],
  textures: [],
  faces: [],
  upkeep: '',
});

const toggle = <T extends string>(list: T[], v: T): T[] =>
  list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

/** The salon's own list of hairstyles for the guest advisor: what each suits and how much upkeep it needs. */
export function HairStylesPage({ ctx }: { ctx: PageContext }) {
  const { t, lang } = useI18n();
  const storeId = ctx.storeId ?? ctx.homeStoreId ?? null;
  const canEdit = ctx.isOwner || ctx.permissions.includes('menu.edit');
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [bad, setBad] = useState(false);
  const label = (k: string): string => (t as Record<string, string>)[k] ?? k;

  const styles = useRemote<HairStyle[]>(
    async () => {
      if (!storeId) return [];
      const r = await ctx.client
        .from('hair_styles')
        .select('id, name, about, lengths, textures, faces, upkeep')
        .eq('store_id', storeId)
        .is('deleted_at', null)
        .order('sort');
      if (r.error) throw new Error('load');
      return parseHairStyles(r.data);
    },
    `hair:${storeId ?? ''}`,
  );

  const save = async () => {
    setError(null);
    setBad(false);
    const payload = form && storeId ? hairStylePayload({ ...form, storeId }) : null;
    if (!payload) return setBad(true);
    const { error: err } = await ctx.client.rpc('save_hair_style', { p: payload });
    if (err)
      return setError(
        err.code === '42501'
          ? 'err_forbidden'
          : err.code === '23514'
            ? 'err_save_failed'
            : 'err_save_failed',
      );
    setForm(null);
    styles.reload();
  };
  const remove = async (id: string) => {
    setError(null);
    const { error: err } = await ctx.client.rpc('delete_hair_style', { p_id: id });
    if (err) return setError(err.code === '42501' ? 'err_forbidden' : 'err_save_failed');
    styles.reload();
  };
  const edit = (s: HairStyle) =>
    setForm({
      id: s.id,
      nameTh: s.name.th,
      nameEn: s.name.en ?? '',
      aboutTh: s.about?.th ?? '',
      aboutEn: s.about?.en ?? '',
      lengths: s.lengths,
      textures: s.textures,
      faces: s.faces,
      upkeep: s.upkeep ?? '',
    });

  const checks = <T extends string>(
    name: string,
    all: readonly T[],
    value: T[],
    onChange: (v: T[]) => void,
  ) => (
    <fieldset className="form-row">
      <legend className="label">{name}</legend>
      {all.map((o) => (
        <label key={o} className="check">
          <input
            type="checkbox"
            checked={value.includes(o)}
            onChange={() => onChange(toggle(value, o))}
          />{' '}
          {label(`hair_${o}`)}
        </label>
      ))}
    </fieldset>
  );

  return (
    <div className="admin-page">
      <h1>{t.hsTitle}</h1>
      <Notice kind="info">{t.hsIntro}</Notice>
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      {styles.status === 'loading' ? (
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      ) : null}
      {styles.data && styles.data.length === 0 ? <p className="muted">{t.hsNone}</p> : null}
      <ul className="member-list">
        {(styles.data ?? []).map((s) => (
          <li key={s.id} className="member-row">
            <div className="member-head">
              <strong>{lang === 'en' && s.name.en ? s.name.en : s.name.th}</strong>
              {s.upkeep ? <span className="badge">{label(`hair_${s.upkeep}`)}</span> : null}
              <span className="muted">
                {[...s.lengths, ...s.textures, ...s.faces]
                  .map((x) => label(`hair_${x}`))
                  .join(' · ')}
              </span>
            </div>
            {canEdit ? (
              <div className="actions">
                <button type="button" className="btn btn-secondary" onClick={() => edit(s)}>
                  {t.hsEdit}
                </button>
                <AsyncButton variant="secondary" onClick={() => remove(s.id)}>
                  {t.hsRemove}
                </AsyncButton>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {canEdit && !form ? (
        <AsyncButton variant="secondary" onClick={() => setForm(blank())}>
          {t.hsAdd}
        </AsyncButton>
      ) : null}
      {canEdit && form ? (
        <section className="card admin-card">
          {(
            [
              ['hs-name-th', t.hsNameTh, 'nameTh'],
              ['hs-name-en', t.hsNameEn, 'nameEn'],
              ['hs-about-th', t.hsAboutTh, 'aboutTh'],
              ['hs-about-en', t.hsAboutEn, 'aboutEn'],
            ] as const
          ).map(([id, name, key]) => (
            <div key={id} className="form-row">
              <label className="label" htmlFor={id}>
                {name}
              </label>
              <input
                id={id}
                className="field"
                maxLength={key.startsWith('about') ? 200 : 80}
                value={form[key]}
                onChange={(e) => setForm({ ...form, [key]: e.target.value })}
              />
            </div>
          ))}
          {checks(t.hsLengths, HAIR_LENGTHS, form.lengths, (v) => setForm({ ...form, lengths: v }))}
          {checks(t.hsTextures, HAIR_TEXTURES, form.textures, (v) =>
            setForm({ ...form, textures: v }),
          )}
          {checks(t.hsFaces, HAIR_FACES, form.faces, (v) => setForm({ ...form, faces: v }))}
          <div className="form-row">
            <label className="label" htmlFor="hs-upkeep">
              {t.hsUpkeep}
            </label>
            <select
              id="hs-upkeep"
              className="field"
              value={form.upkeep}
              onChange={(e) => setForm({ ...form, upkeep: e.target.value as HairUpkeep | '' })}
            >
              <option value="" />
              {HAIR_UPKEEP.map((u) => (
                <option key={u} value={u}>
                  {label(`hair_${u}`)}
                </option>
              ))}
            </select>
          </div>
          {bad ? <Notice kind="error">{t.hsBad}</Notice> : null}
          <div className="actions">
            <AsyncButton onClick={save}>{t.hsSave}</AsyncButton>
            <AsyncButton variant="secondary" onClick={() => setForm(null)}>
              {t.crCancel}
            </AsyncButton>
          </div>
        </section>
      ) : null}
    </div>
  );
}
