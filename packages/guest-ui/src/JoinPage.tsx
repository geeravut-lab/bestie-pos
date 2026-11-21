import { useState } from 'react';
import { passLink } from '@bestie/core';
import { GUEST_LANGS, useI18n } from '@bestie/i18n';
import { AsyncButton, LangSwitch } from '@bestie/ui';
import { registerPass } from './networkApi';
import type { RegisterResult } from './networkApi';

/** Sign-up for a Tourist Pass (`/join/<network>`): a name, a phone number and an explicit consent tick. Nothing else is asked. */
export function JoinPage({ slug }: { slug: string }) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [consent, setConsent] = useState(false);
  const [result, setResult] = useState<RegisterResult | null>(null);

  const submit = async () => {
    setResult(null);
    if (!consent) return setResult({ ok: false, error: 'consent_needed' });
    setResult(await registerPass(slug, { name: name.trim(), phone: phone.trim(), consent }));
  };
  const err = (e: Extract<RegisterResult, { ok: false }>['error']): string =>
    e === 'exists'
      ? t.njExists
      : e === 'invalid'
        ? t.njInvalid
        : e === 'consent_needed'
          ? t.njConsentNeeded
          : e === 'not_found'
            ? t.njNotFound
            : e === 'rate'
              ? t.njRate
              : t.njFailed;

  return (
    <>
      <div className="guest-head">
        <h1>{t.njTitle}</h1>
        <LangSwitch langs={GUEST_LANGS} />
      </div>
      {result?.ok ? (
        <section className="card" role="status">
          <h2>{t.njDone}</h2>
          <p className="muted">{t.njBookmark}</p>
          <p>
            {t.npCodeLabel}: <strong className="mono pass-code">{result.code}</strong>
          </p>
          <a className="btn btn-primary" href={passLink('', result.token)}>
            {t.njOpen}
          </a>
        </section>
      ) : (
        <form className="card auth-form" onSubmit={(e) => e.preventDefault()}>
          <p>{t.njIntro}</p>
          <div className="form-row">
            <label className="label" htmlFor="nj-name">
              {t.njName}
            </label>
            <input
              id="nj-name"
              className="field"
              autoComplete="name"
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="form-row">
            <label className="label" htmlFor="nj-phone">
              {t.njPhone}
            </label>
            <input
              id="nj-phone"
              className="field"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              maxLength={30}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
          <label className="check-row">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            <span>{t.njConsent}</span>
          </label>
          {result && !result.ok ? <p role="alert">{err(result.error)}</p> : null}
          <AsyncButton
            type="submit"
            disabled={name.trim() === '' || phone.trim() === ''}
            onClick={submit}
          >
            {t.njSubmit}
          </AsyncButton>
        </form>
      )}
    </>
  );
}
