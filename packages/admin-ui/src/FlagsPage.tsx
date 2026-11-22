import { useState } from 'react';
import { MODULES } from '@bestie/core';
import { fmt, formatDateTime, useI18n } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice, useLiveSync } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useRemote } from './useRemote';

type Row = {
  moduleId: string;
  onCount: number;
  offCount: number;
  killed: boolean;
  reason: string | null;
  changedAt: string | null;
};
const obj = (x: unknown): Record<string, unknown> =>
  x && typeof x === 'object' ? (x as Record<string, unknown>) : {};

/**
 * The platform kill switch (feature flags are data): the platform administrator switches a module OFF for every business at once — for a bug, a provider
 * outage or a legal question. Stored as "only what is off". The screens treat a killed module as switched off everywhere, and the database refuses it
 * wherever the module has a database check (the page says which ones do not).
 */
export function FlagsPage({ ctx }: { ctx: PageContext }) {
  const { t, lang } = useI18n();
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const data = useRemote(async () => {
    if (!ctx.isPlatformAdmin) return null;
    const [ov, enforced] = await Promise.all([
      ctx.client.rpc('platform_flags_overview'),
      ctx.client.from('platform_flag_enforced').select('module_id'),
    ]);
    if (ov.error) throw new Error('load');
    const o = obj(ov.data);
    const rows = new Map<string, Row>();
    for (const x of Array.isArray(o.modules) ? o.modules : []) {
      const r = obj(x);
      rows.set(String(r.module_id), {
        moduleId: String(r.module_id),
        onCount: Number(r.on_count) || 0,
        offCount: Number(r.off_count) || 0,
        killed: r.killed === true,
        reason: typeof r.reason === 'string' ? r.reason : null,
        changedAt: typeof r.changed_at === 'string' ? r.changed_at : null,
      });
    }
    for (const x of Array.isArray(o.killed) ? o.killed : []) {
      const r = obj(x);
      const id = String(r.module_id);
      rows.set(id, {
        ...(rows.get(id) ?? { moduleId: id, onCount: 0, offCount: 0 }),
        killed: true,
        reason: typeof r.reason === 'string' ? r.reason : null,
        changedAt: typeof r.changed_at === 'string' ? r.changed_at : null,
      });
    }
    return {
      shops: Number(o.shops) || 0,
      rows,
      enforced: new Set(((enforced.data ?? []) as { module_id: string }[]).map((e) => e.module_id)),
    };
  }, `${ctx.isPlatformAdmin}`);
  const { reload } = data;
  useLiveSync(ctx.client, ['platform'], reload);
  if (!ctx.isPlatformAdmin)
    return (
      <div className="admin-page">
        <Notice kind="error">{t.brandAdminOnly}</Notice>
      </div>
    );
  const d = data.data;
  const set = async (moduleId: string, enabled: boolean) => {
    setMsg(null);
    const r = await ctx.client.rpc('set_platform_flag', {
      p: { module_id: moduleId, enabled, reason: reasons[moduleId] ?? null },
    });
    if (r.error) return setMsg({ kind: 'error', text: t.flErr });
    setMsg({ kind: 'success', text: enabled ? t.flBackOn : t.flSwitchedOff });
    setReasons((x) => ({ ...x, [moduleId]: '' }));
    reload();
  };
  const label = (id: string) => (t as Record<string, string>)[`mod_${id}`] ?? id;
  const killedCount = d ? [...d.rows.values()].filter((r) => r.killed).length : 0;

  return (
    <div className="admin-page">
      <h1>{t.flTitle}</h1>
      <Notice kind="info">{t.flIntro}</Notice>
      {killedCount > 0 ? (
        <Notice kind="error">{fmt(t.flKilledNow, { n: killedCount })}</Notice>
      ) : null}
      {msg ? <Notice kind={msg.kind}>{msg.text}</Notice> : null}
      {data.status === 'loading' ? (
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      ) : null}
      {data.status === 'error' ? <Notice kind="error">{t.err_load_failed}</Notice> : null}
      {d ? <p className="muted">{fmt(t.flShops, { n: d.shops })}</p> : null}
      <ul className="member-list">
        {MODULES.map((m) => {
          const r = d?.rows.get(m.id);
          const killed = r?.killed === true;
          return (
            <li key={m.id} className="card admin-card">
              <strong>{label(m.id)}</strong> <code>{m.id}</code>{' '}
              <span className="badge">{m.plan}</span>{' '}
              {killed ? <span className="badge">{t.flOffBadge}</span> : null}
              <p className="muted">
                {fmt(t.flAdoption, { on: r?.onCount ?? 0, off: r?.offCount ?? 0 })}
                {m.defaultProfiles.length > 0
                  ? ` · ${t.flDefaultFor}: ${m.defaultProfiles.join(', ')}`
                  : ''}
              </p>
              {killed ? (
                <>
                  <p>
                    {r?.reason ? `${r.reason} · ` : ''}
                    {r?.changedAt ? formatDateTime(lang, r.changedAt) : ''}
                  </p>
                  {d && !d.enforced.has(m.id) ? <p className="muted">{t.flScreensOnly}</p> : null}
                  <AsyncButton onClick={() => set(m.id, true)}>{t.flSwitchOn}</AsyncButton>
                </>
              ) : (
                <div className="form-inline">
                  <input
                    aria-label={`${t.flReason} ${m.id}`}
                    placeholder={t.flReason}
                    maxLength={200}
                    value={reasons[m.id] ?? ''}
                    onChange={(e) => setReasons((x) => ({ ...x, [m.id]: e.target.value }))}
                  />
                  <AsyncButton variant="secondary" onClick={() => set(m.id, false)}>
                    {t.flSwitchOff}
                  </AsyncButton>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
