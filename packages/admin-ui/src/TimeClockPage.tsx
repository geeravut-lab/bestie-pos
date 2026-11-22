import { useState } from 'react';
import {
  bangkokDate,
  hoursMinutes,
  parseClockedIn,
  parseTimesheet,
  timesheetCsv,
} from '@bestie/core';
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

/** The staff time clock (module `timeclock`): the person working presses Clock in / out, managers see who is in, plan shifts and read the timesheet. */
export function TimeClockPage({ ctx }: { ctx: PageContext }) {
  const { t, lang } = useI18n();
  const storeId = ctx.storeId ?? ctx.homeStoreId ?? null;
  const canManage = ctx.isOwner || ctx.permissions.includes('staff.manage');
  const [today] = useState(() => bangkokDate(Date.now()));
  const [from, setFrom] = useState(addDays(today, -13));
  const [to, setTo] = useState(today);
  const [plan, setPlan] = useState({ staff: '', date: today, start: '09:00', end: '17:00' });
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  const data = useRemote(async () => {
    if (!storeId) throw new Error('no store');
    const [status, staff, sheet, planned] = await Promise.all([
      ctx.client.rpc('time_status', { p_store: storeId }),
      ctx.client.from('staff').select('id, display_name').eq('active', true).order('display_name'),
      canManage
        ? ctx.client.rpc('timesheet', { p: { store_id: storeId, from, to } })
        : Promise.resolve({ data: null, error: null }),
      ctx.client
        .from('staff_schedule')
        .select('id, staff_id, starts_at, ends_at')
        .eq('store_id', storeId)
        .gte('ends_at', new Date().toISOString())
        .order('starts_at')
        .limit(30),
    ]);
    if (status.error) throw new Error('load');
    return {
      inNow: parseClockedIn(status.data),
      staff: (staff.data ?? []) as { id: string; display_name: string }[],
      sheet: sheet.error || !sheet.data ? [] : parseTimesheet(sheet.data),
      planned: (planned.data ?? []) as {
        id: string;
        staff_id: string;
        starts_at: string;
        ends_at: string;
      }[],
    };
  }, `${storeId}:${from}:${to}`);
  const { reload } = data;
  useLiveSync(ctx.client, storeId ? [`store:${storeId}`] : [], reload);
  const d = data.data;
  const me = ctx.staffId ?? '';
  const iAmIn = !!d?.inNow.some((x) => x.staffId === me);
  const nameOf = (id: string) => d?.staff.find((s) => s.id === id)?.display_name ?? '—';

  const fail = (code?: string) =>
    setMsg({
      kind: 'error',
      text: code === '0A000' ? t.tcOff : code === '42501' ? t.err_forbidden : t.tcErr,
    });
  const toggle = async (staffId: string) => {
    setMsg(null);
    const r = await ctx.client.rpc('clock_toggle', { p: { store_id: storeId, staff_id: staffId } });
    if (r.error) return fail(r.error.code);
    const o = (r.data ?? {}) as { state?: string };
    setMsg({ kind: 'success', text: o.state === 'in' ? t.tcClockedIn : t.tcClockedOut });
    reload();
  };
  const addShift = async () => {
    setMsg(null);
    if (!plan.staff || !plan.date || plan.end <= plan.start)
      return setMsg({ kind: 'error', text: t.tcErr });
    const r = await ctx.client.rpc('save_planned_shift', {
      p: {
        store_id: storeId,
        staff_id: plan.staff,
        starts_at: `${plan.date}T${plan.start}:00+07:00`,
        ends_at: `${plan.date}T${plan.end}:00+07:00`,
      },
    });
    if (r.error) return fail(r.error.code);
    reload();
  };
  const removeShift = async (id: string) => {
    const r = await ctx.client.rpc('delete_planned_shift', { p_id: id });
    if (r.error) return fail(r.error.code);
    reload();
  };
  const download = async () => {
    const url = URL.createObjectURL(
      new Blob([timesheetCsv(d?.sheet ?? [])], { type: 'text/csv;charset=utf-8' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `timesheet-${from}-${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="admin-page">
      <h1>{t.tcTitle}</h1>
      <Notice kind="info">{t.tcIntro}</Notice>
      {msg ? <Notice kind={msg.kind}>{msg.text}</Notice> : null}
      {data.status === 'loading' ? (
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      ) : null}
      {data.status === 'error' ? <Notice kind="error">{t.err_load_failed}</Notice> : null}

      {me ? (
        <section className="card admin-card" aria-label={t.tcMine}>
          <h2>{t.tcMine}</h2>
          <p>{iAmIn ? t.tcYouAreIn : t.tcYouAreOut}</p>
          <AsyncButton onClick={() => toggle(me)}>{iAmIn ? t.tcClockOut : t.tcClockIn}</AsyncButton>
        </section>
      ) : null}

      <section className="card admin-card" aria-label={t.tcWhoIn}>
        <h2>{t.tcWhoIn}</h2>
        {d && d.inNow.length === 0 ? <p className="muted">{t.tcNobody}</p> : null}
        <ul className="member-list">
          {(d?.inNow ?? []).map((x) => (
            <li key={x.staffId}>
              <strong>{x.name}</strong>{' '}
              <span className="muted">
                {fmt(t.tcSince, { when: formatDateTime(lang, x.since) })}
              </span>
              {canManage && x.staffId !== me ? (
                <AsyncButton variant="secondary" onClick={() => toggle(x.staffId)}>
                  {t.tcClockOut}
                </AsyncButton>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      {canManage ? (
        <>
          <section className="card admin-card" aria-label={t.tcSchedule}>
            <h2>{t.tcSchedule}</h2>
            <ul className="member-list">
              {(d?.planned ?? []).map((p) => (
                <li key={p.id}>
                  <strong>{nameOf(p.staff_id)}</strong> {formatDateTime(lang, p.starts_at)} →{' '}
                  {formatDateTime(lang, p.ends_at)}
                  <AsyncButton variant="secondary" onClick={() => removeShift(p.id)}>
                    {t.tcRemove}
                  </AsyncButton>
                </li>
              ))}
            </ul>
            <div className="form-inline">
              <select
                aria-label={t.tcPerson}
                value={plan.staff}
                onChange={(e) => setPlan({ ...plan, staff: e.target.value })}
              >
                <option value="">{t.tcPerson}</option>
                {(d?.staff ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.display_name}
                  </option>
                ))}
              </select>
              <input
                aria-label={t.tcDate}
                type="date"
                value={plan.date}
                onChange={(e) => setPlan({ ...plan, date: e.target.value })}
              />
              <input
                aria-label={t.tcFrom}
                type="time"
                value={plan.start}
                onChange={(e) => setPlan({ ...plan, start: e.target.value })}
              />
              <input
                aria-label={t.tcTo}
                type="time"
                value={plan.end}
                onChange={(e) => setPlan({ ...plan, end: e.target.value })}
              />
              <AsyncButton onClick={addShift}>{t.tcAddShift}</AsyncButton>
            </div>
          </section>
          <section className="card admin-card" aria-label={t.tcSheet}>
            <h2>{t.tcSheet}</h2>
            <div className="form-inline">
              <input
                aria-label={t.tcFrom}
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
              <input
                aria-label={t.tcTo}
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
              <AsyncButton variant="secondary" onClick={download}>
                {t.tcDownload}
              </AsyncButton>
            </div>
            {d && d.sheet.length === 0 ? <p className="muted">{t.tcSheetNone}</p> : null}
            <div className="table-wrap">
              <table className="table">
                <tbody>
                  {(d?.sheet ?? []).map((r) => (
                    <tr key={r.staffId}>
                      <td>{r.name}</td>
                      <td className="tabular">{fmt(t.tcDays, { n: r.days })}</td>
                      <td className="tabular">
                        {fmt(t.tcWorked, { h: hoursMinutes(r.workedMin) })}
                      </td>
                      <td className="tabular">
                        {fmt(t.tcPlanned, { h: hoursMinutes(r.plannedMin) })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
