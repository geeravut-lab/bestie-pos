import { useRef, useState } from 'react';
import { AppError, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { TRANSLATE_TARGETS, translateText } from './aiApi';
import type { TranslateTarget } from './aiApi';
import { listenOnce, speak, speechInSupported, speechOutSupported } from './speech';

type Turn = { id: number; who: 'me' | 'them'; heard: string; said: string; to: TranslateTarget };

/** A spoken conversation with a guest (module `ai.translate`): "I speak" listens in my language and shows / reads the translation in theirs; "They speak" does the reverse. */
export function LiveTranslate({ ctx, storeId }: { ctx: PageContext; storeId: string | null }) {
  const { t } = useI18n();
  const [mine, setMine] = useState<TranslateTarget>('th');
  const [theirs, setTheirs] = useState<TranslateTarget>('en');
  const [aloud, setAloud] = useState(true);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [listening, setListening] = useState<'me' | 'them' | null>(null);
  const [note, setNote] = useState<'nothing' | 'off' | 'failed' | null>(null);
  const [error, setError] = useState<ErrorKey | null>(null);
  const stop = useRef<(() => void) | null>(null);
  const seq = useRef(0);
  const names: Record<TranslateTarget, string> = {
    th: t.langTh,
    en: t.langEn,
    ru: t.langRu,
    he: t.langHe,
    de: t.langDe,
    zh: t.langZh,
  };

  const turn = (who: 'me' | 'them') => async () => {
    setNote(null);
    setError(null);
    if (!storeId) return;
    const from = who === 'me' ? mine : theirs;
    const to = who === 'me' ? theirs : mine;
    setListening(who);
    const heard = await listenOnce(from, (s) => (stop.current = s));
    stop.current = null;
    setListening(null);
    if (!heard) return setNote('nothing');
    try {
      const said = await translateText(ctx.client, storeId, heard, to);
      if (said === null) return setNote('off');
      seq.current += 1;
      setTurns((list) => [{ id: seq.current, who, heard, said, to }, ...list].slice(0, 20));
      // what I say is read aloud so the guest hears it; what the guest says is only shown to me
      if (aloud && who === 'me') speak(said, to);
    } catch (e) {
      if (e instanceof AppError) return setError(e.code);
      setNote('failed');
    }
  };

  if (!speechInSupported())
    return (
      <section className="card admin-card" aria-label={t.ltTitle}>
        <h2>{t.ltTitle}</h2>
        <Notice kind="info">{t.ltUnsupported}</Notice>
      </section>
    );
  const select = (
    id: string,
    label: string,
    value: TranslateTarget,
    set: (v: TranslateTarget) => void,
  ) => (
    <div className="form-row">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="field"
        value={value}
        onChange={(e) => set(e.target.value as TranslateTarget)}
      >
        {TRANSLATE_TARGETS.map((l) => (
          <option key={l} value={l}>
            {names[l]}
          </option>
        ))}
      </select>
    </div>
  );
  return (
    <section className="card admin-card" aria-label={t.ltTitle}>
      <h2>{t.ltTitle}</h2>
      <p className="muted">{t.ltIntro}</p>
      {error ? <Notice kind="error">{t[error]}</Notice> : null}
      {note ? (
        <Notice kind={note === 'nothing' ? 'info' : 'error'}>
          {note === 'nothing' ? t.ltNothing : note === 'off' ? t.trOff : t.trFailed}
        </Notice>
      ) : null}
      {select('lt-mine', t.ltMine, mine, setMine)}
      {select('lt-theirs', t.ltTheirs, theirs, setTheirs)}
      {speechOutSupported() ? (
        <label className="check">
          <input type="checkbox" checked={aloud} onChange={(e) => setAloud(e.target.checked)} />{' '}
          {t.ltAloud}
        </label>
      ) : null}
      <div className="actions">
        <AsyncButton onClick={turn('me')} disabled={listening !== null}>
          {listening === 'me' ? t.ltListening : t.ltISpeak}
        </AsyncButton>
        <AsyncButton variant="secondary" onClick={turn('them')} disabled={listening !== null}>
          {listening === 'them' ? t.ltListening : t.ltTheySpeak}
        </AsyncButton>
        {listening ? (
          <button type="button" className="btn btn-secondary" onClick={() => stop.current?.()}>
            {t.ltStop}
          </button>
        ) : null}
      </div>
      <ul className="member-list" aria-live="polite">
        {turns.map((x) => (
          <li key={x.id} className="member-row">
            <p className="muted">
              {x.who === 'me' ? t.ltISpeak : t.ltTheySpeak}: {x.heard}
            </p>
            <p>
              <strong className="lt-said">{x.said}</strong>
            </p>
          </li>
        ))}
      </ul>
      <p className="muted">{t.trDraftNote}</p>
    </section>
  );
}
