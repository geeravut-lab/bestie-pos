import { useEffect, useState } from 'react';
import { adviseStyles, HAIR_FACES, HAIR_LENGTHS, HAIR_TEXTURES, HAIR_UPKEEP } from '@bestie/core';
import type { HairAnswers, HairLabels, HairStyle } from '@bestie/core';
import { localizedName } from '@bestie/core';
import { fmt, hairLabelsText, useI18n } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { loadHairAi, loadStyles, readHairWithAi, sendHair, setHairAiConsent } from './bookingApi';
import type { HairAiState } from './bookingApi';
import { preparePhoto } from './photoPrep';

/**
 * After booking at a salon: four closed questions, the styles of the shop's catalogue that suit the answers (plain code, no AI), one
 * choice, and an OPTIONAL photo — sent only after the guest ticks the consent box, for this one booking, deleted automatically after
 * the appointment, and removable by the guest at any time. The photo is for the stylist; no model ever sees it.
 */
export function HairAdvisor({ token, id, code }: { token: string; id: string; code: string }) {
  const { t, lang } = useI18n();
  const [styles, setStyles] = useState<HairStyle[] | null>(null);
  const [answers, setAnswers] = useState<HairAnswers>({});
  const [styleId, setStyleId] = useState('');
  const [consent, setConsent] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState<
    'saved' | 'removed' | 'consent' | 'early' | 'photo' | 'failed' | null
  >(null);
  const [ai, setAi] = useState<HairAiState | null>(null);
  const [aiNote, setAiNote] = useState<
    'result' | 'unclear' | 'failed' | 'withdrawn' | 'photo' | 'consent' | null
  >(null);
  const [aiLabels, setAiLabels] = useState<HairLabels | null>(null);
  const [aiTick, setAiTick] = useState(false);
  const [photoSent, setPhotoSent] = useState(false);
  useEffect(() => {
    let alive = true;
    void loadHairAi(token, id, code).then((s) => {
      if (!alive) return;
      setAi(s);
      setAiTick(s.consent);
      setAiLabels(s.labels);
      if (s.labels) setPhotoSent(true);
    });
    return () => {
      alive = false;
    };
  }, [token, id, code]);
  useEffect(() => {
    let alive = true;
    void loadStyles(token).then((s) => alive && setStyles(s));
    return () => {
      alive = false;
    };
  }, [token]);

  if (!styles || styles.length === 0) return null;
  const advice = adviseStyles(styles, answers);

  const send = async (removePhoto = false) => {
    setNote(null);
    let photo: { consent: true; mime: string; data: string } | undefined;
    if (!removePhoto && file) {
      if (!consent) return setNote('consent');
      try {
        const p = await preparePhoto(file);
        photo = { consent: true, mime: p.mime, data: p.base64 };
      } catch {
        return setNote('photo');
      }
    }
    const r = await sendHair(token, id, code, { styleId, answers, photo, removePhoto });
    if (r.ok) {
      if (removePhoto) {
        setFile(null);
        setPhotoSent(false);
        setAiLabels(null);
        setAiTick(false);
        void loadHairAi(token, id, code).then(setAi);
      } else if (photo) {
        setPhotoSent(true);
        setAiLabels(null);
        setAiTick(false);
        void loadHairAi(token, id, code).then(setAi);
      }
      return setNote(removePhoto ? 'removed' : 'saved');
    }
    setNote(
      r.error === 'consent_needed'
        ? 'consent'
        : r.error === 'photo_too_early'
          ? 'early'
          : r.error === 'bad_photo'
            ? 'photo'
            : 'failed',
    );
  };

  const readWithAi = async () => {
    setAiNote(null);
    if (!photoSent) return setAiNote('photo');
    if (!aiTick) return setAiNote('consent');
    if (!ai?.consent) {
      if (!(await setHairAiConsent(token, id, code, true))) return setAiNote('failed');
      setAi({ ...ai!, consent: true });
    }
    const r = await readHairWithAi(token, id, code);
    if (r.ok) {
      setAiLabels(r.labels);
      setAnswers((a) => ({ ...a, ...r.answers }));
      return setAiNote('result');
    }
    setAiNote(r.error === 'unclear' ? 'unclear' : 'failed');
  };
  const withdrawAi = async () => {
    setAiNote(null);
    if (!(await setHairAiConsent(token, id, code, false))) return setAiNote('failed');
    setAiTick(false);
    setAiLabels(null);
    setAi((s) => (s ? { ...s, consent: false, labels: null } : s));
    setAiNote('withdrawn');
  };
  const set = <K extends keyof HairAnswers>(k: K, v: HairAnswers[K]) =>
    setAnswers({ ...answers, [k]: v });
  const label = (key: string): string => (t as Record<string, string>)[key] ?? key;
  const select = <T extends string>(
    id_: string,
    name: string,
    value: T | undefined,
    options: readonly T[],
    extra: T,
    onChange: (v: T) => void,
  ) => (
    <div className="form-row">
      <label className="label" htmlFor={id_}>
        {name}
      </label>
      <select
        id={id_}
        className="field"
        value={value ?? extra}
        onChange={(e) => onChange(e.target.value as T)}
      >
        <option value={extra}>{label(`hair_${extra}`)}</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {label(`hair_${o}`)}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <div className="card" aria-label={t.hairTitle}>
      <h3>{t.hairTitle}</h3>
      <p className="muted">{t.hairIntro}</p>
      {select('hair-length', t.hairLength, answers.length, HAIR_LENGTHS, 'any', (v) =>
        set('length', v),
      )}
      {select('hair-texture', t.hairTexture, answers.texture, HAIR_TEXTURES, 'any', (v) =>
        set('texture', v),
      )}
      {select('hair-face', t.hairFace, answers.face, HAIR_FACES, 'unknown', (v) => set('face', v))}
      {select('hair-upkeep', t.hairUpkeep, answers.upkeep, HAIR_UPKEEP, 'any', (v) =>
        set('upkeep', v),
      )}

      <h4>{t.hairSuggest}</h4>
      {advice.length === 0 ? <p className="muted">{t.hairNone}</p> : null}
      <ul className="member-list">
        {advice.map(({ style }) => (
          <li key={style.id} className="member-row">
            <label className="check">
              <input
                type="radio"
                name="hair-style"
                checked={styleId === style.id}
                onChange={() => setStyleId(style.id)}
              />{' '}
              <strong>{localizedName(style.name, lang)}</strong>
            </label>
            {(lang === 'th' ? style.about?.th : style.about?.en) || style.about?.th ? (
              <p className="muted">
                {(lang === 'th' ? style.about?.th : style.about?.en) || style.about?.th}
              </p>
            ) : null}
          </li>
        ))}
      </ul>

      <h4>{t.hairPhotoTitle}</h4>
      <p className="muted">{t.hairPhotoNote}</p>
      <div className="form-row">
        <label className="check">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />{' '}
          {t.hairConsent}
        </label>
        <label className="label" htmlFor="hair-photo">
          {t.hairPhotoFile}
        </label>
        <input
          id="hair-photo"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={!consent}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </div>
      <div className="actions">
        <AsyncButton onClick={() => send(false)}>{t.hairSend}</AsyncButton>
        <AsyncButton variant="secondary" onClick={() => send(true)}>
          {t.hairRemovePhoto}
        </AsyncButton>
      </div>
      {ai?.enabled ? (
        <div aria-label={t.hairAiTitle}>
          <h4>{t.hairAiTitle}</h4>
          <label className="check">
            <input type="checkbox" checked={aiTick} onChange={(e) => setAiTick(e.target.checked)} />{' '}
            {t.hairAiConsent}
          </label>
          <div className="actions">
            <AsyncButton variant="secondary" onClick={readWithAi}>
              {t.hairAiRead}
            </AsyncButton>
            {ai.consent ? (
              <AsyncButton variant="secondary" onClick={withdrawAi}>
                {t.hairAiWithdraw}
              </AsyncButton>
            ) : null}
          </div>
          {aiNote === 'photo' ? <p role="alert">{t.hairAiNeedPhoto}</p> : null}
          {aiNote === 'consent' ? <p role="alert">{t.hairAiNeedConsent}</p> : null}
          {aiNote === 'unclear' ? <p role="alert">{t.hairAiUnclear}</p> : null}
          {aiNote === 'failed' ? <p role="alert">{t.hairAiFailed}</p> : null}
          {aiNote === 'withdrawn' ? <p role="status">{t.hairAiWithdrawn}</p> : null}
          {aiLabels ? (
            <p role="status">{fmt(t.hairAiResult, { labels: hairLabelsText(t, aiLabels) })}</p>
          ) : null}
        </div>
      ) : null}
      {note === 'saved' ? <p role="status">{t.hairSaved}</p> : null}
      {note === 'removed' ? <p role="status">{t.hairRemoved}</p> : null}
      {note === 'consent' ? <p role="alert">{t.hairNeedConsent}</p> : null}
      {note === 'early' ? <p role="alert">{t.hairTooEarly}</p> : null}
      {note === 'photo' ? <p role="alert">{t.hairBadPhoto}</p> : null}
      {note === 'failed' ? <p role="alert">{t.err_load_failed}</p> : null}
    </div>
  );
}
