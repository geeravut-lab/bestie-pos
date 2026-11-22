import { useState } from 'react';
import {
  bangkokDate,
  minutesToAnswer,
  parseCaseKpi,
  parseCases,
  splitDuration,
} from '@bestie/core';
import type { ServiceCase } from '@bestie/core';
import { fmt, formatDateTime, useI18n } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice, useLiveSync } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useRemote } from './useRemote';

const addDays = (d: string, n: number): string => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

/** Service recovery: complaints as cases with an owner, an answer time and a result (take / close: `order.create`; hand over / reopen: `report.view`). */
export function CasesPage({ ctx }: { ctx: PageContext }) {
  const { t, lang } = useI18n();
  const storeId = ctx.storeId ?? ctx.homeStoreId ?? null;
  const canWork = ctx.isOwner || ctx.permissions.includes('order.create');
  const canManage = ctx.isOwner || ctx.permissions.includes('report.view');
  const [msg, setMsg] = useState<string | null>(null);
  const [closing, setClosing] = useState<{ id: string; note: string; confirmed: boolean } | null>(
    null,
  );
  const [fresh, setFresh] = useState<{ summary: string; sla: string } | null>(null);
  const [now] = useState(() => Date.now());

  const data = useRemote(async () => {
    if (!storeId) throw new Error('no store');
    const to = bangkokDate(Date.now());
    const [cases, staff, kpi] = await Promise.all([
      ctx.client
        .from('service_cases')
        .select('*')
        .eq('store_id', storeId)
        .order('created_at', { ascending: false })
        .limit(80),
      ctx.client
        .from('staff')
        .select('id, display_name')
        .eq('org_id', ctx.orgId)
        .eq('active', true),
      ctx.client.rpc('case_kpi', { p: { store_id: storeId, from: addDays(to, -29), to } }),
    ]);
    if (cases.error) throw new Error('load');
    return {
      cases: parseCases(cases.data),
      staff: (staff.data ?? []) as { id: string; display_name: string }[],
      kpi: kpi.error ? null : parseCaseKpi(kpi.data),
    };
  }, `${storeId}`);
  const { reload } = data;
  useLiveSync(ctx.client, storeId ? [`store:${storeId}`] : [], reload);
  const d = data.data;
  const dur = (sec: number | null): string => {
    if (sec === null) return '—';
    const x = splitDuration(sec);
    return x.h > 0
      ? fmt(t.csHour, { h: x.h, m: x.m })
      : x.m > 0
        ? fmt(t.csMin, { m: x.m })
        : fmt(t.csSec, { s: x.s });
  };
  const run = async (fn: string, args: Record<string, unknown>) => {
    setMsg(null);
    const r = await ctx.client.rpc(fn, args);
    if (r.error) return setMsg(r.error.code === '42501' ? t.err_forbidden : t.err_save_failed);
    reload();
  };
  const nameOf = (id: string | null) =>
    d?.staff.find((s) => s.id === id)?.display_name ?? t.csNobody;
  const open = (d?.cases ?? []).filter((c) => c.status !== 'resolved');
  const done = (d?.cases ?? []).filter((c) => c.status === 'resolved').slice(0, 10);

  const row = (c: ServiceCase) => {
    const left = minutesToAnswer(c, now);
    return (
      <li key={c.id} className="card admin-card">
        <p>
          <strong>{c.summary}</strong>{' '}
          <span className="badge">
            {c.source === 'feedback' ? t.csSourceFeedback : t.csSourceManual}
          </span>
        </p>
        <p className="muted">
          {formatDateTime(lang, c.createdAt)} · {nameOf(c.assignee)}
          {left !== null
            ? ` · ${left >= 0 ? fmt(t.csLeft, { m: left }) : fmt(t.csLate, { m: -left })}`
            : c.status !== 'resolved'
              ? ` · ${t.csAnswered}`
              : ''}
        </p>
        {c.resolution ? (
          <p>
            {c.resolution}
            {c.confirmed ? ` · ${t.csConfirmed}` : ''}
          </p>
        ) : null}
        <div className="actions">
          {canWork && c.status === 'open' ? (
            <AsyncButton variant="secondary" onClick={() => run('case_ack', { p_id: c.id })}>
              {t.csAck}
            </AsyncButton>
          ) : null}
          {canWork && c.status !== 'resolved' ? (
            <AsyncButton
              variant="secondary"
              onClick={async () => setClosing({ id: c.id, note: '', confirmed: false })}
            >
              {t.csResolve}
            </AsyncButton>
          ) : null}
          {canManage && c.status !== 'resolved' ? (
            <select
              aria-label={t.csAssign}
              className="field"
              value={c.assignee ?? ''}
              onChange={(e) =>
                e.target.value && void run('case_assign', { p_id: c.id, p_staff: e.target.value })
              }
            >
              <option value="">{t.csAssign}…</option>
              {(d?.staff ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.display_name}
                </option>
              ))}
            </select>
          ) : null}
          {canManage && c.status === 'resolved' ? (
            <AsyncButton variant="secondary" onClick={() => run('case_reopen', { p_id: c.id })}>
              {t.csReopen}
            </AsyncButton>
          ) : null}
        </div>
        {closing?.id === c.id ? (
          <form className="auth-form" onSubmit={(e) => e.preventDefault()} aria-label={t.csResolve}>
            <div className="form-row">
              <label className="label" htmlFor="cs-note">
                {t.csResolution}
              </label>
              <input
                id="cs-note"
                className="field"
                maxLength={300}
                value={closing.note}
                onChange={(e) => setClosing({ ...closing, note: e.target.value })}
              />
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={closing.confirmed}
                onChange={(e) => setClosing({ ...closing, confirmed: e.target.checked })}
              />{' '}
              {t.csConfirmed}
            </label>
            <div className="actions">
              <AsyncButton
                type="submit"
                onClick={async () => {
                  await run('case_resolve', {
                    p_id: closing.id,
                    p_note: closing.note,
                    p_confirmed: closing.confirmed,
                  });
                  setClosing(null);
                }}
              >
                {t.csResolve}
              </AsyncButton>
            </div>
          </form>
        ) : null}
      </li>
    );
  };
  return (
    <div className="admin-page">
      <h1>{t.csTitle}</h1>
      <Notice kind="info">{t.csIntro}</Notice>
      {msg ? <Notice kind="error">{msg}</Notice> : null}
      {data.status === 'loading' ? (
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      ) : null}
      {d?.kpi && d.kpi.cases > 0 ? (
        <p className="muted">
          {t.csKpi}: {fmt(t.csKpiCases, { n: d.kpi.cases })} ·{' '}
          {fmt(t.csKpiFirst, { t: dur(d.kpi.avgFirstResponseSec) })} ·{' '}
          {fmt(t.csKpiResolve, { t: dur(d.kpi.avgResolutionSec) })} ·{' '}
          {fmt(t.csKpiLate, { n: d.kpi.late })}
        </p>
      ) : null}
      {d && open.length === 0 ? <p className="muted">{t.csNone}</p> : null}
      <ul className="member-list">{open.map(row)}</ul>
      {canWork ? (
        fresh ? (
          <form
            className="card admin-card auth-form"
            onSubmit={(e) => e.preventDefault()}
            aria-label={t.csOpenNew}
          >
            <div className="form-row">
              <label className="label" htmlFor="cs-sum">
                {t.csSummary}
              </label>
              <input
                id="cs-sum"
                className="field"
                maxLength={200}
                value={fresh.summary}
                onChange={(e) => setFresh({ ...fresh, summary: e.target.value })}
              />
            </div>
            <div className="form-row">
              <label className="label" htmlFor="cs-sla">
                {t.csSla}
              </label>
              <input
                id="cs-sla"
                className="field"
                inputMode="numeric"
                value={fresh.sla}
                onChange={(e) => setFresh({ ...fresh, sla: e.target.value.replace(/\D/g, '') })}
              />
            </div>
            <div className="actions">
              <AsyncButton
                type="submit"
                onClick={async () => {
                  if (!fresh.summary.trim()) return;
                  await run('open_case', {
                    p: {
                      store_id: storeId,
                      summary: fresh.summary.trim(),
                      sla_min: Number(fresh.sla) || 15,
                    },
                  });
                  setFresh(null);
                }}
              >
                {t.csOpenNew}
              </AsyncButton>
            </div>
          </form>
        ) : (
          <div className="actions">
            <AsyncButton
              variant="secondary"
              onClick={async () => setFresh({ summary: '', sla: '15' })}
            >
              {t.csOpenNew}
            </AsyncButton>
          </div>
        )
      ) : null}
      {done.length > 0 ? (
        <>
          <h2>{t.csHistory}</h2>
          <ul className="member-list">{done.map(row)}</ul>
        </>
      ) : null}
    </div>
  );
}
