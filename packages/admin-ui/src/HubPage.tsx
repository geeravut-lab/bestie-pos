import { useState } from 'react';
import {
  WEBHOOK_EVENTS,
  accountingCsv,
  bangkokDate,
  parseAccountingRows,
  parseApiKeys,
  parseWebhooks,
  webhookUrlOk,
} from '@bestie/core';
import { fmt, formatDateTime, useI18n } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useRemote } from './useRemote';

const addDays = (d: string, n: number): string => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
const evtLabel = (t: ReturnType<typeof useI18n>['t'], e: string): string =>
  e === 'order.paid'
    ? t['hubEvt_order.paid']
    : e === 'tour.booked'
      ? t['hubEvt_tour.booked']
      : t['hubEvt_appointment.created'];

/** The owner's integration hub: API keys, signed webhooks and the accountant's CSV (module `integration.hub`). */
export function HubPage({ ctx }: { ctx: PageContext }) {
  const { t, lang } = useI18n();
  const [today] = useState(() => bangkokDate(Date.now()));
  const [keyName, setKeyName] = useState('');
  const [shownKey, setShownKey] = useState<string | null>(null);
  const [hookUrl, setHookUrl] = useState('');
  const [events, setEvents] = useState<string[]>(['order.paid']);
  const [shownSecret, setShownSecret] = useState<string | null>(null);
  const [from, setFrom] = useState(addDays(today, -30));
  const [to, setTo] = useState(today);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  const data = useRemote(async () => {
    if (!ctx.isOwner) return null;
    const [keys, hooks] = await Promise.all([
      ctx.client
        .from('api_keys')
        .select('id, name, prefix, scopes, last_used_at, revoked_at')
        .eq('org_id', ctx.orgId)
        .order('created_at'),
      ctx.client.rpc('list_webhook_endpoints', { p_org: ctx.orgId }),
    ]);
    if (keys.error || hooks.error) throw new Error('load');
    return { keys: parseApiKeys(keys.data), hooks: parseWebhooks(hooks.data) };
  }, `${ctx.orgId}:${ctx.isOwner}`);
  const { reload } = data;

  if (!ctx.isOwner)
    return (
      <div className="admin-page">
        <h1>{t.hubTitle}</h1>
        <Notice kind="info">{t.hubOwnerOnly}</Notice>
      </div>
    );
  const fail = (code?: string) =>
    setMsg({
      kind: 'error',
      text:
        code === '0A000'
          ? t.hubOff
          : code === '23514' || code === '22023'
            ? t.hubInvalid
            : t.hubErr,
    });
  const createKey = async () => {
    setMsg(null);
    setShownKey(null);
    if (!keyName.trim()) return setMsg({ kind: 'error', text: t.hubInvalid });
    const r = await ctx.client.rpc('create_api_key', {
      p: { org_id: ctx.orgId, name: keyName.trim() },
    });
    const k = (r.data ?? {}) as { key?: string };
    if (r.error || !k.key) return fail(r.error?.code);
    setShownKey(k.key);
    setKeyName('');
    reload();
  };
  const revoke = async (id: string) => {
    const r = await ctx.client.rpc('revoke_api_key', { p_id: id });
    if (r.error) return fail(r.error.code);
    reload();
  };
  const addHook = async () => {
    setMsg(null);
    setShownSecret(null);
    if (!webhookUrlOk(hookUrl.trim()) || events.length === 0)
      return setMsg({ kind: 'error', text: t.hubInvalid });
    const r = await ctx.client.rpc('save_webhook_endpoint', {
      p: { org_id: ctx.orgId, url: hookUrl.trim(), events },
    });
    const o = (r.data ?? {}) as { secret?: string };
    if (r.error || !o.secret) return fail(r.error?.code);
    setShownSecret(o.secret);
    setHookUrl('');
    reload();
  };
  const delHook = async (id: string) => {
    const r = await ctx.client.rpc('delete_webhook_endpoint', { p_id: id });
    if (r.error) return fail(r.error.code);
    reload();
  };
  const download = async () => {
    setMsg(null);
    const r = await ctx.client.rpc('accounting_export', { p: { org_id: ctx.orgId, from, to } });
    if (r.error) return fail(r.error.code);
    const rows = parseAccountingRows(r.data);
    if (rows.length === 0) return setMsg({ kind: 'success', text: t.hubExportEmpty });
    const url = URL.createObjectURL(
      new Blob([accountingCsv(rows)], { type: 'text/csv;charset=utf-8' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `bestie-receipts-${from}-${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setMsg({ kind: 'success', text: fmt(t.hubExportDone, { n: rows.length }) });
  };
  const d = data.data;

  return (
    <div className="admin-page">
      <h1>{t.hubTitle}</h1>
      <Notice kind="info">{t.hubIntro}</Notice>
      {msg ? <Notice kind={msg.kind}>{msg.text}</Notice> : null}
      {data.status === 'loading' ? (
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      ) : null}
      {data.status === 'error' ? <Notice kind="error">{t.err_load_failed}</Notice> : null}

      <section className="card admin-card" aria-label={t.hubKeys}>
        <h2>{t.hubKeys}</h2>
        <p className="muted">{t.hubApiNote}</p>
        {d && d.keys.length === 0 ? <p className="muted">{t.hubKeyNone}</p> : null}
        <ul className="member-list">
          {(d?.keys ?? []).map((k) => (
            <li key={k.id}>
              <strong>{k.name}</strong> <code>{k.prefix}…</code>{' '}
              <span className="muted">
                {k.revokedAt
                  ? t.hubKeyRevoked
                  : k.lastUsedAt
                    ? fmt(t.hubKeyUsed, { when: formatDateTime(lang, k.lastUsedAt) })
                    : t.hubKeyNever}
              </span>
              {!k.revokedAt ? (
                <AsyncButton variant="secondary" onClick={() => revoke(k.id)}>
                  {t.hubKeyRevoke}
                </AsyncButton>
              ) : null}
            </li>
          ))}
        </ul>
        {shownKey ? (
          <Notice kind="success">
            {t.hubKeyShown} <code className="mono">{shownKey}</code>
          </Notice>
        ) : null}
        <div className="form-row">
          <label className="label" htmlFor="hub-key-name">
            {t.hubKeyName}
          </label>
          <input
            id="hub-key-name"
            value={keyName}
            maxLength={60}
            onChange={(e) => setKeyName(e.target.value)}
          />
        </div>
        <AsyncButton onClick={createKey}>{t.hubKeyCreate}</AsyncButton>
      </section>

      <section className="card admin-card" aria-label={t.hubHooks}>
        <h2>{t.hubHooks}</h2>
        <p className="muted">{t.hubSig}</p>
        {d && d.hooks.length === 0 ? <p className="muted">{t.hubHookNone}</p> : null}
        <ul className="member-list">
          {(d?.hooks ?? []).map((h) => (
            <li key={h.id}>
              <code>{h.url}</code>{' '}
              <span className="muted">{h.events.map((e) => evtLabel(t, e)).join(', ')}</span>{' '}
              {!h.active ? <span className="badge">{t.hubHookOff}</span> : null}{' '}
              {h.queued > 0 ? (
                <span className="badge">{fmt(t.hubHookQueued, { n: h.queued })}</span>
              ) : null}
              <AsyncButton variant="secondary" onClick={() => delHook(h.id)}>
                {t.hubHookDelete}
              </AsyncButton>
            </li>
          ))}
        </ul>
        {shownSecret ? (
          <Notice kind="success">
            {t.hubSecretShown} <code className="mono">{shownSecret}</code>
          </Notice>
        ) : null}
        <div className="form-row">
          <label className="label" htmlFor="hub-url">
            {t.hubUrl}
          </label>
          <input
            id="hub-url"
            inputMode="url"
            value={hookUrl}
            onChange={(e) => setHookUrl(e.target.value)}
          />
        </div>
        <fieldset>
          <legend className="label">{t.hubEvents}</legend>
          {WEBHOOK_EVENTS.map((e) => (
            <label key={e} className="check">
              <input
                type="checkbox"
                checked={events.includes(e)}
                onChange={() =>
                  setEvents((l) => (l.includes(e) ? l.filter((x) => x !== e) : [...l, e]))
                }
              />{' '}
              {evtLabel(t, e)}
            </label>
          ))}
        </fieldset>
        <AsyncButton onClick={addHook}>{t.hubHookAdd}</AsyncButton>
      </section>

      <section className="card admin-card" aria-label={t.hubExportTitle}>
        <h2>{t.hubExportTitle}</h2>
        <p className="muted">{t.hubExportIntro}</p>
        <div className="form-inline">
          <div className="form-row">
            <label className="label" htmlFor="hub-from">
              {t.hubFrom}
            </label>
            <input
              id="hub-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="form-row">
            <label className="label" htmlFor="hub-to">
              {t.hubTo}
            </label>
            <input id="hub-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
        <AsyncButton onClick={download}>{t.hubDownload}</AsyncButton>
      </section>
    </div>
  );
}
