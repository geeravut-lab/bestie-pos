import { useEffect, useState } from 'react';
import {
  EMPTY_SPA_ANSWERS,
  SPA_AREAS,
  SPA_FLAGS,
  SPA_GOALS,
  SPA_PRESSURES,
  adviseSpa,
  guestName,
  spaAdvisorNote,
} from '@bestie/core';
import type { SpaAdvice, SpaAnswers, SpaFlag, SpaInfo } from '@bestie/core';
import { fmt, useI18n } from '@bestie/i18n';
import type { Dict } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { loadSpaInfo } from './bookingApi';

const tx = (t: Dict, key: string): string => (t as Record<string, string>)[key] ?? key;
type Svc = { id: string; name: { th: string; en?: string } };

/**
 * "Not sure what to book?": closed questions and a safety screen, then the shop's own services that fit. Fixed rules in code, no AI, nothing is
 * stored. Shown only when the shop switched it on AND a therapist's sign-off is on file (the database says so). The guest can ignore it.
 */
export function SpaAdvisor({
  token,
  services,
  onPick,
}: {
  token: string;
  services: readonly Svc[];
  onPick: (serviceId: string, note: string) => void;
}) {
  const { t, lang } = useI18n();
  const [info, setInfo] = useState<SpaInfo | null>(null);
  const [answers, setAnswers] = useState<SpaAnswers>(EMPTY_SPA_ANSWERS);
  const [advice, setAdvice] = useState<SpaAdvice | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void loadSpaInfo(token).then((i) => alive && setInfo(i));
    return () => {
      alive = false;
    };
  }, [token]);
  if (!info?.enabled || info.services.every((s) => s.tags.length === 0)) return null;

  const toggle = <T extends string>(list: readonly T[], v: T): T[] =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
  const radio = <T extends string>(
    name: string,
    values: readonly T[],
    current: T | null,
    label: (v: T) => string,
    set: (v: T | null) => void,
  ) => (
    <div className="chips" role="radiogroup" aria-label={name}>
      <button
        type="button"
        className="chip"
        aria-pressed={current === null}
        onClick={() => set(null)}
      >
        {t.spaAny}
      </button>
      {values.map((v) => (
        <button
          key={v}
          type="button"
          className="chip"
          aria-pressed={current === v}
          onClick={() => set(v)}
        >
          {label(v)}
        </button>
      ))}
    </div>
  );
  const name = (id: string): string => {
    const s = services.find((x) => x.id === id);
    return s ? guestName(s.name, lang) : '';
  };
  const askList = (flags: readonly SpaFlag[]): string =>
    flags.map((f) => tx(t, `spaFlag_${f}`)).join(', ');

  return (
    <section className="card spa-advisor" aria-label={t.spaTitle}>
      <h2>{t.spaTitle}</h2>
      <p className="muted">{t.spaIntro}</p>
      <fieldset className="form-row">
        <legend className="label">{t.spaGoal}</legend>
        {radio(
          t.spaGoal,
          SPA_GOALS,
          answers.goal,
          (v) => tx(t, `spaGoal_${v}`),
          (v) => setAnswers({ ...answers, goal: v }),
        )}
      </fieldset>
      <fieldset className="form-row">
        <legend className="label">{t.spaPressure}</legend>
        {radio(
          t.spaPressure,
          SPA_PRESSURES,
          answers.pressure,
          (v) => tx(t, `spaPressure_${v}`),
          (v) => setAnswers({ ...answers, pressure: v }),
        )}
      </fieldset>
      <fieldset className="form-row">
        <legend className="label">{t.spaAreas}</legend>
        <div className="chips">
          {SPA_AREAS.map((a) => (
            <button
              key={a}
              type="button"
              className="chip"
              aria-pressed={answers.areas.includes(a)}
              onClick={() => setAnswers({ ...answers, areas: toggle(answers.areas, a) })}
            >
              {tx(t, `spaArea_${a}`)}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset className="form-row">
        <legend className="label">{t.spaFlags}</legend>
        {SPA_FLAGS.map((f) => (
          <label key={f} className="check-row">
            <input
              type="checkbox"
              checked={answers.flags.includes(f)}
              onChange={() => setAnswers({ ...answers, flags: toggle(answers.flags, f) })}
            />
            <span>{tx(t, `spaFlag_${f}`)}</span>
          </label>
        ))}
      </fieldset>
      <AsyncButton
        variant="secondary"
        onClick={async () => {
          setChosen(null);
          setAdvice(adviseSpa(answers, info.services));
        }}
      >
        {t.spaShow}
      </AsyncButton>
      {advice?.safety === 'stop' ? <p role="alert">{t.spaStop}</p> : null}
      {advice && advice.safety !== 'stop' && advice.picks.length === 0 ? (
        <p className="muted">{t.spaNone}</p>
      ) : null}
      {advice && advice.picks.length > 0 ? (
        <ul className="spa-picks">
          {advice.picks.map((p) => (
            <li key={p.id} className="card">
              <strong>{name(p.id)}</strong>
              {p.askAbout.length > 0 ? (
                <p className="muted">{fmt(t.spaAsk, { list: askList(p.askAbout) })}</p>
              ) : null}
              <AsyncButton
                variant="secondary"
                onClick={async () => {
                  onPick(p.id, spaAdvisorNote(advice.flags));
                  setChosen(p.id);
                }}
              >
                {t.spaChoose}
              </AsyncButton>
              {chosen === p.id ? (
                <p role="status">
                  {t.spaChosen}
                  {advice.flags.length > 0 ? ` ${t.spaNoted}` : ''}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
