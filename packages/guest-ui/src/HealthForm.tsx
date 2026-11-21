import { useEffect, useState } from 'react';
import { HEALTH_TEXT, HEALTH_TEXT_MAX, HEALTH_YES_NO, healthIntakePayload } from '@bestie/core';
import type { HealthAnswers } from '@bestie/core';
import { useI18n } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { loadHealthFormEnabled, sendHealthForm } from './bookingApi';

/**
 * The spa's health form on the guest's own phone, after booking: closed yes / no answers and short texts, an explicit consent tick and
 * her typed full name as the signature. Sent for this one booking with the booking code as proof; only the shop's front desk can read it.
 */
export function HealthForm({ token, id, code }: { token: string; id: string; code: string }) {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState(false);
  const [answers, setAnswers] = useState<HealthAnswers>({});
  const [consent, setConsent] = useState(false);
  const [name, setName] = useState('');
  const [note, setNote] = useState<'saved' | 'bad' | 'failed' | null>(null);
  useEffect(() => {
    let alive = true;
    void loadHealthFormEnabled(token).then((v) => alive && setEnabled(v));
    return () => {
      alive = false;
    };
  }, [token]);
  if (!enabled) return null;
  const label = (k: string): string => (t as Record<string, string>)[k] ?? k;

  const send = async () => {
    setNote(null);
    const body = healthIntakePayload({
      storeId: 'x',
      customerId: 'x',
      answers,
      consent,
      signedName: name,
    });
    if (!body) return setNote('bad');
    const r = await sendHealthForm(token, id, code, {
      consent: true,
      signedName: name.trim(),
      answers: body.answers as Record<string, boolean | string>,
    });
    setNote(
      r.ok ? 'saved' : r.error === 'consent_needed' || r.error === 'bad_name' ? 'bad' : 'failed',
    );
  };

  return (
    <div className="card" aria-label={t.hfTitle}>
      <h3>{t.hfTitle}</h3>
      <p className="muted">{t.hfIntro}</p>
      {HEALTH_YES_NO.map((k) => (
        <label key={k} className="check">
          <input
            type="checkbox"
            checked={answers[k] === true}
            onChange={(e) => setAnswers({ ...answers, [k]: e.target.checked })}
          />{' '}
          {label(`crHealth_${k}`)}
        </label>
      ))}
      {HEALTH_TEXT.map((k) => (
        <div key={k} className="form-row">
          <label className="label" htmlFor={`hf-${k}`}>
            {label(`crHealth_${k}`)}
          </label>
          <input
            id={`hf-${k}`}
            className="field"
            maxLength={HEALTH_TEXT_MAX}
            value={answers[k] ?? ''}
            onChange={(e) => setAnswers({ ...answers, [k]: e.target.value })}
          />
        </div>
      ))}
      <label className="check">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />{' '}
        {t.hfConsent}
      </label>
      <div className="form-row">
        <label className="label" htmlFor="hf-sign">
          {t.crSignName}
        </label>
        <input
          id="hf-sign"
          className="field"
          maxLength={80}
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <AsyncButton onClick={send}>{t.hfSend}</AsyncButton>
      {note === 'saved' ? <p role="status">{t.hfSaved}</p> : null}
      {note === 'bad' ? <p role="alert">{t.crHealthBad}</p> : null}
      {note === 'failed' ? <p role="alert">{t.err_load_failed}</p> : null}
    </div>
  );
}
