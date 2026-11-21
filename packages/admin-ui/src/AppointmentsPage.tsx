import { useState } from 'react';
import {
  addDays,
  bangkokDayBounds,
  bangkokParts,
  blockSpan,
  canBill,
  canMove,
  canSettleDeposit,
  canTakeDeposit,
  DEPOSIT_METHODS,
  depositRoom,
  depositTotals,
  findConflict,
  formatTHB,
  layoutColumn,
  localizedName,
  nextStatuses,
  parseAppointments,
  parseCustomerPackages,
  parseDeposits,
  usablePackage,
  suggestDeposit,
  parsePriceInput,
  priceInputValue,
  parseResources,
  timeLabel,
  toBangkokIso,
  isProviderKind,
} from '@bestie/core';
import type {
  Appointment,
  AppointmentStatus,
  CustomerCard,
  CustomerPackage,
  Deposit,
  DepositMethod,
  Resource,
} from '@bestie/core';
import { errorText, fmt, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { CustomerPicker } from './CustomerPicker';
import { tx } from './stockInput';
import { bangkokToday } from './today';
import { HairRequestPanel } from './HairRequestPanel';
import { useRemote } from './useRemote';

type Service = {
  id: string;
  name: { th: string; en?: string };
  price: number;
  duration: number | null;
};
type Till = { id: string; name: string };
type Loaded = {
  resources: Resource[];
  appts: Appointment[];
  services: Service[];
  deposits: Deposit[];
  tills: Till[];
  people: { id: string; name: string }[];
  packages: CustomerPackage[];
  uses: Record<string, string>; // appointment id → the package use that covers it
  blocks: { resourceId: string; startsAt: string; endsAt: string; reason: string }[];
};
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
  member: { id: string; name: string } | null;
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
  const [problem, setProblem] = useState<
    'bad' | 'provider' | 'place' | 'off' | 'deposit' | 'tip' | null
  >(null);
  const [dep, setDep] = useState<{
    amount: string;
    method: DepositMethod;
    till: string;
    ref: string;
  } | null>(null);
  const [settleTill, setSettleTill] = useState('');
  const [picking, setPicking] = useState(false);
  const [tip, setTip] = useState<{
    staff: string;
    amount: string;
    method: DepositMethod;
    till: string;
  } | null>(null);
  const [tipSaved, setTipSaved] = useState(false);
  const commissionOn = ctx.isModuleOn ? ctx.isModuleOn('commission') : true;
  const canTakeMoney = ctx.isOwner || ctx.permissions.includes('payment.take');
  const canRefund = ctx.isOwner || ctx.permissions.includes('refund.create');
  const depositsOn = ctx.isModuleOn ? ctx.isModuleOn('deposits') : true;
  const packagesOn = ctx.isModuleOn ? ctx.isModuleOn('packages') : true;
  const todayDate = bangkokToday();

  const bounds = bangkokDayBounds(date);
  const data = useRemote<Loaded>(
    async () => {
      if (!storeId || !bounds) throw new Error('shop');
      const [res, ap, menu] = await Promise.all([
        ctx.client
          .from('resources')
          .select('id, name, kind, active, sort, staff_id')
          .eq('store_id', storeId)
          .is('deleted_at', null)
          .order('sort'),
        ctx.client
          .from('appointments')
          .select(
            'id, provider_id, place_id, service_name, price, guest_name, guest_phone, starts_at, ends_at, status, source, note, order_id, customer_id, customer_package_id, group_id',
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
      const appts = parseAppointments(ap.data);
      // deposits and the tills they went into: only when there is something to show (and a person who may see money)
      const customerIds = [...new Set(appts.flatMap((a) => (a.customerId ? [a.customerId] : [])))];
      const coveredIds = appts.filter((a) => a.customerPackageId).map((a) => a.id);
      const [pk, us] = await Promise.all([
        customerIds.length > 0
          ? ctx.client
              .from('customer_packages')
              .select(
                'id, customer_id, name, price, visits_total, visits_left, valid_until, status',
              )
              .in('customer_id', customerIds)
              .eq('status', 'active')
          : Promise.resolve({ data: [], error: null }),
        coveredIds.length > 0
          ? ctx.client
              .from('package_uses')
              .select('id, appointment_id, created_at')
              .in('appointment_id', coveredIds)
              .eq('kind', 'use')
              .order('created_at')
          : Promise.resolve({ data: [], error: null }),
      ]);
      const uses: Record<string, string> = {};
      for (const u of (us.error ? [] : (us.data ?? [])) as { id: string; appointment_id: string }[])
        uses[u.appointment_id] = u.id; // ascending: the last one wins = the latest use
      const blk = await ctx.client
        .from('resource_blocks')
        .select('resource_id, starts_at, ends_at, reason')
        .eq('store_id', storeId)
        .lt('starts_at', bounds.to)
        .gt('ends_at', bounds.from);
      const [dep, dev, ppl] = await Promise.all([
        appts.length > 0
          ? ctx.client
              .from('appointment_deposits')
              .select('id, appointment_id, amount, method, status, reference')
              .in(
                'appointment_id',
                appts.map((a) => a.id),
              )
              .order('created_at')
          : Promise.resolve({ data: [], error: null }),
        ctx.client
          .from('devices')
          .select('id, name')
          .eq('store_id', storeId)
          .eq('active', true)
          .eq('role', 'cashier')
          .order('name'),
        ctx.client
          .from('staff')
          .select('id, display_name')
          .eq('org_id', ctx.orgId)
          .eq('active', true)
          .order('display_name'),
      ]);
      return {
        people: ppl.error
          ? []
          : ((ppl.data ?? []) as { id: string; display_name: string }[]).map((x) => ({
              id: x.id,
              name: x.display_name,
            })),
        packages: pk.error ? [] : parseCustomerPackages(pk.data),
        uses,
        blocks: blk.error
          ? []
          : ((blk.data ?? []) as Record<string, string | null>[]).map((b) => ({
              resourceId: String(b.resource_id),
              startsAt: String(b.starts_at),
              endsAt: String(b.ends_at),
              reason: b.reason ?? '',
            })),
        deposits: dep.error ? [] : parseDeposits(dep.data),
        tills: dev.error
          ? []
          : ((dev.data ?? []) as Record<string, unknown>[]).flatMap((x) =>
              typeof x.id === 'string' && typeof x.name === 'string'
                ? [{ id: x.id, name: x.name }]
                : [],
            ),
        resources: parseResources(res.data),
        appts,
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
      member: null,
    });
    setPicking(false);
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
        customer_id: draft.member?.id ?? null,
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
  // the people of one couple / party booking that can still be cancelled
  const groupLive = (a: Appointment) =>
    all.filter(
      (x) => x.groupId === a.groupId && (x.status === 'booked' || x.status === 'confirmed'),
    );
  const cancelGroup = async (a: Appointment) => {
    setError(null);
    for (const x of groupLive(a)) {
      const { error: err } = await ctx.client.rpc('set_appointment_status', {
        p_id: x.id,
        p_status: 'cancelled',
      });
      if (err) {
        reload();
        return fail(err);
      }
    }
    reload();
  };
  const takeTip = async (a: Appointment) => {
    if (!tip || !storeId) return;
    setError(null);
    setProblem(null);
    setTipSaved(false);
    const amount = parsePriceInput(tip.amount);
    if (!tip.staff || amount === null || amount < 1 || (tip.method === 'cash' && !tip.till))
      return setProblem('tip');
    const { error: err } = await ctx.client.rpc('record_tip', {
      p: {
        store_id: storeId,
        staff_id: tip.staff,
        amount,
        method: tip.method,
        device_id: tip.method === 'cash' ? tip.till : null,
        appointment_id: a.id,
      },
    });
    if (err) {
      if (err.code === '22023') return setProblem('tip');
      return fail(err);
    }
    setTip(null);
    setTipSaved(true);
  };
  const redeemPackage = async (a: Appointment, cp: CustomerPackage) => {
    setError(null);
    setProblem(null);
    const { error: err } = await ctx.client.rpc('use_package', {
      p: { appointment_id: a.id, customer_package_id: cp.id },
    });
    if (err) return fail(err);
    reload();
  };
  const undoPackage = async (a: Appointment) => {
    const useId = d?.uses[a.id];
    if (!useId) return;
    setError(null);
    setProblem(null);
    const { error: err } = await ctx.client.rpc('undo_package_use', { p_use: useId });
    if (err) return fail(err);
    reload();
  };
  const openBill = async (a: Appointment) => {
    setError(null);
    setProblem(null);
    const { data: id, error: err } = await ctx.client.rpc('appointment_to_order', {
      p: { appointment_id: a.id, device_id: d?.tills[0]?.id ?? null },
    });
    if (err || typeof id !== 'string') return fail(err ?? {});
    ctx.navigate(`/order/${id}`);
  };
  const takeDeposit = async (a: Appointment) => {
    if (!dep) return;
    setError(null);
    setProblem(null);
    const amount = parsePriceInput(dep.amount);
    if (amount === null || amount < 1 || (dep.method === 'cash' && !dep.till))
      return setProblem('deposit');
    const { error: err } = await ctx.client.rpc('record_appointment_deposit', {
      p: {
        appointment_id: a.id,
        amount,
        method: dep.method,
        device_id: dep.method === 'cash' ? dep.till : null,
        reference: dep.ref.trim() || undefined,
      },
    });
    if (err) {
      if (err.code === '22023') return setProblem('deposit');
      return fail(err);
    }
    setDep(null);
    reload();
  };
  const settle = async (x: Deposit, action: 'forfeit' | 'refund') => {
    setError(null);
    setProblem(null);
    if (action === 'refund' && x.method === 'cash' && !settleTill) return setProblem('deposit');
    const { error: err } = await ctx.client.rpc('resolve_deposit', {
      p: {
        deposit_id: x.id,
        action,
        device_id: action === 'refund' && x.method === 'cash' ? settleTill : null,
      },
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
      <div className="actions">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => ctx.navigate('/group-booking')}
        >
          {t.groupLink}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => ctx.navigate('/days-off')}
        >
          {t.daysOffLink}
        </button>
      </div>
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      {problem === 'off' ? <Notice kind="info">{t.calModuleOff}</Notice> : null}
      {problem === 'deposit' ? <Notice kind="error">{t.calDepositBad}</Notice> : null}
      {problem === 'tip' ? <Notice kind="error">{t.calTipBad}</Notice> : null}
      {tipSaved ? <Notice kind="success">{t.calTipSaved}</Notice> : null}
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
                  {(d.blocks ?? [])
                    .filter((b) => b.resourceId === c.id)
                    .map((b, i) => {
                      const span = bounds ? blockSpan(b, bounds.from, startMin, endMin) : null;
                      return span ? (
                        <div
                          key={`block-${i}`}
                          className="cal-block"
                          role="img"
                          aria-label={`${t.calOff}${b.reason ? `: ${b.reason}` : ''}`}
                          style={{ top: `${span.topPct}%`, height: `${span.heightPct}%` }}
                        >
                          <span>
                            {t.calOff}
                            {b.reason ? ` · ${b.reason}` : ''}
                          </span>
                        </div>
                      ) : null;
                    })}
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
          {sel.source === 'online' ? <HairRequestPanel ctx={ctx} appointmentId={sel.id} /> : null}
          {sel.groupId && groupLive(sel).length > 1 ? (
            <p className="muted">
              {fmt(t.calGroupOf, { n: all.filter((a) => a.groupId === sel.groupId).length })}
            </p>
          ) : null}
          {canBook && sel.groupId && groupLive(sel).length > 1 ? (
            <div className="actions">
              <AsyncButton variant="secondary" onClick={() => cancelGroup(sel)}>
                {fmt(t.calCancelGroup, { n: groupLive(sel).length })}
              </AsyncButton>
            </div>
          ) : null}
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
          {depositsOn && d ? (
            <DepositsBlock
              appt={sel}
              deposits={d.deposits.filter((x) => x.appointmentId === sel.id)}
              tills={d.tills}
              canTake={canTakeMoney}
              canRefund={canRefund}
              dep={dep}
              setDep={setDep}
              settleTill={settleTill}
              setSettleTill={setSettleTill}
              onTake={() => takeDeposit(sel)}
              onSettle={settle}
              money={(n) => formatTHB(n, locale)}
            />
          ) : null}
          {packagesOn && d && sel.customerId ? (
            <div className="cal-deposits">
              <h3>{t.calPackages}</h3>
              {sel.customerPackageId ? (
                <p className="muted">
                  {fmt(t.calCovered, {
                    name: (() => {
                      const cp = d.packages.find((x) => x.id === sel.customerPackageId);
                      return cp ? localizedName(cp.name, lang) : '—';
                    })(),
                  })}{' '}
                  {canRefund && d.uses[sel.id] ? (
                    <AsyncButton variant="secondary" onClick={() => undoPackage(sel)}>
                      {t.calUndoPackage}
                    </AsyncButton>
                  ) : null}
                </p>
              ) : (
                (() => {
                  const mine = d.packages.filter(
                    (x) => x.customerId === sel.customerId && usablePackage(x, todayDate),
                  );
                  const can =
                    canBook &&
                    !sel.orderId &&
                    ['arrived', 'in_service', 'done'].includes(sel.status);
                  if (mine.length === 0) return <p className="muted">{t.calNoPackage}</p>;
                  return (
                    <div className="actions">
                      {mine.map((x) => (
                        <AsyncButton
                          key={x.id}
                          variant="secondary"
                          disabled={!can}
                          onClick={() => redeemPackage(sel, x)}
                        >
                          {fmt(t.calUsePackage, {
                            name: localizedName(x.name, lang),
                            left: x.visitsLeft,
                          })}
                        </AsyncButton>
                      ))}
                    </div>
                  );
                })()
              )}
            </div>
          ) : null}
          {commissionOn &&
          d &&
          canTakeMoney &&
          sel.status !== 'cancelled' &&
          sel.status !== 'no_show' ? (
            <div className="cal-deposits">
              <h3>{t.calTip}</h3>
              {tip ? (
                <form
                  className="auth-form"
                  onSubmit={(e) => e.preventDefault()}
                  aria-label={t.calTipTake}
                >
                  <div className="form-row">
                    <label className="label" htmlFor="tip-staff">
                      {t.calTipFor}
                    </label>
                    <select
                      id="tip-staff"
                      className="field"
                      value={tip.staff}
                      onChange={(e) => setTip({ ...tip, staff: e.target.value })}
                    >
                      <option value="">{t.calNone}</option>
                      {d.people.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="filters">
                    <div className="form-row">
                      <label className="label" htmlFor="tip-amount">
                        {t.calTipAmount}
                      </label>
                      <input
                        id="tip-amount"
                        className="field tabular"
                        inputMode="decimal"
                        value={tip.amount}
                        onChange={(e) => setTip({ ...tip, amount: e.target.value })}
                      />
                    </div>
                    <div className="form-row">
                      <label className="label" htmlFor="tip-method">
                        {t.calTipMethod}
                      </label>
                      <select
                        id="tip-method"
                        className="field"
                        value={tip.method}
                        onChange={(e) =>
                          setTip({ ...tip, method: e.target.value as DepositMethod })
                        }
                      >
                        {DEPOSIT_METHODS.map((m) => (
                          <option key={m} value={m}>
                            {tx(t, `calDepMethod_${m}`)}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  {tip.method === 'cash' ? (
                    <div className="form-row">
                      <label className="label" htmlFor="tip-till">
                        {t.calTipTill}
                      </label>
                      <select
                        id="tip-till"
                        className="field"
                        value={tip.till}
                        onChange={(e) => setTip({ ...tip, till: e.target.value })}
                      >
                        <option value="">{t.calNone}</option>
                        {d.tills.map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}
                  <div className="actions">
                    <AsyncButton type="submit" onClick={() => takeTip(sel)}>
                      {t.calTipSave}
                    </AsyncButton>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setTip(null)}
                    >
                      {t.menuCancel}
                    </button>
                  </div>
                </form>
              ) : (
                <div className="actions">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => {
                      setTipSaved(false);
                      setTip({
                        staff: d.resources.find((r) => r.id === sel.providerId)?.staffId ?? '',
                        amount: '',
                        method: 'cash',
                        till: d.tills[0]?.id ?? '',
                      });
                    }}
                  >
                    {t.calTipTake}
                  </button>
                </div>
              )}
            </div>
          ) : null}
          {canBook && canBill(sel) ? (
            <div className="actions">
              <AsyncButton onClick={() => openBill(sel)}>
                {sel.orderId ? t.calGoToBill : t.calOpenBill}
              </AsyncButton>
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
          {packagesOn || depositsOn ? (
            <div className="form-row">
              <span className="label">{t.calMember}</span>
              {draft.member ? (
                <p>
                  <strong>{draft.member.name}</strong>{' '}
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setDraft({ ...draft, member: null })}
                  >
                    {t.calUnlinkMember}
                  </button>
                </p>
              ) : picking ? (
                <CustomerPicker
                  ctx={ctx}
                  idPrefix="bk"
                  onPick={(c: CustomerCard) => {
                    setDraft({
                      ...draft,
                      member: { id: c.id, name: c.name },
                      guest: draft.guest || c.name,
                    });
                    setPicking(false);
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setPicking(true)}
                >
                  {t.calLinkMember}
                </button>
              )}
            </div>
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

function DepositsBlock({
  appt,
  deposits,
  tills,
  canTake,
  canRefund,
  dep,
  setDep,
  settleTill,
  setSettleTill,
  onTake,
  onSettle,
  money,
}: {
  appt: Appointment;
  deposits: Deposit[];
  tills: Till[];
  canTake: boolean;
  canRefund: boolean;
  dep: { amount: string; method: DepositMethod; till: string; ref: string } | null;
  setDep: (v: { amount: string; method: DepositMethod; till: string; ref: string } | null) => void;
  settleTill: string;
  setSettleTill: (v: string) => void;
  onTake: () => Promise<void>;
  onSettle: (x: Deposit, action: 'forfeit' | 'refund') => Promise<void>;
  money: (n: number) => string;
}) {
  const { t } = useI18n();
  const room = depositRoom(appt.price, deposits);
  const totals = depositTotals(deposits);
  const showTake = canTake && canTakeDeposit(appt.status) && room > 0;
  const hasHeldCash = deposits.some((x) => x.status === 'held' && x.method === 'cash');
  if (deposits.length === 0 && !showTake) return null;
  return (
    <section className="cal-deposits" aria-label={t.calDeposits}>
      <h3>{t.calDeposits}</h3>
      {deposits.length > 0 ? (
        <>
          <ul className="muted">
            {deposits.map((x) => (
              <li key={x.id}>
                {money(x.amount)} · {tx(t, `calDepMethod_${x.method}`)} ·{' '}
                {tx(t, `calDepStatus_${x.status}`)}
                {x.reference ? ` · ${x.reference}` : ''}
                {x.status === 'held' && canSettleDeposit(appt.status) && canRefund ? (
                  <span className="actions">
                    <AsyncButton variant="secondary" onClick={() => onSettle(x, 'forfeit')}>
                      {t.calDepKeep}
                    </AsyncButton>
                    <AsyncButton variant="secondary" onClick={() => onSettle(x, 'refund')}>
                      {t.calDepRefund}
                    </AsyncButton>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          {canRefund && canSettleDeposit(appt.status) && hasHeldCash && tills.length > 0 ? (
            <div className="form-row">
              <label className="label" htmlFor="dep-settle-till">
                {t.calDepRefundTill}
              </label>
              <select
                id="dep-settle-till"
                className="field"
                value={settleTill}
                onChange={(e) => setSettleTill(e.target.value)}
              >
                <option value="">{t.calNone}</option>
                {tills.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <p className="muted tabular">
            {fmt(t.calDepHolding, { amount: money(totals.open) })}
            {totals.forfeited > 0
              ? ` · ${fmt(t.calDepKept, { amount: money(totals.forfeited) })}`
              : ''}
          </p>
        </>
      ) : null}
      {showTake && !dep ? (
        <div className="actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() =>
              setDep({
                amount: priceInputValue(Math.min(room, suggestDeposit(appt.price))),
                method: 'cash',
                till: tills[0]?.id ?? '',
                ref: '',
              })
            }
          >
            {t.calDepTake}
          </button>
        </div>
      ) : null}
      {dep ? (
        <form className="auth-form" onSubmit={(e) => e.preventDefault()} aria-label={t.calDepTake}>
          <div className="filters">
            <div className="form-row">
              <label className="label" htmlFor="dep-amount">
                {t.calDepAmount}
              </label>
              <input
                id="dep-amount"
                className="field tabular"
                inputMode="decimal"
                value={dep.amount}
                onChange={(e) => setDep({ ...dep, amount: e.target.value })}
              />
            </div>
            <div className="form-row">
              <label className="label" htmlFor="dep-method">
                {t.calDepMethod}
              </label>
              <select
                id="dep-method"
                className="field"
                value={dep.method}
                onChange={(e) => setDep({ ...dep, method: e.target.value as DepositMethod })}
              >
                {DEPOSIT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {tx(t, `calDepMethod_${m}`)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {dep.method === 'cash' ? (
            <div className="form-row">
              <label className="label" htmlFor="dep-till">
                {t.calDepTill}
              </label>
              <select
                id="dep-till"
                className="field"
                value={dep.till}
                onChange={(e) => setDep({ ...dep, till: e.target.value })}
              >
                <option value="">{t.calNone}</option>
                {tills.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="form-row">
            <label className="label" htmlFor="dep-ref">
              {t.calDepRef}
            </label>
            <input
              id="dep-ref"
              className="field"
              maxLength={100}
              value={dep.ref}
              onChange={(e) => setDep({ ...dep, ref: e.target.value })}
            />
          </div>
          <p className="muted">{fmt(t.calDepRoom, { amount: money(room) })}</p>
          <div className="actions">
            <AsyncButton type="submit" onClick={onTake}>
              {t.calDepSave}
            </AsyncButton>
            <button type="button" className="btn btn-secondary" onClick={() => setDep(null)}>
              {t.menuCancel}
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
