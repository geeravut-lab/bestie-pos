import { useState } from 'react';
import {
  formatTHB,
  guestName,
  parsePriceInput,
  parseTourBookings,
  parseTourSlots,
  seatsLeft,
} from '@bestie/core';
import type { TourBooking, TourSlot } from '@bestie/core';
import { fmt, formatDateTime, useI18n } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice, useLiveSync } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useRemote } from './useRemote';

type SlotForm = {
  th: string;
  en: string;
  starts: string;
  minutes: string;
  seats: string;
  price: string;
  guide: string;
};
const EMPTY: SlotForm = {
  th: '',
  en: '',
  starts: '',
  minutes: '240',
  seats: '8',
  price: '',
  guide: '',
};
const newId = (): string => globalThis.crypto.randomUUID();

/** Tour slots: seats, guide, bookings at the desk, check-in, a deposit and the bill (module `slots.booking`). */
export function ToursPage({ ctx }: { ctx: PageContext }) {
  const { t, lang } = useI18n();
  const money = (n: number) => formatTHB(n, lang === 'th' ? 'th-TH' : 'en-GB');
  const storeId = ctx.storeId ?? ctx.homeStoreId ?? null;
  const canEdit = ctx.isOwner || ctx.permissions.includes('menu.edit');
  const canTake = ctx.isOwner || ctx.permissions.includes('payment.take');
  const [form, setForm] = useState<SlotForm | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [guest, setGuest] = useState({ name: '', phone: '', seats: '2' });
  const [dep, setDep] = useState<{
    id: string;
    amount: string;
    method: 'promptpay' | 'gateway';
  } | null>(null);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  const data = useRemote(async () => {
    if (!storeId) throw new Error('no store');
    const from = new Date(Date.now() - 6 * 3_600_000).toISOString();
    const slots = await ctx.client
      .from('tour_slots')
      .select('*')
      .eq('store_id', storeId)
      .gte('starts_at', from)
      .order('starts_at');
    if (slots.error) throw new Error('load');
    const parsed = parseTourSlots(slots.data);
    const ids = parsed.map((s) => s.id);
    const [books, staff, tills] = await Promise.all([
      ids.length
        ? ctx.client.from('tour_bookings').select('*').in('slot_id', ids).order('created_at')
        : Promise.resolve({ data: [], error: null }),
      ctx.client.from('staff').select('id, display_name').eq('active', true).order('display_name'),
      ctx.client.from('devices').select('id').eq('store_id', storeId).eq('active', true).limit(1),
    ]);
    const bySlot: Record<string, TourBooking[]> = {};
    for (const raw of (books.data ?? []) as { slot_id: string }[]) {
      (bySlot[raw.slot_id] ??= []).push(...parseTourBookings([raw]));
    }
    return {
      slots: parsed,
      bookings: bySlot,
      staff: (staff.data ?? []) as { id: string; display_name: string }[],
      till: ((tills.data ?? [])[0] as { id: string } | undefined)?.id ?? null,
    };
  }, `${storeId}`);
  const { reload } = data;
  useLiveSync(ctx.client, storeId ? [`store:${storeId}`] : [], reload);
  const d = data.data;
  const guideName = (s: TourSlot) => d?.staff.find((x) => x.id === s.guideStaffId)?.display_name;

  const fail = (code?: string) =>
    setMsg({
      kind: 'error',
      text:
        code === '55000'
          ? t.touErrFull
          : code === '42501'
            ? t.err_forbidden
            : code === '22023' || code === '23514'
              ? t.touErrInvalid
              : t.touErr,
    });
  const saveSlot = async () => {
    if (!form || !storeId) return;
    setMsg(null);
    const price = parsePriceInput(form.price);
    const seats = Number(form.seats);
    const minutes = Number(form.minutes);
    if (
      !form.th.trim() ||
      !form.starts ||
      price === null ||
      !Number.isInteger(seats) ||
      seats < 1 ||
      !Number.isInteger(minutes) ||
      minutes < 15
    )
      return setMsg({ kind: 'error', text: t.touErrInvalid });
    const r = await ctx.client.rpc('save_tour_slot', {
      p: {
        store_id: storeId,
        title: { th: form.th.trim(), ...(form.en.trim() ? { en: form.en.trim() } : {}) },
        starts_at: `${form.starts}:00+07:00`,
        duration_min: minutes,
        capacity: seats,
        price,
        guide_staff_id: form.guide || null,
      },
    });
    if (r.error) return fail(r.error.code);
    setForm(null);
    setMsg({ kind: 'success', text: t.touSaved });
    reload();
  };
  const cancelSlot = async (id: string) => {
    const r = await ctx.client.rpc('cancel_tour_slot', { p_id: id });
    if (r.error) return fail(r.error.code);
    reload();
  };
  const book = async (s: TourSlot) => {
    setMsg(null);
    const seats = Number(guest.seats);
    if (!guest.name.trim() || !Number.isInteger(seats) || seats < 1)
      return setMsg({ kind: 'error', text: t.touErrInvalid });
    const r = await ctx.client.rpc('book_tour', {
      p: {
        slot_id: s.id,
        guest_name: guest.name.trim(),
        phone: guest.phone.trim() || null,
        seats,
        client_id: newId(),
      },
    });
    if (r.error) return fail(r.error.code);
    setGuest({ name: '', phone: '', seats: '2' });
    reload();
  };
  const status = async (b: TourBooking, to: 'checked_in' | 'cancelled' | 'no_show') => {
    const r = await ctx.client.rpc('set_tour_booking_status', { p_id: b.id, p_status: to });
    if (r.error) return fail(r.error.code);
    reload();
  };
  const takeDeposit = async () => {
    if (!dep) return;
    const amount = parsePriceInput(dep.amount);
    if (amount === null || amount < 1) return setMsg({ kind: 'error', text: t.touErrInvalid });
    const r = await ctx.client.rpc('take_tour_deposit', {
      p: { booking_id: dep.id, amount, method: dep.method },
    });
    if (r.error) return fail(r.error.code);
    setDep(null);
    reload();
  };
  const openBill = async (b: TourBooking) => {
    const r = await ctx.client.rpc('tour_to_order', {
      p: { booking_id: b.id, device_id: d?.till ?? null },
    });
    if (r.error || typeof r.data !== 'string') return fail(r.error?.code);
    ctx.navigate(`/order/${r.data}`);
  };
  const set = (patch: Partial<SlotForm>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const field = (id: string, label: string, el: React.ReactNode) => (
    <div className="form-row">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      {el}
    </div>
  );

  return (
    <div className="admin-page">
      <h1>{t.touTitle}</h1>
      <Notice kind="info">{t.touIntro}</Notice>
      <Notice kind="info">{t.touDepositNote}</Notice>
      {msg ? <Notice kind={msg.kind}>{msg.text}</Notice> : null}
      {data.status === 'loading' ? (
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      ) : null}
      {data.status === 'error' ? <Notice kind="error">{t.err_load_failed}</Notice> : null}
      {d && d.slots.length === 0 ? <p className="muted">{t.touNone}</p> : null}
      <ul className="member-list">
        {(d?.slots ?? []).map((s) => {
          const books = d?.bookings[s.id] ?? [];
          const left = seatsLeft(s.capacity, books);
          const isOpen = open === s.id;
          return (
            <li key={s.id} className="card admin-card">
              <strong>{guestName(s.title, lang)}</strong>{' '}
              {s.status === 'cancelled' ? <span className="badge">{t.touCancelled}</span> : null}
              {s.status === 'open' && left === 0 ? (
                <span className="badge">{t.touFull}</span>
              ) : null}
              <p className="muted">
                {formatDateTime(lang, s.startsAt)} · {fmt(t.touMin, { n: s.durationMin })} ·{' '}
                {fmt(t.touSeats, { taken: s.capacity - left, cap: s.capacity })} · {money(s.price)}
                {' · '}
                {guideName(s) ?? t.touNoGuide}
              </p>
              <div className="actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  aria-expanded={isOpen}
                  onClick={() => setOpen(isOpen ? null : s.id)}
                >
                  {t.touManifest} ({books.filter((b) => b.status !== 'cancelled').length})
                </button>
                {canEdit && s.status === 'open' ? (
                  <AsyncButton variant="secondary" onClick={() => cancelSlot(s.id)}>
                    {t.touCancelSlot}
                  </AsyncButton>
                ) : null}
              </div>
              {isOpen ? (
                <div>
                  <ul className="member-list">
                    {books
                      .filter((b) => b.status !== 'cancelled')
                      .map((b) => (
                        <li key={b.id}>
                          <strong>{b.guestName}</strong> × {b.seats}{' '}
                          <span className="badge">{t[`touSt_${b.status}`]}</span>
                          {b.phone ? <span className="muted"> · {b.phone}</span> : null}
                          {b.deposit > 0 ? (
                            <span className="muted">
                              {' '}
                              · {t.touDeposit}: {money(b.deposit)}
                            </span>
                          ) : null}
                          <div className="actions">
                            {b.status === 'booked' ? (
                              <>
                                <AsyncButton onClick={() => status(b, 'checked_in')}>
                                  {t.touCheckIn}
                                </AsyncButton>
                                <AsyncButton
                                  variant="secondary"
                                  onClick={() => status(b, 'no_show')}
                                >
                                  {t.touNoShow}
                                </AsyncButton>
                                <AsyncButton
                                  variant="secondary"
                                  onClick={() => status(b, 'cancelled')}
                                >
                                  {t.touCancelBooking}
                                </AsyncButton>
                                {canTake ? (
                                  <button
                                    type="button"
                                    className="btn btn-secondary"
                                    onClick={() =>
                                      setDep({ id: b.id, amount: '', method: 'promptpay' })
                                    }
                                  >
                                    {t.touDeposit}
                                  </button>
                                ) : null}
                              </>
                            ) : null}
                            {b.status === 'checked_in' ? (
                              <AsyncButton onClick={() => openBill(b)}>{t.touOpenBill}</AsyncButton>
                            ) : null}
                          </div>
                          {dep?.id === b.id ? (
                            <div className="form-inline">
                              {field(
                                `dep-m-${b.id}`,
                                t.touDepositMethod,
                                <select
                                  id={`dep-m-${b.id}`}
                                  value={dep.method}
                                  onChange={(e) =>
                                    setDep({
                                      ...dep,
                                      method:
                                        e.target.value === 'gateway' ? 'gateway' : 'promptpay',
                                    })
                                  }
                                >
                                  <option value="promptpay">{t.touPromptPay}</option>
                                  <option value="gateway">{t.touCard}</option>
                                </select>,
                              )}
                              {field(
                                `dep-a-${b.id}`,
                                t.touDepositAmount,
                                <input
                                  id={`dep-a-${b.id}`}
                                  inputMode="decimal"
                                  value={dep.amount}
                                  onChange={(e) => setDep({ ...dep, amount: e.target.value })}
                                />,
                              )}
                              <AsyncButton onClick={takeDeposit}>{t.touDeposit}</AsyncButton>
                            </div>
                          ) : null}
                        </li>
                      ))}
                  </ul>
                  {s.status === 'open' ? (
                    <div className="form-inline">
                      {field(
                        `g-n-${s.id}`,
                        t.touGuest,
                        <input
                          id={`g-n-${s.id}`}
                          value={guest.name}
                          maxLength={80}
                          onChange={(e) => setGuest({ ...guest, name: e.target.value })}
                        />,
                      )}
                      {field(
                        `g-p-${s.id}`,
                        t.touPhone,
                        <input
                          id={`g-p-${s.id}`}
                          inputMode="tel"
                          value={guest.phone}
                          onChange={(e) => setGuest({ ...guest, phone: e.target.value })}
                        />,
                      )}
                      {field(
                        `g-s-${s.id}`,
                        t.touSeatsN,
                        <input
                          id={`g-s-${s.id}`}
                          inputMode="numeric"
                          value={guest.seats}
                          onChange={(e) => setGuest({ ...guest, seats: e.target.value })}
                        />,
                      )}
                      <AsyncButton onClick={() => book(s)}>{t.touBook}</AsyncButton>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {canEdit && !form ? (
        <button type="button" className="btn btn-primary" onClick={() => setForm(EMPTY)}>
          {t.touAdd}
        </button>
      ) : null}
      {form ? (
        <section className="card admin-card" aria-label={t.touAdd}>
          <h2>{t.touAdd}</h2>
          {field(
            'tou-th',
            t.touTitleTh,
            <input
              id="tou-th"
              value={form.th}
              maxLength={80}
              onChange={(e) => set({ th: e.target.value })}
            />,
          )}
          {field(
            'tou-en',
            t.touTitleEn,
            <input
              id="tou-en"
              value={form.en}
              maxLength={80}
              onChange={(e) => set({ en: e.target.value })}
            />,
          )}
          {field(
            'tou-starts',
            t.touStarts,
            <input
              id="tou-starts"
              type="datetime-local"
              value={form.starts}
              onChange={(e) => set({ starts: e.target.value })}
            />,
          )}
          {field(
            'tou-min',
            t.touDuration,
            <input
              id="tou-min"
              inputMode="numeric"
              value={form.minutes}
              onChange={(e) => set({ minutes: e.target.value })}
            />,
          )}
          {field(
            'tou-seats',
            t.touCapacity,
            <input
              id="tou-seats"
              inputMode="numeric"
              value={form.seats}
              onChange={(e) => set({ seats: e.target.value })}
            />,
          )}
          {field(
            'tou-price',
            t.touPrice,
            <input
              id="tou-price"
              inputMode="decimal"
              value={form.price}
              onChange={(e) => set({ price: e.target.value })}
            />,
          )}
          {field(
            'tou-guide',
            t.touGuide,
            <select
              id="tou-guide"
              value={form.guide}
              onChange={(e) => set({ guide: e.target.value })}
            >
              <option value="">{t.touNoGuide}</option>
              {(d?.staff ?? []).map((x) => (
                <option key={x.id} value={x.id}>
                  {x.display_name}
                </option>
              ))}
            </select>,
          )}
          <div className="actions">
            <AsyncButton onClick={saveSlot}>{t.touSave}</AsyncButton>
            <button type="button" className="btn btn-secondary" onClick={() => setForm(null)}>
              {t.modulesCancel}
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
