import { useState } from 'react';
import { useI18n } from '@bestie/i18n';
import { AsyncButton } from './AsyncButton';
import { isPhoneDevice, promptInstall, useInstallApp } from './useInstallApp';

/**
 * Small button for the top bar, for computers and tablets only: where installing really is possible (a browser prompt, or the iPad steps on the account page).
 * On a smartphone the top bar is too narrow, so the phone uses the "Install the app on this device" card on the account page instead.
 */
export function InstallAppButton({ onShowSteps }: { onShowSteps: () => void }) {
  const { t } = useI18n();
  const state = useInstallApp();
  if (typeof navigator !== 'undefined' && isPhoneDevice(navigator.userAgent)) return null;
  if (state === 'available')
    return (
      <AsyncButton variant="secondary" className="install-btn" onClick={() => promptInstall()}>
        {t.installShort}
      </AsyncButton>
    );
  if (state === 'ios')
    return (
      <button type="button" className="btn btn-secondary install-btn" onClick={onShowSteps}>
        {t.installShort}
      </button>
    );
  return null;
}

/** The permanent place (account page): a button where the browser allows it, the steps where it does not. */
export function InstallAppCard() {
  const { t } = useI18n();
  const state = useInstallApp();
  const [note, setNote] = useState<string | null>(null);
  const install = async () => {
    const r = await promptInstall();
    setNote(r === 'accepted' ? t.installAccepted : r === 'dismissed' ? t.installDismissed : null);
  };
  return (
    <section className="card auth-card" id="install">
      <h2>{t.installTitle}</h2>
      {state === 'installed' ? <p className="muted">{t.installDone}</p> : <p>{t.installBody}</p>}
      {state === 'available' ? (
        <AsyncButton onClick={install}>{t.installButton}</AsyncButton>
      ) : null}
      {state === 'ios' ? (
        <>
          <h3>{t.installIosTitle}</h3>
          <ol className="install-steps">
            <li>{t.installIos1}</li>
            <li>{t.installIos2}</li>
            <li>{t.installIos3}</li>
          </ol>
        </>
      ) : null}
      {state === 'other' ? <p className="muted">{t.installOther}</p> : null}
      {note ? <p role="status">{note}</p> : null}
    </section>
  );
}
