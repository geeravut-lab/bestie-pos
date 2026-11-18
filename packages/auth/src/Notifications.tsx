import { useCallback, useEffect, useState } from 'react';
import { errorText, fmt, formatDateTime, toErrorCode, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton, Icon, Spinner } from '@bestie/ui';
import { useAuth } from './context';
import { Notice } from './components';
import { useLiveSync } from './useLiveSync';

export type AppNotice = {
  id: string;
  kind: string;
  title: string;
  body: string;
  href: string | null;
  read_at: string | null;
  created_at: string;
};
type Prefs = { line_transactional: boolean; line_reminders: boolean };
const DEFAULT_PREFS: Prefs = { line_transactional: true, line_reminders: false };

/** Bell with the unread count; refreshed by the person's own private Realtime channel (`u:<id>`), with the usual polling fallback. */
export function NotificationBell() {
  const { t } = useI18n();
  const { client, user } = useAuth();
  const [unread, setUnread] = useState(0);
  const load = useCallback(async () => {
    if (!client) return;
    const { count, error } = await client
      .from('app_notifications')
      .select('id', { count: 'exact', head: true })
      .is('read_at', null);
    if (!error) setUnread(count ?? 0);
  }, [client]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async read of an EXTERNAL system (the database); state is set after the await
    void load();
  }, [load]);
  useLiveSync(client, user ? [`u:${user.id}`] : [], load);
  const label = unread > 0 ? fmt(t.notifBellUnread, { n: unread }) : t.notifBell;
  return (
    <a className="icon-button bell" href="/notifications" aria-label={label} title={label}>
      <Icon name="bell" />
      {unread > 0 ? (
        <span className="bell-badge" aria-hidden="true">
          {unread > 9 ? '9+' : unread}
        </span>
      ) : null}
    </a>
  );
}

export function NotificationsPage() {
  const { t, lang } = useI18n();
  const { client, user } = useAuth();
  const [items, setItems] = useState<AppNotice[] | null>(null);
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    if (!client) return;
    const [list, pr] = await Promise.all([
      client
        .from('app_notifications')
        .select('id, kind, title, body, href, read_at, created_at')
        .order('created_at', { ascending: false })
        .limit(50),
      client.from('notification_prefs').select('line_transactional, line_reminders').maybeSingle(),
    ]);
    if (list.error) {
      setError(toErrorCode(list.error));
      return;
    }
    setError(null);
    setItems((list.data ?? []) as AppNotice[]);
    if (pr.data) setPrefs(pr.data as Prefs);
  }, [client]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async read of an EXTERNAL system (the database); state is set after the await
    void load();
  }, [load]);
  useLiveSync(client, user ? [`u:${user.id}`] : [], load);

  const mark = async (id: string) => {
    if (!client) return;
    const { error: e } = await client
      .from('app_notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('id', id);
    if (e) throw e;
    await load();
  };
  const markAll = async () => {
    if (!client) return;
    const { error: e } = await client
      .from('app_notifications')
      .update({ read_at: new Date().toISOString() })
      .is('read_at', null);
    if (e) throw e;
    await load();
  };
  const remove = async (id: string) => {
    if (!client) return;
    const { error: e } = await client.from('app_notifications').delete().eq('id', id);
    if (e) throw e;
    await load();
  };
  const setPref = async (patch: Partial<Prefs>) => {
    if (!client || !user) return;
    setSaved(false);
    const next = { ...prefs, ...patch };
    const { error: e } = await client
      .from('notification_prefs')
      .upsert({ user_id: user.id, ...next, updated_at: new Date().toISOString() });
    if (e) throw e;
    setPrefs(next);
    setSaved(true);
  };
  const fail = (code: ErrorKey) => setError(code);
  const failAny = (e: unknown) => setError(toErrorCode(e));
  const hasUnread = (items ?? []).some((n) => !n.read_at);

  return (
    <div className="admin-page notif-page">
      <h1>{t.notifTitle}</h1>
      <p className="muted">{t.notifIntro}</p>
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}

      <section className="card admin-card" aria-labelledby="notif-list">
        <div className="notif-head">
          <h2 id="notif-list">{t.notifTitle}</h2>
          {hasUnread ? (
            <AsyncButton variant="secondary" onClick={markAll} onActionError={fail}>
              {t.notifMarkAll}
            </AsyncButton>
          ) : null}
        </div>
        {items === null && !error ? (
          <p role="status">
            <Spinner /> {t.loading}
          </p>
        ) : null}
        {items && items.length === 0 ? <p className="muted">{t.notifEmpty}</p> : null}
        <ul className="notif-list">
          {(items ?? []).map((n) => (
            <li key={n.id} className={n.read_at ? 'notif' : 'notif notif-unread'}>
              <div className="notif-main">
                <strong>
                  {!n.read_at ? <span className="chip">{t.notifUnread}</span> : null} {n.title}
                </strong>
                <span className="muted">{formatDateTime(lang, n.created_at)}</span>
                {n.body ? <p className="notif-body">{n.body}</p> : null}
              </div>
              <div className="notif-actions">
                {n.href ? (
                  <a
                    className="btn btn-secondary"
                    href={n.href}
                    onClick={() => void mark(n.id).catch(failAny)}
                  >
                    {t.notifOpen}
                  </a>
                ) : null}
                {!n.read_at ? (
                  <AsyncButton variant="secondary" onClick={() => mark(n.id)} onActionError={fail}>
                    {t.notifMarkRead}
                  </AsyncButton>
                ) : null}
                <AsyncButton variant="danger" onClick={() => remove(n.id)} onActionError={fail}>
                  {t.notifDelete}
                </AsyncButton>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="card admin-card" aria-labelledby="notif-prefs">
        <h2 id="notif-prefs">{t.notifPrefsTitle}</h2>
        <p className="muted">{t.notifPrefsIntro}</p>
        <label className="check-row">
          <input
            type="checkbox"
            checked={prefs.line_transactional}
            onChange={(e) => void setPref({ line_transactional: e.target.checked }).catch(failAny)}
          />
          <span>
            <strong>{t.notifPrefTransactional}</strong>
            <span className="muted"> — {t.notifPrefTransactionalHint}</span>
          </span>
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={prefs.line_reminders}
            onChange={(e) => void setPref({ line_reminders: e.target.checked }).catch(failAny)}
          />
          <span>
            <strong>{t.notifPrefReminders}</strong>
            <span className="muted"> — {t.notifPrefRemindersHint}</span>
          </span>
        </label>
        {saved ? (
          <p role="status" className="muted">
            {t.notifPrefSaved}
          </p>
        ) : null}
      </section>
    </div>
  );
}
