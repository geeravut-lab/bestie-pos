import { useState } from 'react';
import { parseWeeklyOffs, weeklyOffPayload } from '@bestie/core';
import type { Resource } from '@bestie/core';
import { errorText, fmt, useI18n } from '@bestie/i18n';
import type { Dict, ErrorKey } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useRemote } from './useRemote';

const tx = (t: Dict, key: string): string => (t as Record<string, string>)[key] ?? key;

/** Days off that repeat every week (every Monday, lunch every day…): the one rule that decides if a time is free refuses them by itself. */
export function WeeklyOffPanel({
  ctx,
  storeId,
  resources,
  canEdit,
}: {
  ctx: PageContext;
  storeId: string;
  resources: readonly Resource[];
  canEdit: boolean;
}) {
  const { t } = useI18n();
  const [who, setWho] = useState('');
  const [days, setDays] = useState<number[]>([]);
  const [allDay, setAllDay] = useState(true);
  const [timeFrom, setTimeFrom] = useState('12:00');
  const [timeTo, setTimeTo] = useState('13:00');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState<'bad' | 'saved' | 'clash' | null>(null);
  const [error, setError] = useState<ErrorKey | null>(null);
  const rows = useRemote(async () => {
    const r = await ctx.client
      .from('resource_weekly_offs')
      .select('id, resource_id, weekday, from_time, to_time, reason')
      .eq('store_id', storeId)
      .order('weekday');
    if (r.error) throw new Error('load');
    return parseWeeklyOffs(r.data);
  }, storeId);
  const chosen = who || resources[0]?.id || '';
  const name = (id: string) => resources.find((x) => x.id === id)?.name ?? '';

  const save = async () => {
    setError(null);
    setNote(null);
    const p = weeklyOffPayload({
      storeId,
      resourceId: chosen,
      weekdays: days,
      allDay,
      timeFrom,
      timeTo,
      reason,
    });
    if (!p) return setNote('bad');
    const { error: err } = await ctx.client.rpc('save_weekly_off', { p });
    if (err) {
      if (err.code === '23P01') return setNote('clash');
      if (err.code === '22023') return setNote('bad');
      return setError(err.code === '42501' ? 'err_forbidden' : 'err_save_failed');
    }
    setNote('saved');
    setDays([]);
    setReason('');
    rows.reload();
  };
  const remove = async (id: string) => {
    setError(null);
    const { error: err } = await ctx.client.rpc('delete_weekly_off', { p_id: id });
    if (err) return setError(err.code === '42501' ? 'err_forbidden' : 'err_save_failed');
    rows.reload();
  };

  return (
    <section className="card admin-card" aria-label={t.wkTitle}>
      <h2>{t.wkTitle}</h2>
      <p className="muted">{t.wkIntro}</p>
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      {note === 'bad' ? <Notice kind="error">{t.wkBad}</Notice> : null}
      {note === 'clash' ? <Notice kind="error">{t.wkClash}</Notice> : null}
      {note === 'saved' ? <Notice kind="success">{t.wkSaved}</Notice> : null}
      {canEdit ? (
        <form className="auth-form" onSubmit={(e) => e.preventDefault()}>
          <div className="form-row">
            <label className="label" htmlFor="wk-who">
              {t.daysOffWho}
            </label>
            <select
              id="wk-who"
              className="field"
              value={chosen}
              onChange={(e) => setWho(e.target.value)}
            >
              {resources.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>
          <fieldset className="form-row">
            <legend className="label">{t.wkDays}</legend>
            <div className="chips">
              {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                <button
                  key={d}
                  type="button"
                  className="chip"
                  aria-pressed={days.includes(d)}
                  onClick={() =>
                    setDays(days.includes(d) ? days.filter((x) => x !== d) : [...days, d])
                  }
                >
                  {tx(t, `wkDay_${d}`)}
                </button>
              ))}
            </div>
          </fieldset>
          <label className="check">
            <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />{' '}
            {t.wkAllDay}
          </label>
          {!allDay ? (
            <div className="form-row">
              <label className="label" htmlFor="wk-from">
                {t.wkFromTime}
              </label>
              <input
                id="wk-from"
                className="field"
                type="time"
                value={timeFrom}
                onChange={(e) => setTimeFrom(e.target.value)}
              />
              <label className="label" htmlFor="wk-to">
                {t.wkToTime}
              </label>
              <input
                id="wk-to"
                className="field"
                type="time"
                value={timeTo}
                onChange={(e) => setTimeTo(e.target.value)}
              />
            </div>
          ) : null}
          <div className="form-row">
            <label className="label" htmlFor="wk-reason">
              {t.daysOffReason}
            </label>
            <input
              id="wk-reason"
              className="field"
              maxLength={100}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <div className="actions">
            <AsyncButton type="submit" disabled={!chosen} onClick={save}>
              {t.wkSave}
            </AsyncButton>
          </div>
        </form>
      ) : null}
      <h3>{t.wkList}</h3>
      {rows.data && rows.data.length === 0 ? <p className="muted">{t.wkNone}</p> : null}
      <ul className="member-list">
        {(rows.data ?? []).map((w) => (
          <li key={w.id} className="member-row">
            <div className="member-head">
              <strong>{name(w.resourceId)}</strong>
              <span className="muted">
                {fmt(t.wkEvery, { day: tx(t, `wkDay_${w.weekday}`) })} ·{' '}
                {w.to ? `${w.from}–${w.to}` : t.wkAllDay}
              </span>
              {w.reason ? <span className="badge">{w.reason}</span> : null}
            </div>
            {canEdit ? (
              <AsyncButton variant="secondary" onClick={() => remove(w.id)}>
                {t.wkRemove}
              </AsyncButton>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
