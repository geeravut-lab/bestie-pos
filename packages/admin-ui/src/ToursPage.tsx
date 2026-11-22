import { useState } from 'react';
import {
  formatTHB,
  guestName,
  parsePriceInput,
  parseTourBookings,
  parseTourDeposits,
  parseTourSlots,
  seatsLeft,
} from '@bestie/core';
import type { TourBooking, TourDeposit, TourSlot } from '@bestie/core';
import { fmt, formatDateTime, useI18n } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice, useLiveSync } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { TourLinkPanel } from './TourLinkPanel';
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
  const canRefund = ctx.isOwner || ctx.permissions.includes('refund.create');
  const [form, setForm] = useState<SlotForm | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [guest, setGuest] = useState({ name: '', phone: '', seats: '2' });
  const [dep, setDep] = useState<{
    id: string;
    amount: string;
    method: 'promptpay' | 'gateway' | 'cash';
    till: string;
  } | null>(null);
  const [settleTill, setSettleTill] = useState('');
  const [rem, setRem] = useState<{ id: string; email: string; code: string | null } | null>(null);
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
      ctx.client
        .from('devices')
        .select('id, name')
        .eq('store_id', storeId)
        .eq('active', true)
        .order('name'),
    ]);
    const bookIds = ((books.data ?? []) as { id: string }[]).map((b) => b.id);
    const deps = bookIds.length
      ? await ctx.client
          .from('tour_deposits')
          .select('id, booking_id, amount, method, status')
          .in('booking_id', bookIds)
      : { data: [], error: null };
    const bySlot: Record<string, TourBooking[]> = {};
    for (const raw of (books.data ?? []) as { slot_id: string }[]) {
      (bySlot[raw.slot_id] ??= []).push(...parseTourBookings([raw]));
    }
    const tillList = (tills.data ?? []) as { id: string; name: string }[];
    return {
      slots: parsed,
      bookings: bySlot,
      deposits: parseTourDeposits(deps.data),
      staff: (staff.data ?? []) as { id: string; display_name: string }[],
      tills: tillList,
      till: tillList[0]?.id ?? null,
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
      p: {
        booking_id: dep.id,
        amount,
        method: dep.method,
        ...(dep.method === 'cash' ? { device_id: dep.till || d?.till } : {}),
      },
    });
    if (r.error) return fail(r.error.code);
    setDep(null);
    reload();
  };
  const settle = async (x: TourDeposit, action: 'forfeit' | 'refund') => {
    setMsg(null);
    const r = await ctx.client.rpc('resolve_tour_deposit', {
      p: {
        deposit_id: x.id,
        action,
        ...(action === 'refund' && x.method === 'cash' ? { device_id: settleTill || d?.till } : {}),
      },
    });
    if (r.error) return fail(r.error.code);
    setMsg({ kind: 'success', text: t.touSettled });
    reload();
  };
  const saveReminder = async () => {
    if (!rem) return;
    setMsg(null);
    const r = await ctx.client.rpc('set_tour_contact', {
      p_booking: rem.id,
      p_email: rem.email.trim(),
    });
    if (r.error) {
      if (r.error.code === '22023') return setMsg({ kind: 'error', text: t.touRemindBad });
      return fail(r.error.code);
    }
    setMsg({ kind: 'success', text: t.touRemindSaved });
  };
  const showCode = async () => {
    if (!rem) return;
    setMsg(null);
    const r = await ctx.client.rpc('tour_guest_code', { p_booking: rem.id });
    if (r.error || typeof r.data !== 'string') return fail(r.error?.code);
    setRem({ ...rem, code: r.data });
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
                          {b.source === 'online' ? (
                            <span className="badge">{t.touOnline}</span>
                          ) : null}
                          {b.phone ? <span className="muted"> · {b.phone}</span> : null}
                          {b.depositDue > 0 ? (
                            <span className="muted">
                              {' '}
                              ·{' '}
                              {fmt(t.touDueOf, { got: money(b.deposit), due: money(b.depositDue) })}
                            </span>
                          ) : b.deposit > 0 ? (
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
                                <button
                                  type="button"
                                  className="btn btn-secondary"
                                  onClick={() =>
                                    setRem(
                                      rem?.id === b.id ? null : { id: b.id, email: '', code: null },
                                    )
                                  }
                                >
                                  {t.touRemind}
                                </button>
                                {canTake ? (
                                  <button
                                    type="button"
                                    className="btn btn-secondary"
                                    onClick={() =>
                                      setDep({
                                        id: b.id,
                                        amount:
                                          b.depositDue > b.deposit
                                            ? String((b.depositDue - b.deposit) / 100)
                                            : '',
                                        method: 'promptpay',
                                        till: d?.till ?? '',
                                      })
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
                          {rem?.id === b.id ? (
                            <div className="form-inline">
                              {field(
                                `rem-e-${b.id}`,
                                t.touRemindEmail,
                                <input
                                  id={`rem-e-${b.id}`}
                                  type="email"
                                  inputMode="email"
                                  maxLength={120}
                                  value={rem.email}
                                  onChange={(e) => setRem({ ...rem, email: e.target.value })}
                                />,
                              )}
                              <AsyncButton onClick={saveReminder}>{t.touRemindSave}</AsyncButton>
                              {b.source === 'staff' ? (
                                <AsyncButton variant="secondary" onClick={showCode}>
                                  {t.touRemindCode}
                                </AsyncButton>
                              ) : null}
                              {rem.code ? (
                                <p role="status">
                                  <strong className="tabular">
                                    {fmt(t.touRemindCodeText, { code: rem.code })}
                                  </strong>
                                </p>
                              ) : null}
                            </div>
                          ) : null}
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
                                        e.target.value === 'gateway'
                                          ? 'gateway'
                                          : e.target.value === 'cash'
                                            ? 'cash'
                                            : 'promptpay',
                                    })
                                  }
                                >
                                  <option value="promptpay">{t.touPromptPay}</option>
                                  <option value="gateway">{t.touCard}</option>
                                  <option value="cash">{t.touCash}</option>
                                </select>,
                              )}
                              {dep.method === 'cash'
                                ? field(
                                    `dep-t-${b.id}`,
                                    t.touTill,
                                    <select
                                      id={`dep-t-${b.id}`}
                                      value={dep.till}
                                      onChange={(e) => setDep({ ...dep, till: e.target.value })}
                                    >
                                      {(d?.tills ?? []).map((x) => (
                                        <option key={x.id} value={x.id}>
                                          {x.name}
                                        </option>
                                      ))}
                                    </select>,
                                  )
                                : null}
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
      {canRefund && d ? (
        <HeldDeposits
          rows={heldOfCancelled(d.slots, d.bookings, d.deposits)}
          tills={d.tills}
          till={settleTill || d.till || ''}
          onTill={setSettleTill}
          onSettle={settle}
          money={money}
        />
      ) : null}
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
      {canEdit && storeId ? <TourLinkPanel ctx={ctx} storeId={storeId} /> : null}
    </div>
  );
}

type HeldRow = { deposit: TourDeposit; guest: string; tour: string };
/** The deposits still held for bookings that were cancelled or did not show: a manager keeps them as a fee or gives them back. */
function heldOfCancelled(
  slots: TourSlot[],
  bookings: Record<string, TourBooking[]>,
  deposits: TourDeposit[],
): HeldRow[] {
  const out: HeldRow[] = [];
  for (const s of slots) {
    for (const b of bookings[s.id] ?? []) {
      if (b.status !== 'cancelled' && b.status !== 'no_show') continue;
      for (const x of deposits)
        if (x.bookingId === b.id && x.status === 'held')
          out.push({ deposit: x, guest: b.guestName, tour: guestName(s.title, 'th') });
    }
  }
  return out;
}

function HeldDeposits({
  rows,
  tills,
  till,
  onTill,
  onSettle,
  money,
}: {
  rows: HeldRow[];
  tills: { id: string; name: string }[];
  till: string;
  onTill: (v: string) => void;
  onSettle: (x: TourDeposit, a: 'forfeit' | 'refund') => Promise<void>;
  money: (n: number) => string;
}) {
  const { t } = useI18n();
  if (rows.length === 0) return null;
  return (
    <section className="card admin-card" aria-label={t.touHeldTitle}>
      <h2>{t.touHeldTitle}</h2>
      {rows.some((r) => r.deposit.method === 'cash') ? (
        <div className="form-row">
          <label className="label" htmlFor="tou-settle-till">
            {t.touTill}
          </label>
          <select id="tou-settle-till" value={till} onChange={(e) => onTill(e.target.value)}>
            {tills.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <ul className="member-list">
        {rows.map((r) => (
          <li key={r.deposit.id}>
            <strong>{r.guest}</strong> · {r.tour} · {money(r.deposit.amount)}{' '}
            <span className="badge">
              {r.deposit.method === 'cash'
                ? t.touCash
                : r.deposit.method === 'gateway'
                  ? t.touCard
                  : t.touPromptPay}
            </span>
            <div className="actions">
              <AsyncButton variant="secondary" onClick={() => onSettle(r.deposit, 'forfeit')}>
                {t.touKeep}
              </AsyncButton>
              <AsyncButton variant="secondary" onClick={() => onSettle(r.deposit, 'refund')}>
                {t.touRefund}
              </AsyncButton>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
