import { useState } from 'react';
import { fmt, formatDateTime, useI18n } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useRemote } from './useRemote';

type Status = { room_id: string; on: boolean; hint: string | null; seen_at: string | null };

/** The key of ONE room's Bestie Song Bridge (the small program that drives the venue's own karaoke system). The key is shown once. */
export function KaraokeBridgePanel({
  ctx,
  storeId,
  roomId,
}: {
  ctx: PageContext;
  storeId: string;
  roomId: string;
}) {
  const { t, lang } = useI18n();
  const [key, setKey] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const data = useRemote<Status | null>(async () => {
    const r = await ctx.client.rpc('karaoke_bridge_status', { p_store: storeId });
    if (r.error) return null;
    return (
      ((Array.isArray(r.data) ? r.data : []) as Status[]).find((x) => x.room_id === roomId) ?? null
    );
  }, `${storeId}:${roomId}`);
  const st = data.data;
  const make = async () => {
    setMsg(null);
    const r = await ctx.client.rpc('rotate_karaoke_bridge', { p_room: roomId });
    if (r.error || typeof r.data !== 'string') return setMsg(t.err_save_failed);
    setKey(r.data);
    data.reload();
  };
  const revoke = async () => {
    setMsg(null);
    const r = await ctx.client.rpc('revoke_karaoke_bridge', { p_room: roomId });
    if (r.error) return setMsg(t.err_save_failed);
    setKey(null);
    data.reload();
  };
  return (
    <div className="card admin-card" aria-label={t.sbTitle}>
      <h3>{t.sbTitle}</h3>
      <p className="muted">{t.sbIntro}</p>
      {st?.on ? (
        <p>
          {fmt(t.sbOn, { hint: st.hint ?? '' })}{' '}
          {st.seen_at ? fmt(t.sbSeen, { at: formatDateTime(lang, st.seen_at) }) : t.sbNeverSeen}
        </p>
      ) : (
        <p className="muted">{t.sbOff}</p>
      )}
      {msg ? <Notice kind="error">{msg}</Notice> : null}
      {key ? (
        <Notice kind="info">
          {t.sbKeyOnce}
          <br />
          <span className="mono">{key}</span>
        </Notice>
      ) : null}
      <div className="actions">
        <AsyncButton variant="secondary" onClick={make}>
          {st?.on ? t.sbReplace : t.sbMake}
        </AsyncButton>
        {st?.on ? (
          <AsyncButton variant="secondary" onClick={revoke}>
            {t.sbRevoke}
          </AsyncButton>
        ) : null}
      </div>
    </div>
  );
}
