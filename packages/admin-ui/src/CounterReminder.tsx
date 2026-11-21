import { useState } from 'react';
import { fmt, useI18n } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';

/**
 * Reminder for a booking made at the counter: the front desk types the guest's e-mail, or shows a one-time code the guest sends to the shop's
 * LINE. One reminder goes out before the appointment (the existing tick); the contact is erased once the booking is over.
 */
export function CounterReminder({
  ctx,
  appointmentId,
}: {
  ctx: PageContext;
  appointmentId: string;
}) {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [note, setNote] = useState<'saved' | 'bad' | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const save = async () => {
    setNote(null);
    const r = await ctx.client.rpc('set_appointment_contact', {
      p_appt: appointmentId,
      p_email: email.trim(),
    });
    setNote(r.error ? 'bad' : 'saved');
  };
  const show = async () => {
    const r = await ctx.client.rpc('appointment_guest_code', { p_appt: appointmentId });
    if (r.error || typeof r.data !== 'string') return setNote('bad');
    setNote(null);
    setCode(r.data);
  };
  return (
    <section className="cal-deposits" aria-label={t.calRemTitle}>
      <h3>{t.calRemTitle}</h3>
      <p className="muted">{t.calRemIntro}</p>
      <div className="form-row">
        <label className="label" htmlFor="rem-email">
          {t.calRemEmail}
        </label>
        <input
          id="rem-email"
          className="field"
          type="email"
          maxLength={120}
          autoComplete="off"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <AsyncButton variant="secondary" onClick={save}>
          {t.calRemSave}
        </AsyncButton>
      </div>
      {note === 'saved' ? <Notice kind="success">{t.calRemSaved}</Notice> : null}
      {note === 'bad' ? <Notice kind="error">{t.calRemBad}</Notice> : null}
      <div className="actions">
        <AsyncButton variant="secondary" onClick={show}>
          {t.calRemCode}
        </AsyncButton>
      </div>
      {code ? (
        <div role="status">
          <p>
            {fmt(t.calRemCodeShown, { code: '' })}
            <strong className="mono">{code}</strong>
          </p>
          <p className="muted">{t.calRemCodeOnce}</p>
        </div>
      ) : null}
    </section>
  );
}
