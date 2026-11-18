import { useState } from 'react';
import {
  AUDIT_EVENTS,
  AUDIT_GROUPS,
  DEFAULT_AUDIT_SETTINGS,
  auditEventLabelKey,
  auditGroupLabelKey,
  cleanAuditDetail,
  eventsInGroup,
  isCriticalAuditEvent,
  normalizeDisabled,
  setEventRecorded,
  setGroupRecorded,
  shouldRecord,
  toCsv,
} from '@bestie/core';
import type { AuditGroup, AuditSettings } from '@bestie/core';
import { errorText, formatDateTime, useI18n } from '@bestie/i18n';
import type { Dict, ErrorKey } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useRemote } from './useRemote';

type LogRow = {
  id: number;
  action: string;
  actor_id: string | null;
  actor_role: string | null;
  entity: string | null;
  entity_id: string | null;
  detail: Record<string, unknown>;
  source: 'app' | 'db';
  created_at: string;
};

const PAGE = 50;
const EXPORT_MAX = 5000;

const label = (t: Dict, key: string, fallback: string): string =>
  (t as Record<string, string>)[key] ?? fallback;

/** Bangkok-day boundaries (the shop's calendar), as ISO instants. */
const dayStart = (d: string) => `${d}T00:00:00+07:00`;
const dayEndExclusive = (d: string) =>
  new Date(new Date(`${d}T00:00:00+07:00`).getTime() + 86_400_000).toISOString();

export function AuditPage({ ctx }: { ctx: PageContext }) {
  const { t } = useI18n();
  const [tab, setTab] = useState<'log' | 'settings'>('log');
  const canView = ctx.permissions.includes('audit.view') || ctx.isOwner;
  const canEdit = ctx.permissions.includes('settings.manage') || ctx.isOwner;

  if (!canView && !canEdit) {
    return (
      <div className="admin-page">
        <Notice kind="error">{t.auditNoAccess}</Notice>
      </div>
    );
  }
  return (
    <div className="admin-page">
      <h1>{t.auditTitle}</h1>
      <div className="tabs" role="tablist">
        {canView ? (
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'log'}
            className="tab"
            onClick={() => setTab('log')}
          >
            {t.auditTabLog}
          </button>
        ) : null}
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'settings' || !canView}
          className="tab"
          onClick={() => setTab('settings')}
        >
          {t.auditTabSettings}
        </button>
      </div>
      {tab === 'log' && canView ? (
        <AuditLog ctx={ctx} />
      ) : (
        <AuditSettingsPanel ctx={ctx} canEdit={canEdit} />
      )}
    </div>
  );
}

// ── history ──────────────────────────────────────────────────────────────────
function AuditLog({ ctx }: { ctx: PageContext }) {
  const { t, lang } = useI18n();
  const [group, setGroup] = useState<AuditGroup | ''>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [pages, setPages] = useState(1);
  const [exportError, setExportError] = useState<ErrorKey | null>(null);

  const query = (limit: number) => {
    let q = ctx.client
      .from('audit_log')
      .select('id, action, actor_id, actor_role, entity, entity_id, detail, source, created_at')
      .eq('org_id', ctx.orgId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false });
    if (group) q = q.like('action', `${group}.%`);
    if (from) q = q.gte('created_at', dayStart(from));
    if (to) q = q.lt('created_at', dayEndExclusive(to));
    return q.limit(limit);
  };

  const { status, data, reload } = useRemote(async () => {
    const { data: rows, error } = await query(PAGE * pages);
    if (error) throw new Error(error.code ?? 'query');
    return (rows ?? []) as LogRow[];
  }, `${ctx.orgId}|${group}|${from}|${to}|${pages}`);

  const exportCsv = async () => {
    setExportError(null);
    const { data: rows, error } = await query(EXPORT_MAX);
    if (error) return setExportError('err_load_failed');
    const list = (rows ?? []) as LogRow[];
    const csv = toCsv(
      [
        'time',
        'event',
        'category',
        'actor_role',
        'actor_id',
        'entity',
        'entity_id',
        'source',
        'detail',
      ],
      list.map((r) => [
        r.created_at,
        r.action,
        r.action.split('.')[0],
        r.actor_role,
        r.actor_id,
        r.entity,
        r.entity_id,
        r.source,
        JSON.stringify(cleanAuditDetail(r.detail)),
      ]),
    );
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    // the export itself is audited (critical event: always recorded)
    await ctx.client.rpc('write_audit', {
      p_org: ctx.orgId,
      p_store: null,
      p_action: 'export.audit',
      p_entity: 'audit_log',
      p_entity_id: null,
      p_detail: { rows: list.length },
    });
  };

  return (
    <section className="card admin-card">
      <div className="filters">
        <div className="form-row">
          <label className="label" htmlFor="au-group">
            {t.auditFilterGroup}
          </label>
          <select
            id="au-group"
            className="field"
            value={group}
            onChange={(e) => {
              setGroup(e.target.value as AuditGroup | '');
              setPages(1);
            }}
          >
            <option value="">{t.auditAll}</option>
            {AUDIT_GROUPS.map((g) => (
              <option key={g} value={g}>
                {label(t, auditGroupLabelKey(g), g)}
              </option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label className="label" htmlFor="au-from">
            {t.auditFrom}
          </label>
          <input
            id="au-from"
            className="field"
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setPages(1);
            }}
          />
        </div>
        <div className="form-row">
          <label className="label" htmlFor="au-to">
            {t.auditTo}
          </label>
          <input
            id="au-to"
            className="field"
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setPages(1);
            }}
          />
        </div>
      </div>

      {status === 'loading' ? (
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      ) : status === 'error' ? (
        <>
          <Notice kind="error">{t.err_load_failed}</Notice>
          <AsyncButton variant="secondary" onClick={reload}>
            {t.retry}
          </AsyncButton>
        </>
      ) : data && data.length === 0 ? (
        <p className="muted">{t.auditEmpty}</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">{t.auditColTime}</th>
                <th scope="col">{t.auditColEvent}</th>
                <th scope="col">{t.auditColActor}</th>
                <th scope="col">{t.auditColEntity}</th>
                <th scope="col">{t.auditColSource}</th>
                <th scope="col">{t.auditColDetail}</th>
              </tr>
            </thead>
            <tbody>
              {(data ?? []).map((r) => (
                <tr key={r.id}>
                  <td className="tabular nowrap">{formatDateTime(lang, r.created_at)}</td>
                  <td>
                    {label(t, auditEventLabelKey(r.action), r.action)}
                    {isCriticalAuditEvent(r.action) ? (
                      <span className="lock" title={t.auditCritical}>
                        {' '}
                        🔒
                      </span>
                    ) : null}
                  </td>
                  <td>
                    {r.actor_role ?? '—'}
                    {r.actor_id ? (
                      <span className="muted mono"> #{r.actor_id.slice(0, 8)}</span>
                    ) : null}
                  </td>
                  <td className="mono">{[r.entity, r.entity_id].filter(Boolean).join(' ')}</td>
                  <td>{r.source === 'db' ? t.auditSourceDb : t.auditSourceApp}</td>
                  <td className="mono detail">
                    {Object.entries(r.detail ?? {})
                      .map(([k, v]) => `${k}=${String(v)}`)
                      .join(' · ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {exportError ? <Notice kind="error">{errorText(exportError, t)}</Notice> : null}
      <div className="actions">
        {data && data.length >= PAGE * pages ? (
          <AsyncButton variant="secondary" onClick={() => setPages((p) => p + 1)}>
            {t.auditLoadMore}
          </AsyncButton>
        ) : null}
        <AsyncButton onClick={exportCsv}>{t.auditExport}</AsyncButton>
      </div>
      <p className="muted hint">{t.auditExportNote}</p>
    </section>
  );
}

// ── settings: master switch + a tick per event type ─────────────────────────
function AuditSettingsPanel({ ctx, canEdit }: { ctx: PageContext; canEdit: boolean }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<AuditSettings | null>(null);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [saved, setSaved] = useState(false);

  const { status, data, reload } = useRemote(async () => {
    const { data: row, error: err } = await ctx.client
      .from('audit_settings')
      .select('enabled, disabled_events')
      .eq('org_id', ctx.orgId)
      .maybeSingle();
    if (err) throw new Error(err.code ?? 'query');
    return row
      ? { enabled: row.enabled !== false, disabledEvents: normalizeDisabled(row.disabled_events) }
      : DEFAULT_AUDIT_SETTINGS;
  }, ctx.orgId);

  if (status === 'loading')
    return (
      <p className="sso-working" role="status">
        <Spinner /> {t.loading}
      </p>
    );
  if (status === 'error' || !data) {
    return (
      <>
        <Notice kind="error">{t.err_load_failed}</Notice>
        <AsyncButton variant="secondary" onClick={reload}>
          {t.retry}
        </AsyncButton>
      </>
    );
  }
  const settings: AuditSettings = draft ?? data;
  const edit = (next: AuditSettings) => {
    setDraft(next);
    setSaved(false);
  };

  const save = async () => {
    setError(null);
    setSaved(false);
    const { error: err } = await ctx.client.rpc('set_audit_settings', {
      p_org: ctx.orgId,
      p_enabled: settings.enabled,
      p_disabled: [...settings.disabledEvents],
    });
    if (err) return setError(err.code === '42501' ? 'err_forbidden' : 'err_save_failed');
    setSaved(true);
    setDraft(null);
    reload();
  };

  return (
    <section className="card admin-card">
      {!canEdit ? <Notice kind="info">{t.auditReadOnly}</Notice> : null}
      <label className="switch-row">
        <input
          type="checkbox"
          role="switch"
          checked={settings.enabled}
          disabled={!canEdit}
          onChange={(e) => edit({ ...settings, enabled: e.target.checked })}
        />
        <span className="switch-text">{t.auditMaster}</span>
      </label>
      {!settings.enabled ? <Notice kind="info">{t.auditMasterOff}</Notice> : null}

      {AUDIT_GROUPS.map((g) => {
        const events = eventsInGroup(g);
        const ordinary = events.filter((e) => !e.critical);
        const allOn = ordinary.every((e) => !settings.disabledEvents.includes(e.id));
        return (
          <fieldset key={g} className="audit-group">
            <legend>{label(t, auditGroupLabelKey(g), g)}</legend>
            {ordinary.length > 0 ? (
              <button
                type="button"
                className="link-button"
                disabled={!canEdit}
                onClick={() => edit(setGroupRecorded(settings, g, !allOn))}
              >
                {t.auditTickGroup}
              </button>
            ) : null}
            {events.map((e) => {
              const critical = e.critical;
              return (
                <label key={e.id} className="check-row">
                  <input
                    type="checkbox"
                    checked={
                      critical
                        ? true
                        : shouldRecord(
                            { enabled: true, disabledEvents: settings.disabledEvents },
                            e.id,
                          )
                    }
                    disabled={!canEdit || critical}
                    onChange={(ev) => edit(setEventRecorded(settings, e.id, ev.target.checked))}
                  />
                  <span>{label(t, auditEventLabelKey(e.id), e.id)}</span>
                  {critical ? <span className="badge">🔒 {t.auditCritical}</span> : null}
                </label>
              );
            })}
          </fieldset>
        );
      })}

      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      {saved ? <Notice kind="success">{t.auditSaved}</Notice> : null}
      {canEdit ? <AsyncButton onClick={save}>{t.auditSave}</AsyncButton> : null}
      <p className="muted hint">
        {AUDIT_EVENTS.length} · {t.auditCritical}: {AUDIT_EVENTS.filter((e) => e.critical).length}
      </p>
    </section>
  );
}
