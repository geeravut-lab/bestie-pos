import { useState } from 'react';
import {
  addDays,
  bangkokDayBounds,
  bangkokParts,
  canMove,
  findConflict,
  formatTHB,
  layoutColumn,
  localizedName,
  nextStatuses,
  parseAppointments,
  parsePriceInput,
  parseResources,
  timeLabel,
  toBangkokIso,
  isProviderKind,
} from '@bestie/core';
import type { Appointment, AppointmentStatus, Resource } from '@bestie/core';
import { errorText, fmt, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { tx } from './stockInput';
import { useRemote } from './useRemote';

type Service = {
  id: string;
  name: { th: string; en?: string };
  price: number;
  duration: number | null;
};
type Loaded = { resources: Resource[]; appts: Appointment[]; services: Service[] };
type View = 'provider' | 'place';
type Draft = {
  serviceId: string; // '' = a service typed by hand
  serviceName: string;
  price: string;
  duration: string;
  time: string;
  providerId: string;
  placeId: string;
  guest: string;
  phone: string;
  note: string;
};

const ROW_PX = 36; // one 30-minute row
const today = (): string => bangkokParts(new Date().toISOString()).date;

/** The day calendar: one column per stylist / therapist (or per room / bed), bookings as blocks, new booking and status buttons. */
export function AppointmentsPage({ ctx }: { ctx: PageContext }) {
  const { t, lang } = useI18n();
  const locale = lang === 'th' ? ('th-TH' as const) : ('en-GB' as const);
  const storeId = ctx.storeId ?? ctx.homeStoreId ?? null;
  const canBook = ctx.isOwner || ctx.permissions.includes('order.create');
  const canManage = ctx.isOwner || ctx.permissions.includes('menu.edit');
  const [date, setDate] = useState(today);
  const [view, setView] = useState<View>('provider');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [moving, setMoving] = useState<{
    time: string;
    providerId: string;
    placeId: string;
  } | null>(null);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [problem, setProblem] = useState<'bad' | 'provider' | 'place' | 'off' | null>(null);

  const bounds = bangkokDayBounds(date);
  const data = useRemote<Loaded>(
    async () => {
      if (!storeId || !bounds) throw new Error('shop');
      const [res, ap, menu] = await Promise.all([
        ctx.client
          .from('resources')
          .select('id, name, kind, active, sort')
          .eq('store_id', storeId)
          .is('deleted_at', null)
          .order('sort'),
        ctx.client
          .from('appointments')
          .select(
            'id, provider_id, place_id, service_name, price, guest_name, guest_phone, starts_at, ends_at, status, source, note',
          )
          .eq('store_id', storeId)
          .gte('starts_at', bounds.from)
          .lt('starts_at', bounds.to)
          .order('starts_at'),
        ctx.client
          .from('menu_items')
          .select('id, name, prices, duration_min')
          .eq('store_id', storeId)
          .is('deleted_at', null)
          .order('sort'),
      ]);
      if (res.error || ap.error || menu.error) throw new Error('load');
      return {
        resources: parseResources(res.data),
        appts: parseAppointments(ap.data),
        services: ((menu.data ?? []) as Record<string, unknown>[]).flatMap((m) =>
          typeof m.id === 'string' && m.name && typeof m.name === 'object'
            ? [
                {
                  id: m.id,
                  name: m.name as Service['name'],
                  price: Number((m.prices as { base?: number } | null)?.base ?? 0),
                  duration: typeof m.duration_min === 'number' ? m.duration_min : null,
                },
              ]
            : [],
        ),
      };
    },
    `${storeId ?? ''}|${date}`,
  );

  if (!ctx.isModuleOn?.('appointments') && ctx.isModuleOn)
    return (
      <div className="admin-page">
        <h1>{t.calTitle}</h1>
        <Notice kind="info">{t.calModuleOff}</Notice>
      </div>
    );
  const d = data.data;
  const providers = (d?.resources ?? []).filter((r) => isProviderKind(r.kind));
  const places = (d?.resources ?? []).filter((r) => !isProviderKind(r.kind));
  const nameOf = (id: string | null) => d?.resources.find((r) => r.id === id)?.name ?? '—';

  const fail = (e: { code?: string; message?: string }) => {
    if (e.code === '23P01') setProblem(/provider/i.test(e.message ?? '') ? 'provider' : 'place');
    else if (e.code === '0A000') setProblem('off');
    else setError(e.code === '42501' ? 'err_forbidden' : 'err_save_failed');
  };
  const reload = () => {
    setError(null);
    setProblem(null);
    data.reload();
  };

  // ── the grid ──
  const all = d?.appts ?? [];
  const mins = all.flatMap((a) => {
    const s = bangkokParts(a.startsAt);
    const e = bangkokParts(a.endsAt);
    return [s.date === date ? s.minutes : 0, e.date === date ? e.minutes : 24 * 60];
  });
  const startMin = Math.max(0, Math.min(8 * 60, ...mins.map((m) => Math.floor(m / 60) * 60)));
  const endMin = Math.min(24 * 60, Math.max(21 * 60, ...mins.map((m) => Math.ceil(m / 60) * 60)));
  const heightPx = ((endMin - startMin) / 30) * ROW_PX;
  const axis = view === 'provider' ? providers : places;
  const key = (a: Appointment) => (view === 'provider' ? a.providerId : a.placeId);
  const columns: { id: string | null; name: string; inactive: boolean }[] = [
    ...axis
      .filter((r) => r.active || all.some((a) => key(a) === r.id))
      .map((r) => ({ id: r.id, name: r.name, inactive: !r.active })),
    ...(all.some((a) => key(a) === null)
      ? [{ id: null, name: t.calUnassigned, inactive: false }]
      : []),
  ];

  const newDraft = (colId: string | null, minutes?: number) => {
    setError(null);
    setProblem(null);
    setSelected(null);
    setDraft({
      serviceId: d?.services[0]?.id ?? '',
      serviceName: '',
      price: '',
      duration: String(d?.services[0]?.duration ?? 60),
      time: timeLabel(minutes ?? Math.max(startMin, 9 * 60)),
      providerId: view === 'provider' && colId ? colId : '',
      placeId: view === 'place' && colId ? colId : '',
      guest: '',
      phone: '',
      note: '',
    });
  };
  const pickService = (id: string) => {
    const s = d?.services.find((x) => x.id === id);
    setDraft((x) => (x ? { ...x, serviceId: id, duration: String(s?.duration ?? x.duration) } : x));
  };

  const duration = draft ? Number(draft.duration) : 0;
  const startIso = draft ? toBangkokIso(date, draft.time) : null;
  const endIso =
    startIso && duration >= 5 && duration <= 720
      ? new Date(Date.parse(startIso) + duration * 60_000).toISOString()
      : null;
  const clash =
    draft && startIso && endIso
      ? findConflict(all, {
          providerId: draft.providerId || null,
          placeId: draft.placeId || null,
          startsAt: startIso,
          endsAt: endIso,
        })
      : null;

  const book = async () => {
    if (!draft || !storeId) return;
    setError(null);
    setProblem(null);
    const price = draft.serviceId ? null : parsePriceInput(draft.price || '0');
    if (
      !startIso ||
      !(duration >= 5 && duration <= 720) ||
      !draft.guest.trim() ||
      (!draft.serviceId && (!draft.serviceName.trim() || price === null))
    )
      return setProblem('bad');
    const { error: err } = await ctx.client.rpc('book_appointment', {
      p: {
        store_id: storeId,
        provider_id: draft.providerId || null,
        place_id: draft.placeId || null,
        ...(draft.serviceId
          ? { service_id: draft.serviceId }
          : { service_name: { th: draft.serviceName.trim() }, price }),
        duration_min: duration,
        starts_at: startIso,
        guest_name: draft.guest.trim(),
        guest_phone: draft.phone.trim() || null,
        note: draft.note.trim() || undefined,
      },
    });
    if (err) return fail(err);
    setDraft(null);
    reload();
  };
  const setStatus = async (a: Appointment, to: AppointmentStatus) => {
    const { error: err } = await ctx.client.rpc('set_appointment_status', {
      p_id: a.id,
      p_status: to,
    });
    if (err) return fail(err);
    reload();
  };
  const move = async (a: Appointment) => {
    if (!moving) return;
    const iso = toBangkokIso(date, moving.time);
    if (!iso) return setProblem('bad');
    const { error: err } = await ctx.client.rpc('reschedule_appointment', {
      p: {
        id: a.id,
        starts_at: iso,
        provider_id: moving.providerId || null,
        place_id: moving.placeId || null,
      },
    });
    if (err) return fail(err);
    setMoving(null);
    reload();
  };

  const sel = all.find((a) => a.id === selected) ?? null;
  const hourMarks: number[] = [];
  for (let m = startMin; m < endMin; m += 60) hourMarks.push(m);

  return (
    <div className="admin-page">
      <h1>{t.calTitle}</h1>
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      {problem === 'off' ? <Notice kind="info">{t.calModuleOff}</Notice> : null}
      {problem === 'provider' ? <Notice kind="error">{t.calBusyProvider}</Notice> : null}
      {problem === 'place' ? <Notice kind="error">{t.calBusyPlace}</Notice> : null}

      <div className="filters cal-bar">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => setDate(addDays(date, -1))}
        >
          ◀ {t.calPrev}
        </button>
        <button type="button" className="btn btn-secondary" onClick={() => setDate(today())}>
          {t.calToday}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => setDate(addDays(date, 1))}
        >
          {t.calNext} ▶
        </button>
        <div className="form-row">
          <label className="label" htmlFor="cal-date">
            {t.calDate}
          </label>
          <input
            id="cal-date"
            className="field tabular"
            type="date"
            value={date}
            onChange={(e) => e.target.value && setDate(e.target.value)}
          />
        </div>
      </div>
      <div className="tabs" role="tablist">
        {(['provider', 'place'] as const).map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            className="tab"
            aria-selected={view === v}
            onClick={() => setView(v)}
          >
            {v === 'provider' ? t.calViewProvider : t.calViewPlace}
          </button>
        ))}
      </div>
      {canManage ? (
        <p>
          <a
            href="/resources"
            onClick={(e) => {
              e.preventDefault();
              ctx.navigate('/resources');
            }}
          >
            {t.calManage}
          </a>
        </p>
      ) : null}
      {data.status === 'loading' ? (
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      ) : null}
      {data.status === 'error' ? <Notice kind="error">{t.err_load_failed}</Notice> : null}
      {d && columns.length === 0 ? <Notice kind="info">{t.calEmpty}</Notice> : null}

      {d && columns.length > 0 ? (
        <div className="cal" role="group" aria-label={t.calTitle}>
          <div className="cal-axis" style={{ height: heightPx }} aria-hidden="true">
            {hourMarks.map((m) => (
              <span key={m} style={{ top: ((m - startMin) / (endMin - startMin)) * 100 + '%' }}>
                {timeLabel(m)}
              </span>
            ))}
          </div>
          {columns.map((c) => {
            const items = all.filter((a) => key(a) === c.id);
            const placed = layoutColumn(items, date, startMin, endMin);
            return (
              <section key={c.id ?? 'none'} className="cal-col" aria-label={c.name}>
                <header className="cal-head">
                  <strong>{c.name}</strong>
                  {canBook && !c.inactive ? (
                    <button
                      type="button"
                      className="btn btn-secondary cal-add"
                      aria-label={`${t.calNew}: ${c.name}`}
                      onClick={() => newDraft(c.id)}
                    >
                      +
                    </button>
                  ) : null}
                </header>
                <div
                  className="cal-body"
                  style={{ height: heightPx }}
                  onClick={(e) => {
                    if (!canBook || c.inactive || e.target !== e.currentTarget) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    const frac = rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0;
                    newDraft(c.id, startMin + Math.floor(((endMin - startMin) * frac) / 15) * 15);
                  }}
                >
                  {hourMarks.map((m) => (
                    <i
                      key={m}
                      className="cal-line"
                      style={{ top: ((m - startMin) / (endMin - startMin)) * 100 + '%' }}
                    />
                  ))}
                  {placed.map((p) => {
                    const a = items.find((x) => x.id === p.id)!;
                    return (
                      <button
                        key={a.id}
                        type="button"
                        className={`cal-appt cal-${a.status}`}
                        aria-pressed={selected === a.id}
                        style={{
                          top: `${p.topPct}%`,
                          height: `${p.heightPct}%`,
                          left: `${(p.lane / p.lanes) * 100}%`,
                          width: `${100 / p.lanes}%`,
                        }}
                        onClick={() => {
                          setSelected(a.id);
                          setMoving(null);
                          setDraft(null);
                        }}
                      >
                        <strong>
                          {timeLabel(bangkokParts(a.startsAt).minutes)} {a.guestName}
                        </strong>
                        <span>{localizedName(a.serviceName, lang)}</span>
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      ) : null}

      {sel ? (
        <section className="card admin-card" aria-label={sel.guestName}>
          <h2>
            {sel.guestName} <span className="badge">{tx(t, `calStatus_${sel.status}`)}</span>
            {sel.source === 'online' ? <span className="badge">{t.calOnline}</span> : null}
          </h2>
          <p>
            {localizedName(sel.serviceName, lang)} · {timeLabel(bangkokParts(sel.startsAt).minutes)}
            –{timeLabel(bangkokParts(sel.endsAt).minutes)} · {formatTHB(sel.price, locale)}
          </p>
          <p className="muted">
            {nameOf(sel.providerId)}
            {sel.placeId ? ` · ${nameOf(sel.placeId)}` : ''}
            {sel.guestPhone ? ` · ${sel.guestPhone}` : ''}
            {sel.note ? ` · ${sel.note}` : ''}
          </p>
          {canBook ? (
            <div className="actions">
              {nextStatuses(sel.status).map((s) => (
                <AsyncButton
                  key={s}
                  variant={s === 'cancelled' || s === 'no_show' ? 'secondary' : undefined}
                  onClick={() => setStatus(sel, s)}
                >
                  {tx(t, `calDo_${s}`)}
                </AsyncButton>
              ))}
              {canMove(sel.status) && !moving ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() =>
                    setMoving({
                      time: timeLabel(bangkokParts(sel.startsAt).minutes),
                      providerId: sel.providerId ?? '',
                      placeId: sel.placeId ?? '',
                    })
                  }
                >
                  {t.calMove}
                </button>
              ) : null}
              <button type="button" className="btn btn-secondary" onClick={() => setSelected(null)}>
                {t.calClose}
              </button>
            </div>
          ) : null}
          {moving ? (
            <form className="auth-form" onSubmit={(e) => e.preventDefault()} aria-label={t.calMove}>
              <div className="form-row">
                <label className="label" htmlFor="mv-time">
                  {t.calMoveTo}
                </label>
                <input
                  id="mv-time"
                  className="field tabular"
                  type="time"
                  value={moving.time}
                  onChange={(e) => setMoving({ ...moving, time: e.target.value })}
                />
              </div>
              <ResourceSelect
                id="mv-provider"
                label={t.calProvider}
                none={t.calNone}
                list={providers.filter((r) => r.active)}
                value={moving.providerId}
                onChange={(v) => setMoving({ ...moving, providerId: v })}
              />
              {places.length > 0 ? (
                <ResourceSelect
                  id="mv-place"
                  label={t.calPlace}
                  none={t.calNone}
                  list={places.filter((r) => r.active)}
                  value={moving.placeId}
                  onChange={(v) => setMoving({ ...moving, placeId: v })}
                />
              ) : null}
              <div className="actions">
                <AsyncButton type="submit" onClick={() => move(sel)}>
                  {t.calMoveSave}
                </AsyncButton>
                <button type="button" className="btn btn-secondary" onClick={() => setMoving(null)}>
                  {t.menuCancel}
                </button>
              </div>
            </form>
          ) : null}
        </section>
      ) : null}

      {draft ? (
        <form
          className="card admin-card auth-form"
          onSubmit={(e) => e.preventDefault()}
          aria-label={t.calNew}
        >
          <h2>{t.calNew}</h2>
          <div className="form-row">
            <label className="label" htmlFor="bk-service">
              {t.calService}
            </label>
            <select
              id="bk-service"
              className="field"
              value={draft.serviceId}
              onChange={(e) => pickService(e.target.value)}
            >
              {(d?.services ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {localizedName(s.name, lang)} · {formatTHB(s.price, locale)}
                  {s.duration ? ` · ${s.duration} min` : ''}
                </option>
              ))}
              <option value="">{t.calCustomService}</option>
            </select>
          </div>
          {!draft.serviceId ? (
            <div className="filters">
              <div className="form-row">
                <label className="label" htmlFor="bk-sname">
                  {t.calServiceName}
                </label>
                <input
                  id="bk-sname"
                  className="field"
                  maxLength={120}
                  value={draft.serviceName}
                  onChange={(e) => setDraft({ ...draft, serviceName: e.target.value })}
                />
              </div>
              <div className="form-row">
                <label className="label" htmlFor="bk-price">
                  {t.calPrice}
                </label>
                <input
                  id="bk-price"
                  className="field tabular"
                  inputMode="decimal"
                  value={draft.price}
                  onChange={(e) => setDraft({ ...draft, price: e.target.value })}
                />
              </div>
            </div>
          ) : null}
          <div className="filters">
            <div className="form-row">
              <label className="label" htmlFor="bk-time">
                {t.calStart}
              </label>
              <input
                id="bk-time"
                className="field tabular"
                type="time"
                value={draft.time}
                onChange={(e) => setDraft({ ...draft, time: e.target.value })}
              />
            </div>
            <div className="form-row">
              <label className="label" htmlFor="bk-dur">
                {t.calDuration}
              </label>
              <input
                id="bk-dur"
                className="field tabular"
                inputMode="numeric"
                maxLength={3}
                value={draft.duration}
                onChange={(e) => setDraft({ ...draft, duration: e.target.value })}
              />
            </div>
          </div>
          <ResourceSelect
            id="bk-provider"
            label={t.calProvider}
            none={t.calNone}
            list={providers.filter((r) => r.active)}
            value={draft.providerId}
            onChange={(v) => setDraft({ ...draft, providerId: v })}
          />
          {places.length > 0 ? (
            <ResourceSelect
              id="bk-place"
              label={t.calPlace}
              none={t.calNone}
              list={places.filter((r) => r.active)}
              value={draft.placeId}
              onChange={(v) => setDraft({ ...draft, placeId: v })}
            />
          ) : null}
          <div className="filters">
            <div className="form-row">
              <label className="label" htmlFor="bk-guest">
                {t.calGuest}
              </label>
              <input
                id="bk-guest"
                className="field"
                maxLength={80}
                value={draft.guest}
                onChange={(e) => setDraft({ ...draft, guest: e.target.value })}
              />
            </div>
            <div className="form-row">
              <label className="label" htmlFor="bk-phone">
                {t.calPhone}
              </label>
              <input
                id="bk-phone"
                className="field tabular"
                maxLength={30}
                value={draft.phone}
                onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
              />
            </div>
          </div>
          <div className="form-row">
            <label className="label" htmlFor="bk-note">
              {t.calNote}
            </label>
            <input
              id="bk-note"
              className="field"
              maxLength={300}
              value={draft.note}
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
            />
          </div>
          {clash ? (
            <Notice kind="info">
              {fmt(t.calBusyWarn, {
                name: clash.guestName,
                time: timeLabel(bangkokParts(clash.startsAt).minutes),
              })}
            </Notice>
          ) : null}
          {problem === 'bad' ? <Notice kind="error">{t.calBad}</Notice> : null}
          <div className="actions">
            <AsyncButton type="submit" onClick={book}>
              {t.calBook}
            </AsyncButton>
            <button type="button" className="btn btn-secondary" onClick={() => setDraft(null)}>
              {t.menuCancel}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function ResourceSelect({
  id,
  label,
  none,
  list,
  value,
  onChange,
}: {
  id: string;
  label: string;
  none: string;
  list: Resource[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="form-row">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <select id={id} className="field" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{none}</option>
        {list.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </select>
    </div>
  );
}
