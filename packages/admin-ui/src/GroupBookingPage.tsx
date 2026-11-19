import { useState } from 'react';
import { groupPayload, parseResources, PROVIDER_KINDS } from '@bestie/core';
import type { GroupPartInput, Resource } from '@bestie/core';
import { errorText, fmt, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useRemote } from './useRemote';

type Service = { id: string; name: string };
const todayBangkok = (): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
const emptyPart = (): GroupPartInput => ({ serviceId: '', providerId: '', guestName: '' });

/** Book a couple or a party in one go: every person with their own service and stylist at the same start time, all or nothing. */
export function GroupBookingPage({ ctx }: { ctx: PageContext }) {
  const { t, lang } = useI18n();
  const storeId = ctx.storeId ?? ctx.homeStoreId ?? null;
  const [date, setDate] = useState(todayBangkok);
  const [time, setTime] = useState('14:00');
  const [guest, setGuest] = useState('');
  const [phone, setPhone] = useState('');
  const [parts, setParts] = useState<GroupPartInput[]>([emptyPart(), emptyPart()]);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [bad, setBad] = useState(false);
  const [done, setDone] = useState<number | null>(null);

  const providers = useRemote<Resource[]>(
    async () => {
      if (!storeId) return [];
      const r = await ctx.client
        .from('resources')
        .select('id, name, kind, active, sort, staff_id')
        .eq('store_id', storeId)
        .is('deleted_at', null)
        .order('sort');
      if (r.error) throw new Error('load');
      return parseResources(r.data).filter(
        (x) => x.active && (PROVIDER_KINDS as readonly string[]).includes(x.kind),
      );
    },
    `prov:${storeId ?? ''}`,
  );
  const services = useRemote<Service[]>(
    async () => {
      if (!storeId) return [];
      const r = await ctx.client
        .from('menu_items')
        .select('id, name, duration_min')
        .eq('store_id', storeId)
        .is('deleted_at', null)
        .not('duration_min', 'is', null);
      if (r.error) throw new Error('load');
      return ((r.data ?? []) as { id: string; name: { th: string; en?: string } }[]).map((x) => ({
        id: x.id,
        name: lang === 'en' && x.name.en ? x.name.en : x.name.th,
      }));
    },
    `svc:${storeId ?? ''}:${lang}`,
  );

  const set = (i: number, patch: Partial<GroupPartInput>) =>
    setParts(parts.map((p, k) => (k === i ? { ...p, ...patch } : p)));

  const submit = async () => {
    setError(null);
    setBad(false);
    setDone(null);
    const body = storeId
      ? groupPayload({ storeId, date, time, guestName: guest, guestPhone: phone, parts })
      : null;
    if (!body) return setBad(true);
    const { data, error: err } = await ctx.client.rpc('book_group', { p: body });
    if (err)
      return setError(
        err.code === '42501'
          ? 'err_forbidden'
          : err.code === '23P01'
            ? 'err_group_clash'
            : 'err_save_failed',
      );
    setDone(((data as { ids?: unknown[] } | null)?.ids ?? []).length);
    setParts([emptyPart(), emptyPart()]);
  };

  return (
    <div className="admin-page">
      <h1>{t.groupTitle}</h1>
      <Notice kind="info">{t.groupIntro}</Notice>
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      {bad ? <Notice kind="error">{t.groupBad}</Notice> : null}
      {done !== null ? (
        <Notice kind="success">
          {fmt(t.groupDone, { n: done })}{' '}
          <button type="button" className="link-button" onClick={() => ctx.navigate('/calendar')}>
            {t.groupOpenCalendar}
          </button>
        </Notice>
      ) : null}
      {providers.status === 'loading' ? (
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      ) : null}
      <section className="card admin-card">
        <div className="form-row">
          <label className="label" htmlFor="grp-guest">
            {t.groupGuest}
          </label>
          <input
            id="grp-guest"
            className="field"
            maxLength={80}
            value={guest}
            onChange={(e) => setGuest(e.target.value)}
          />
          <label className="label" htmlFor="grp-phone">
            {t.groupPhone}
          </label>
          <input
            id="grp-phone"
            className="field"
            inputMode="tel"
            maxLength={30}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </div>
        <div className="form-row">
          <label className="label" htmlFor="grp-date">
            {t.groupDate}
          </label>
          <input
            id="grp-date"
            className="field"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <label className="label" htmlFor="grp-time">
            {t.groupTime}
          </label>
          <input
            id="grp-time"
            className="field"
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
          />
        </div>
        {parts.map((p, i) => (
          <fieldset key={i} className="form-row">
            <legend className="label">{fmt(t.groupPart, { n: i + 1 })}</legend>
            <label className="label" htmlFor={`grp-svc-${i}`}>
              {t.groupService}
            </label>
            <select
              id={`grp-svc-${i}`}
              className="field"
              value={p.serviceId}
              onChange={(e) => set(i, { serviceId: e.target.value })}
            >
              <option value="" />
              {(services.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <label className="label" htmlFor={`grp-prov-${i}`}>
              {t.groupProvider}
            </label>
            <select
              id={`grp-prov-${i}`}
              className="field"
              value={p.providerId}
              onChange={(e) => set(i, { providerId: e.target.value })}
            >
              <option value="" />
              {(providers.data ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <label className="label" htmlFor={`grp-name-${i}`}>
              {t.groupPartGuest}
            </label>
            <input
              id={`grp-name-${i}`}
              className="field"
              maxLength={80}
              value={p.guestName}
              onChange={(e) => set(i, { guestName: e.target.value })}
            />
            {parts.length > 2 ? (
              <AsyncButton
                variant="secondary"
                onClick={() => setParts(parts.filter((_, k) => k !== i))}
              >
                {t.groupRemovePart}
              </AsyncButton>
            ) : null}
          </fieldset>
        ))}
        <div className="actions">
          {parts.length < 8 ? (
            <AsyncButton variant="secondary" onClick={() => setParts([...parts, emptyPart()])}>
              {t.groupAddPart}
            </AsyncButton>
          ) : null}
          <AsyncButton onClick={submit}>{t.groupSubmit}</AsyncButton>
        </div>
      </section>
    </div>
  );
}
