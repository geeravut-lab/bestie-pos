import { useState } from 'react';
import { blockRange, parseResources } from '@bestie/core';
import type { Resource } from '@bestie/core';
import { errorText, formatDateTime, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { WeeklyOffPanel } from './WeeklyOffPanel';
import { useRemote } from './useRemote';

type Block = { id: string; resourceId: string; startsAt: string; endsAt: string; reason: string };
const todayBangkok = (): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());

/** Days off and breaks: times when a stylist, room or bed cannot be booked. */
export function DaysOffPage({ ctx }: { ctx: PageContext }) {
  const { t, lang } = useI18n();
  const storeId = ctx.storeId ?? ctx.homeStoreId ?? null;
  const canEdit = ctx.isOwner || ctx.permissions.includes('menu.edit');
  const [who, setWho] = useState('');
  const [fromDate, setFromDate] = useState(todayBangkok);
  const [toDate, setToDate] = useState(todayBangkok);
  const [hours, setHours] = useState(false);
  const [timeFrom, setTimeFrom] = useState('12:00');
  const [timeTo, setTimeTo] = useState('13:00');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<ErrorKey | null>(null);
  const [note, setNote] = useState<'bad' | 'saved' | null>(null);

  const resources = useRemote<Resource[]>(async () => {
    if (!storeId) return [];
    const r = await ctx.client
      .from('resources')
      .select('id, name, kind, active, sort, staff_id')
      .eq('store_id', storeId)
      .is('deleted_at', null)
      .order('sort');
    if (r.error) throw new Error('load');
    return parseResources(r.data).filter((x) => x.active);
  }, storeId ?? '');
  const blocks = useRemote<Block[]>(
    async () => {
      if (!storeId) return [];
      const r = await ctx.client
        .from('resource_blocks')
        .select('id, resource_id, starts_at, ends_at, reason')
        .eq('store_id', storeId)
        .order('starts_at');
      if (r.error) throw new Error('load');
      const now = Date.now();
      return ((r.data ?? []) as Record<string, string | null>[])
        .map((b) => ({
          id: String(b.id),
          resourceId: String(b.resource_id),
          startsAt: String(b.starts_at),
          endsAt: String(b.ends_at),
          reason: b.reason ?? '',
        }))
        .filter((b) => Date.parse(b.endsAt) > now);
    },
    `blocks:${storeId ?? ''}`,
  );
  const name = (id: string) => resources.data?.find((x) => x.id === id)?.name ?? '';
  const chosen = who || resources.data?.[0]?.id || '';

  const save = async () => {
    setError(null);
    setNote(null);
    const range = blockRange({ fromDate, toDate, allDay: !hours, timeFrom, timeTo });
    if (!range || !storeId || !chosen) return setNote('bad');
    const { error: err } = await ctx.client.rpc('save_resource_block', {
      p: {
        store_id: storeId,
        resource_id: chosen,
        starts_at: range.startsAt,
        ends_at: range.endsAt,
        reason: reason.trim() || null,
      },
    });
    if (err)
      return setError(
        err.code === '42501'
          ? 'err_forbidden'
          : err.code === '23P01'
            ? 'err_dayoff_clash'
            : 'err_save_failed',
      );
    setReason('');
    setNote('saved');
    blocks.reload();
  };
  const remove = async (id: string) => {
    setError(null);
    setNote(null);
    const { error: err } = await ctx.client.rpc('delete_resource_block', { p_id: id });
    if (err) return setError(err.code === '42501' ? 'err_forbidden' : 'err_save_failed');
    blocks.reload();
  };

  return (
    <div className="admin-page">
      <h1>{t.daysOffTitle}</h1>
      <Notice kind="info">{t.daysOffIntro}</Notice>
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      {note === 'bad' ? <Notice kind="error">{t.daysOffBad}</Notice> : null}
      {note === 'saved' ? <Notice kind="success">{t.daysOffSaved}</Notice> : null}
      {resources.status === 'loading' ? (
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      ) : null}
      {canEdit ? (
        <section className="card admin-card">
          <div className="form-row">
            <label className="label" htmlFor="off-who">
              {t.daysOffWho}
            </label>
            <select
              id="off-who"
              className="field"
              value={chosen}
              onChange={(e) => setWho(e.target.value)}
            >
              {(resources.data ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <label className="label" htmlFor="off-from">
              {t.daysOffFrom}
            </label>
            <input
              id="off-from"
              className="field"
              type="date"
              value={fromDate}
              onChange={(e) => {
                setFromDate(e.target.value);
                if (toDate < e.target.value) setToDate(e.target.value);
              }}
            />
            <label className="label" htmlFor="off-to">
              {t.daysOffTo}
            </label>
            <input
              id="off-to"
              className="field"
              type="date"
              value={toDate}
              min={fromDate}
              onChange={(e) => setToDate(e.target.value)}
            />
          </div>
          <div className="form-row">
            <label className="check">
              <input type="checkbox" checked={hours} onChange={(e) => setHours(e.target.checked)} />{' '}
              {t.daysOffHours}
            </label>
            {hours ? (
              <>
                <label className="label" htmlFor="off-tf">
                  {t.daysOffTimeFrom}
                </label>
                <input
                  id="off-tf"
                  className="field"
                  type="time"
                  value={timeFrom}
                  onChange={(e) => setTimeFrom(e.target.value)}
                />
                <label className="label" htmlFor="off-tt">
                  {t.daysOffTimeTo}
                </label>
                <input
                  id="off-tt"
                  className="field"
                  type="time"
                  value={timeTo}
                  onChange={(e) => setTimeTo(e.target.value)}
                />
              </>
            ) : null}
          </div>
          <div className="form-row">
            <label className="label" htmlFor="off-reason">
              {t.daysOffReason}
            </label>
            <input
              id="off-reason"
              className="field"
              maxLength={100}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <div className="actions">
            <AsyncButton onClick={save} disabled={!chosen}>
              {t.daysOffAdd}
            </AsyncButton>
          </div>
        </section>
      ) : null}
      {storeId && resources.data ? (
        <WeeklyOffPanel ctx={ctx} storeId={storeId} resources={resources.data} canEdit={canEdit} />
      ) : null}
      {blocks.data && blocks.data.length === 0 ? <p className="muted">{t.daysOffNone}</p> : null}
      <ul className="member-list">
        {(blocks.data ?? []).map((b) => (
          <li key={b.id} className="member-row">
            <div className="member-head">
              <strong>{name(b.resourceId)}</strong>
              <span className="muted">
                {formatDateTime(lang, b.startsAt)} → {formatDateTime(lang, b.endsAt)}
              </span>
              {b.reason ? <span className="badge">{b.reason}</span> : null}
            </div>
            {canEdit ? (
              <AsyncButton variant="secondary" onClick={() => remove(b.id)}>
                {t.daysOffRemove}
              </AsyncButton>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
