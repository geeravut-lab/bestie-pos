import { useState } from 'react';
import { localizedName, parseHairStyles } from '@bestie/core';
import { useI18n } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useRemote } from './useRemote';

type Req = { styleName: string; answers: Record<string, string>; hasPhoto: boolean } | null;

/** On an online booking: what the guest chose in the hair advisor, and (for the stylist) the photo she sent with her consent. */
export function HairRequestPanel({
  ctx,
  appointmentId,
}: {
  ctx: PageContext;
  appointmentId: string;
}) {
  const { t, lang } = useI18n();
  const [photo, setPhoto] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const label = (k: string): string => (t as Record<string, string>)[k] ?? k;
  const data = useRemote<Req>(async () => {
    const r = await ctx.client
      .from('hair_requests')
      .select('style_id, answers, photo_expires_at')
      .eq('appointment_id', appointmentId)
      .maybeSingle();
    if (r.error || !r.data) return null;
    const row = r.data as {
      style_id: string | null;
      answers: unknown;
      photo_expires_at: string | null;
    };
    let styleName = '';
    if (row.style_id) {
      const s = await ctx.client
        .from('hair_styles')
        .select('id, name')
        .eq('id', row.style_id)
        .maybeSingle();
      const parsed = parseHairStyles(s.data ? [s.data] : []);
      styleName = parsed[0] ? localizedName(parsed[0].name, lang) : '';
    }
    const answers: Record<string, string> = {};
    for (const [k, v] of Object.entries((row.answers ?? {}) as Record<string, unknown>))
      if (typeof v === 'string') answers[k] = v;
    return {
      styleName,
      answers,
      hasPhoto: !!row.photo_expires_at && Date.parse(row.photo_expires_at) > Date.now(),
    };
  }, `hairreq:${appointmentId}:${lang}`);

  const req = data.data;
  if (!req) return null;
  const show = async () => {
    setGone(false);
    const { data: out, error } = await ctx.client.rpc('get_hair_photo', {
      p_appointment: appointmentId,
    });
    const o = out as { mime?: string; data?: string } | null;
    if (error || !o?.data || !o.mime) return setGone(true);
    setPhoto(`data:${o.mime};base64,${o.data}`);
  };
  return (
    <section className="card admin-card" aria-label={t.hrTitle}>
      <h3>{t.hrTitle}</h3>
      {req.styleName ? (
        <p>
          <strong>{t.hrStyle}:</strong> {req.styleName}
        </p>
      ) : null}
      <ul>
        {Object.entries(req.answers)
          .filter(([, v]) => v !== 'any' && v !== 'unknown')
          .map(([k, v]) => (
            <li key={k}>
              {label(`hair${k[0]!.toUpperCase()}${k.slice(1)}`)}: {label(`hair_${v}`)}
            </li>
          ))}
      </ul>
      {req.hasPhoto ? (
        photo ? (
          <>
            <img src={photo} alt={t.hrPhotoAlt} style={{ maxWidth: '100%', maxHeight: '60vh' }} />
            <p className="muted">{t.hrPhotoNote}</p>
          </>
        ) : (
          <AsyncButton variant="secondary" onClick={show}>
            {t.hrShowPhoto}
          </AsyncButton>
        )
      ) : (
        <p className="muted">{t.hrNoPhoto}</p>
      )}
      {gone ? <Notice kind="info">{t.hrPhotoGone}</Notice> : null}
    </section>
  );
}
