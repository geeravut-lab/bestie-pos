import { healthFlags, parseHealthAnswers } from '@bestie/core';
import { formatDateTime, useI18n } from '@bestie/i18n';
import type { PageContext } from '@bestie/auth';
import { tx } from './stockInput';
import { useRemote } from './useRemote';

type Row = {
  id: string;
  answers: ReturnType<typeof parseHealthAnswers>;
  signedName: string;
  signedAt: string;
};

/** On a booking: the health form the guest signed on her own phone (newest first; the front desk reads it before the visit). */
export function GuestHealthPanel({
  ctx,
  appointmentId,
}: {
  ctx: PageContext;
  appointmentId: string;
}) {
  const { t, lang } = useI18n();
  const data = useRemote<Row[]>(async () => {
    const r = await ctx.client
      .from('health_intakes')
      .select('id, answers, signed_name, signed_at')
      .eq('appointment_id', appointmentId)
      .order('signed_at', { ascending: false })
      .limit(3);
    if (r.error) return [];
    return ((r.data ?? []) as Record<string, unknown>[]).map((x) => ({
      id: String(x.id),
      answers: parseHealthAnswers(x.answers),
      signedName: String(x.signed_name),
      signedAt: String(x.signed_at),
    }));
  }, `gh:${appointmentId}`);
  const latest = data.data?.[0];
  if (!latest) return null;
  const f = healthFlags(latest.answers);
  return (
    <section className="card admin-card" aria-label={t.hrGuestHealth}>
      <h3>{t.hrGuestHealth}</h3>
      <p className="muted">
        {latest.signedName} · {formatDateTime(lang, latest.signedAt)}
      </p>
      <ul>
        {f.yes.map((k) => (
          <li key={k}>
            <strong>{tx(t, `crHealth_${k}`)}:</strong> {t.crYes}
          </li>
        ))}
        {f.text.map((k) => (
          <li key={k}>
            <strong>{tx(t, `crHealth_${k}`)}:</strong> {latest.answers[k]}
          </li>
        ))}
        {f.yes.length === 0 && f.text.length === 0 ? <li className="muted">—</li> : null}
      </ul>
    </section>
  );
}
