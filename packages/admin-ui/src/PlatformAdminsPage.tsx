import { useState } from 'react';
import { fmt, formatDateTime, useI18n } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useRemote } from './useRemote';

type Admin = {
  userId: string;
  email: string;
  addedAt: string;
  addedBy: string | null;
  isMe: boolean;
};
type LogAction = 'add' | 'remove' | 'member_move' | 'org_delete';
type LogLine = { action: LogAction; actor: string; target: string; detail: string; at: string };
const LOG_ACTIONS: readonly string[] = ['add', 'remove', 'member_move', 'org_delete'];
const obj = (x: unknown): Record<string, unknown> =>
  x && typeof x === 'object' ? (x as Record<string, unknown>) : {};
const str = (x: unknown, fallback = ''): string => (typeof x === 'string' ? x : fallback);

/**
 * Platform administrators: the people who may open the platform pages of every business. The table behind it has no browser access at all; this page
 * calls three server functions (list / add / remove) that only a platform administrator may call. Adding takes an EXISTING account with a confirmed
 * e-mail; nobody removes themselves and the last administrator stays; every change is logged and the others are told.
 */
export function PlatformAdminsPage({ ctx }: { ctx: PageContext }) {
  const { t, lang } = useI18n();
  const [email, setEmail] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const data = useRemote(async () => {
    if (!ctx.isPlatformAdmin) return null;
    const r = await ctx.client.rpc('platform_admins_list');
    if (r.error) throw new Error('load');
    const o = obj(r.data);
    const admins: Admin[] = (Array.isArray(o.admins) ? o.admins : []).map((x) => {
      const a = obj(x);
      return {
        userId: str(a.user_id),
        email: str(a.email, '—'),
        addedAt: str(a.added_at),
        addedBy: typeof a.added_by_email === 'string' ? a.added_by_email : null,
        isMe: a.is_me === true,
      };
    });
    const log: LogLine[] = (Array.isArray(o.log) ? o.log : []).map((x) => {
      const l = obj(x);
      return {
        action: (LOG_ACTIONS.includes(str(l.action)) ? str(l.action) : 'add') as LogAction,
        actor: str(l.actor_email, '—'),
        target: str(l.target_email, '—'),
        detail: str(l.detail),
        at: str(l.at),
      };
    });
    return { admins, log };
  }, `${ctx.isPlatformAdmin}`);
  const { reload } = data;
  if (!ctx.isPlatformAdmin)
    return (
      <div className="admin-page">
        <Notice kind="error">{t.brandAdminOnly}</Notice>
      </div>
    );
  const d = data.data;

  const errText = (code: string | undefined): string =>
    code === '22023'
      ? t.paErrInvalid
      : code === 'P0002'
        ? t.paErrNotFound
        : code === '55000'
          ? t.paErrUnconfirmed
          : code === '23505'
            ? t.paErrAlready
            : t.paErr;

  const add = async () => {
    setMsg(null);
    const wanted = email.trim();
    const r = await ctx.client.rpc('platform_admin_add', { p_email: wanted });
    if (r.error) return setMsg({ kind: 'error', text: errText(r.error.code) });
    setMsg({ kind: 'success', text: fmt(t.paAdded, { email: wanted.toLowerCase() }) });
    setEmail('');
    reload();
  };
  const remove = async (userId: string) => {
    setMsg(null);
    const r = await ctx.client.rpc('platform_admin_remove', { p_user: userId });
    setConfirming(null);
    if (r.error)
      return setMsg({ kind: 'error', text: r.error.code === '55000' ? t.paErrSelf : t.paErr });
    setMsg({ kind: 'success', text: t.paRemoved });
    reload();
  };

  return (
    <div className="admin-page">
      <h1>{t.paTitle}</h1>
      <Notice kind="info">{t.paIntro}</Notice>
      {msg ? <Notice kind={msg.kind}>{msg.text}</Notice> : null}
      <section className="card admin-card">
        <h2>{t.paAddTitle}</h2>
        <div className="form-inline">
          <input
            type="email"
            inputMode="email"
            autoComplete="off"
            aria-label={t.paEmail}
            placeholder={t.paEmail}
            maxLength={254}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <AsyncButton onClick={add} disabled={email.trim().length < 3}>
            {t.paAdd}
          </AsyncButton>
        </div>
      </section>
      {data.status === 'loading' ? (
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      ) : null}
      {data.status === 'error' ? <Notice kind="error">{t.err_load_failed}</Notice> : null}
      {d ? (
        <>
          <h2>{fmt(t.paListTitle, { n: d.admins.length })}</h2>
          <ul className="member-list">
            {d.admins.map((a) => (
              <li key={a.userId} className="card admin-card">
                <strong>{a.email}</strong>{' '}
                {a.isMe ? <span className="badge">{t.paYou}</span> : null}
                <p className="muted">
                  {a.addedAt ? fmt(t.paAddedOn, { at: formatDateTime(lang, a.addedAt) }) : ''}{' '}
                  {a.addedBy ? fmt(t.paAddedBy, { who: a.addedBy }) : `· ${t.paAddedByHand}`}
                </p>
                {a.isMe ? null : confirming === a.userId ? (
                  <div className="form-inline">
                    <AsyncButton onClick={() => remove(a.userId)}>
                      {fmt(t.paConfirmRemove, { email: a.email })}
                    </AsyncButton>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setConfirming(null)}
                    >
                      {t.paCancel}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    aria-label={`${t.paRemove} ${a.email}`}
                    onClick={() => setConfirming(a.userId)}
                  >
                    {t.paRemove}
                  </button>
                )}
              </li>
            ))}
          </ul>
          <h2>{t.paLogTitle}</h2>
          {d.log.length === 0 ? (
            <p className="muted">{t.paLogNone}</p>
          ) : (
            <ul className="member-list">
              {d.log.map((l, i) => (
                <li key={`${l.at}-${i}`} className="card admin-card">
                  {fmt(
                    l.action === 'add'
                      ? t.paLogAdd
                      : l.action === 'remove'
                        ? t.paLogRemove
                        : l.action === 'member_move'
                          ? t.paLogMove
                          : t.paLogOrgDelete,
                    { actor: l.actor, target: l.target, detail: l.detail },
                  )}
                  <p className="muted">{l.at ? formatDateTime(lang, l.at) : ''}</p>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </div>
  );
}
