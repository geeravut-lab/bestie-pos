import { useEffect, useState } from 'react';
import {
  FOLIO_SETTLE_METHODS,
  folioBalance,
  formatTHB,
  parseFolioCharges,
  parseFolioRooms,
  parseStays,
  statementLines,
} from '@bestie/core';
import { folioNights } from '@bestie/core';
import type { FolioCharge, FolioRoom, FolioSettleMethod, Stay } from '@bestie/core';
import { fmt, formatDateTime, useI18n } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice, useLiveSync } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { PrintPortal } from './PrintPortal';
import { tx } from './stockInput';
import { useRemote } from './useRemote';

type Loaded = {
  rooms: FolioRoom[];
  stays: Stay[];
  charges: FolioCharge[];
  shops: Record<string, string>;
  tills: { id: string; name: string }[];
  settlements: { folioId: string; amount: number; method: string }[];
  shopName: string;
};
type CheckIn = {
  roomId: string;
  guest: string;
  phone: string;
  outOn: string;
  note: string;
  rate: string;
};

/** Baht typed by a person → satang, or null when empty; NaN when it is not a number. */
const bahtToSatang = (v: string): number | null => {
  const x = v.trim().replace(',', '.');
  if (x === '') return null;
  const n = Number(x);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : Number.NaN;
};
const satangToBaht = (n: number | null): string => (n == null ? '' : String(n / 100));

/** Phase 4: rooms, guests in the house, the charges on each stay, and check-out (module `folio`, Resort plan). */
export function FolioPage({ ctx }: { ctx: PageContext }) {
  const { t, lang } = useI18n();
  const locale = lang === 'th' ? ('th-TH' as const) : ('en-GB' as const);
  const money = (n: number) => formatTHB(n, locale);
  const storeId = ctx.storeId ?? ctx.homeStoreId ?? null;
  const canEdit = ctx.isOwner || ctx.permissions.includes('menu.edit');
  const canDesk = ctx.isOwner || ctx.permissions.includes('order.create');
  const canPay = ctx.isOwner || ctx.permissions.includes('payment.take');
  const canVoid = ctx.isOwner || ctx.permissions.includes('refund.create');
  const [msg, setMsg] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);
  const [roomName, setRoomName] = useState<string | null>(null);
  const [inForm, setInForm] = useState<CheckIn | null>(null);
  const [settling, setSettling] = useState<{
    id: string;
    method: FolioSettleMethod;
    till: string;
    ref: string;
  } | null>(null);
  const [voiding, setVoiding] = useState<{ id: string; reason: string } | null>(null);
  const [roomRate, setRoomRate] = useState('');
  const [rateEdit, setRateEdit] = useState<{ id: string; value: string } | null>(null);
  const [printing, setPrinting] = useState<string | null>(null);
  useEffect(() => {
    if (!printing) return;
    const id = window.setTimeout(() => {
      window.print();
      setPrinting(null);
    }, 60);
    return () => window.clearTimeout(id);
  }, [printing]);

  const data = useRemote<Loaded>(async () => {
    if (!storeId) throw new Error('shop');
    const [rooms, stays, charges, shops, tills, settlements] = await Promise.all([
      ctx.client
        .from('folio_rooms')
        .select('id, store_id, name, active, sort, night_rate')
        .eq('store_id', storeId)
        .order('sort'),
      ctx.client
        .from('folios')
        .select(
          'id, room_id, guest_name, phone, check_in_at, check_out_on, note, status, closed_at, night_rate',
        )
        .eq('store_id', storeId)
        .order('check_in_at', { ascending: false })
        .limit(60),
      ctx.client
        .from('folio_charges')
        .select(
          'id, folio_id, store_id, kind, order_id, night_date, amount, receipt_number, voided_at, void_reason, created_at',
        )
        .order('created_at')
        .limit(500),
      ctx.client.from('stores').select('id, name'),
      ctx.client
        .from('devices')
        .select('id, name')
        .eq('store_id', storeId)
        .eq('active', true)
        .eq('role', 'cashier')
        .order('name'),
      ctx.client.from('folio_settlements').select('folio_id, amount, method').limit(200),
    ]);
    if (rooms.error || stays.error) throw new Error('load');
    const names: Record<string, string> = {};
    for (const s of (shops.data ?? []) as { id?: string; name?: string }[])
      if (s.id && s.name) names[s.id] = s.name;
    return {
      rooms: parseFolioRooms(rooms.data),
      stays: parseStays(stays.data),
      charges: charges.error ? [] : parseFolioCharges(charges.data),
      shops: names,
      tills: tills.error ? [] : ((tills.data ?? []) as { id: string; name: string }[]),
      settlements: settlements.error
        ? []
        : ((settlements.data ?? []) as { folio_id: string; amount: number; method: string }[]).map(
            (x) => ({ folioId: x.folio_id, amount: Number(x.amount), method: String(x.method) }),
          ),
      shopName:
        ((shops.data ?? []) as { id?: string; name?: string }[]).find((x) => x.id === storeId)
          ?.name ?? '',
    };
  }, storeId ?? '');
  const { reload } = data;
  useLiveSync(ctx.client, [`org:${ctx.orgId}`], reload);
  if (!storeId) return <Notice kind="error">{t.err_load_failed}</Notice>;
  const d = data.data;
  const roomOf = (id: string) => d?.rooms.find((r) => r.id === id)?.name ?? '';
  const open = (d?.stays ?? []).filter((s) => s.status === 'open');
  const closed = (d?.stays ?? []).filter((s) => s.status === 'closed').slice(0, 10);
  const freeRooms = (d?.rooms ?? []).filter(
    (r) => r.active && !open.some((s) => s.roomId === r.id),
  );

  const fail = (code?: string) =>
    setMsg({
      kind: 'error',
      text:
        code === '42501'
          ? t.err_forbidden
          : code === '55000'
            ? t.foStatBusy
            : code === '22023'
              ? t.foInvalid
              : t.err_save_failed,
    });
  const saveRoom = async () => {
    const name = (roomName ?? '').trim();
    if (!name || name.length > 40) return setMsg({ kind: 'error', text: t.foRoomInvalid });
    setMsg(null);
    const rate = bahtToSatang(roomRate);
    if (Number.isNaN(rate)) return setMsg({ kind: 'error', text: t.foInvalid });
    const r = await ctx.client.rpc('save_folio_room', {
      p: { store_id: storeId, name, sort: (d?.rooms.length ?? 0) + 1, night_rate: rate },
    });
    if (r.error)
      return setMsg({
        kind: 'error',
        text:
          r.error.code === '23505'
            ? t.foRoomInvalid
            : r.error.code === '42501'
              ? t.err_forbidden
              : t.err_save_failed,
      });
    setRoomName(null);
    setRoomRate('');
    reload();
  };
  const saveRate = async () => {
    if (!rateEdit) return;
    const rate = bahtToSatang(rateEdit.value);
    if (Number.isNaN(rate)) return setMsg({ kind: 'error', text: t.foInvalid });
    setMsg(null);
    const r = await ctx.client.rpc('save_folio_room', {
      p: { store_id: storeId, id: rateEdit.id, night_rate: rate },
    });
    if (r.error) return fail(r.error.code);
    setRateEdit(null);
    reload();
  };
  const postNights = async (folioId: string) => {
    setMsg(null);
    const r = await ctx.client.rpc('folio_post_nights', { p_folio: folioId });
    if (r.error) return fail(r.error.code);
    const n = typeof r.data === 'number' ? r.data : 0;
    setMsg({ kind: 'info', text: n > 0 ? fmt(t.foNightsPosted, { n }) : t.foNightsNone });
    reload();
  };
  const checkIn = async () => {
    if (!inForm) return;
    const rate = bahtToSatang(inForm.rate);
    if (!inForm.roomId || !inForm.guest.trim() || Number.isNaN(rate))
      return setMsg({ kind: 'error', text: t.foInvalid });
    setMsg(null);
    const r = await ctx.client.rpc('folio_check_in', {
      p: {
        store_id: storeId,
        room_id: inForm.roomId,
        guest_name: inForm.guest.trim(),
        phone: inForm.phone.trim() || null,
        check_out_on: inForm.outOn || null,
        note: inForm.note.trim() || null,
        night_rate: rate,
      },
    });
    if (r.error) return fail(r.error.code);
    setInForm(null);
    reload();
  };
  const settle = async () => {
    if (!settling) return;
    const stay = open.find((s) => s.id === settling.id);
    const due = folioBalance((d?.charges ?? []).filter((c) => c.folioId === settling.id));
    if (!stay) return;
    setMsg(null);
    const r = await ctx.client.rpc('folio_settle', {
      p: {
        folio_id: settling.id,
        method: due === 0 ? 'none' : settling.method,
        device_id: settling.method === 'cash' ? settling.till || null : null,
        reference: settling.ref.trim() || null,
      },
    });
    if (r.error) return fail(r.error.code);
    setSettling(null);
    setMsg({ kind: 'info', text: t.foSettled });
    reload();
  };
  const voidCharge = async () => {
    if (!voiding) return;
    setMsg(null);
    const r = await ctx.client.rpc('folio_void_charge', {
      p_charge: voiding.id,
      p_reason: voiding.reason.trim(),
    });
    if (r.error) return fail(r.error.code);
    setVoiding(null);
    reload();
  };

  return (
    <div className="admin-page">
      <h1>{t.foTitle}</h1>
      <Notice kind="info">{t.foIntro}</Notice>
      {msg ? <Notice kind={msg.kind}>{msg.text}</Notice> : null}
      {data.status === 'loading' ? (
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      ) : null}
      {data.status === 'error' ? <Notice kind="error">{t.err_load_failed}</Notice> : null}

      <section className="card admin-card" aria-label={t.foInHouse}>
        <h2>{t.foInHouse}</h2>
        {d && open.length === 0 ? <p className="muted">{t.foNoStays}</p> : null}
        <ul className="member-list">
          {open.map((s) => {
            const mine = (d?.charges ?? []).filter((c) => c.folioId === s.id);
            const due = folioBalance(mine);
            return (
              <li key={s.id} className="member-row">
                <div className="member-head">
                  <strong>{roomOf(s.roomId)}</strong>
                  <span>{s.guestName}</span>
                  <span className="badge">
                    {t.foBalance}: {money(due)}
                  </span>
                </div>
                {s.checkOutOn || s.phone || s.nightRate ? (
                  <p className="muted">
                    {[
                      s.phone,
                      s.checkOutOn,
                      s.nightRate ? fmt(t.foRateLine, { price: money(s.nightRate) }) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                ) : null}
                {mine.length === 0 ? <p className="muted">{t.foChargesNone}</p> : null}
                <ul>
                  {mine.map((c) => (
                    <li key={c.id}>
                      <span style={c.voided ? { textDecoration: 'line-through' } : undefined}>
                        {c.kind === 'night'
                          ? `${fmt(t.foNightLine, { date: c.nightDate })} · ${money(c.amount)}`
                          : c.kind === 'return'
                            ? `${formatDateTime(lang, c.createdAt)} · ${fmt(t.foReturnLine, { ref: '' })}${money(c.amount)}`
                            : `${formatDateTime(lang, c.createdAt)} · ${d?.shops[c.storeId] ?? ''} · ${c.receiptNumber ?? ''} · ${money(c.amount)}`}
                      </span>
                      {c.voided ? (
                        <em> {fmt(t.foVoided, { reason: c.voidReason ?? '' })}</em>
                      ) : null}
                      {!c.voided && canVoid && c.kind !== 'return' ? (
                        <>
                          {' '}
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => setVoiding({ id: c.id, reason: '' })}
                          >
                            {t.foVoidCharge}
                          </button>
                        </>
                      ) : null}
                    </li>
                  ))}
                </ul>
                {voiding && mine.some((c) => c.id === voiding.id) ? (
                  <div className="form-row">
                    <label className="label" htmlFor="fo-void">
                      {t.foVoidReason}
                    </label>
                    <input
                      id="fo-void"
                      className="field"
                      maxLength={200}
                      value={voiding.reason}
                      onChange={(e) => setVoiding({ ...voiding, reason: e.target.value })}
                    />
                    <AsyncButton variant="secondary" onClick={voidCharge}>
                      {t.foVoidDo}
                    </AsyncButton>
                  </div>
                ) : null}
                <div className="actions">
                  {canPay && s.nightRate ? (
                    <AsyncButton variant="secondary" onClick={() => postNights(s.id)}>
                      {t.foPostNights}
                    </AsyncButton>
                  ) : null}
                  <AsyncButton variant="secondary" onClick={async () => setPrinting(s.id)}>
                    {t.foPrintFolio}
                  </AsyncButton>
                </div>
                {canPay ? (
                  <div className="actions">
                    <AsyncButton
                      variant="secondary"
                      onClick={async () => {
                        // the nights that have passed belong on the bill before the guest is shown what is due
                        if (s.nightRate)
                          await ctx.client.rpc('folio_post_nights', { p_folio: s.id });
                        reload();
                        setSettling({
                          id: s.id,
                          method: 'transfer',
                          till: d?.tills[0]?.id ?? '',
                          ref: '',
                        });
                      }}
                    >
                      {t.foCheckOutBtn}
                    </AsyncButton>
                  </div>
                ) : null}
                {settling?.id === s.id ? (
                  <form
                    className="card admin-card auth-form"
                    onSubmit={(e) => e.preventDefault()}
                    aria-label={fmt(t.foSettleTitle, {
                      guest: s.guestName,
                      room: roomOf(s.roomId),
                    })}
                  >
                    <h3>{fmt(t.foSettleTitle, { guest: s.guestName, room: roomOf(s.roomId) })}</h3>
                    <p>
                      {t.foSettleDue}: <strong>{money(due)}</strong>
                    </p>
                    {due > 0 ? (
                      <>
                        <div className="form-row">
                          <label className="label" htmlFor="fo-method">
                            {t.foMethod}
                          </label>
                          <select
                            id="fo-method"
                            className="field"
                            value={settling.method}
                            onChange={(e) =>
                              setSettling({
                                ...settling,
                                method: e.target.value as FolioSettleMethod,
                              })
                            }
                          >
                            {FOLIO_SETTLE_METHODS.map((m) => (
                              <option key={m} value={m}>
                                {tx(t, `foMethod${m[0]!.toUpperCase()}${m.slice(1)}`)}
                              </option>
                            ))}
                          </select>
                        </div>
                        {settling.method === 'cash' ? (
                          <div className="form-row">
                            <label className="label" htmlFor="fo-till">
                              {t.foTill}
                            </label>
                            <select
                              id="fo-till"
                              className="field"
                              value={settling.till}
                              onChange={(e) => setSettling({ ...settling, till: e.target.value })}
                            >
                              {(d?.tills ?? []).map((x) => (
                                <option key={x.id} value={x.id}>
                                  {x.name}
                                </option>
                              ))}
                            </select>
                          </div>
                        ) : null}
                        <div className="form-row">
                          <label className="label" htmlFor="fo-ref">
                            {t.foRef}
                          </label>
                          <input
                            id="fo-ref"
                            className="field"
                            maxLength={100}
                            value={settling.ref}
                            onChange={(e) => setSettling({ ...settling, ref: e.target.value })}
                          />
                        </div>
                      </>
                    ) : null}
                    <div className="actions">
                      <AsyncButton type="submit" onClick={settle}>
                        {due > 0 ? t.foSettle : t.foSettleNone}
                      </AsyncButton>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => setSettling(null)}
                      >
                        {t.menuCancel}
                      </button>
                    </div>
                  </form>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>

      {canDesk ? (
        inForm ? (
          <form
            className="card admin-card auth-form"
            onSubmit={(e) => e.preventDefault()}
            aria-label={t.foCheckIn}
          >
            <h2>{t.foCheckIn}</h2>
            <div className="form-row">
              <label className="label" htmlFor="fo-room">
                {t.foRoom}
              </label>
              <select
                id="fo-room"
                className="field"
                value={inForm.roomId}
                onChange={(e) =>
                  setInForm({
                    ...inForm,
                    roomId: e.target.value,
                    rate: satangToBaht(
                      d?.rooms.find((r) => r.id === e.target.value)?.nightRate ?? null,
                    ),
                  })
                }
              >
                {freeRooms.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-row">
              <label className="label" htmlFor="fo-guest">
                {t.foGuest}
              </label>
              <input
                id="fo-guest"
                className="field"
                maxLength={80}
                value={inForm.guest}
                onChange={(e) => setInForm({ ...inForm, guest: e.target.value })}
              />
            </div>
            <div className="form-row">
              <label className="label" htmlFor="fo-phone">
                {t.foPhone}
              </label>
              <input
                id="fo-phone"
                className="field"
                inputMode="tel"
                maxLength={30}
                value={inForm.phone}
                onChange={(e) => setInForm({ ...inForm, phone: e.target.value })}
              />
            </div>
            <div className="form-row">
              <label className="label" htmlFor="fo-out">
                {t.foOutOn}
              </label>
              <input
                id="fo-out"
                className="field"
                type="date"
                value={inForm.outOn}
                onChange={(e) => setInForm({ ...inForm, outOn: e.target.value })}
              />
            </div>
            <div className="form-row">
              <label className="label" htmlFor="fo-rate">
                {t.foNightRate}
              </label>
              <input
                id="fo-rate"
                className="field"
                inputMode="decimal"
                value={inForm.rate}
                onChange={(e) => setInForm({ ...inForm, rate: e.target.value })}
              />
            </div>
            <div className="form-row">
              <label className="label" htmlFor="fo-note">
                {t.foNote}
              </label>
              <input
                id="fo-note"
                className="field"
                maxLength={300}
                value={inForm.note}
                onChange={(e) => setInForm({ ...inForm, note: e.target.value })}
              />
            </div>
            <div className="actions">
              <AsyncButton type="submit" onClick={checkIn}>
                {t.foSaveIn}
              </AsyncButton>
              <button type="button" className="btn btn-secondary" onClick={() => setInForm(null)}>
                {t.menuCancel}
              </button>
            </div>
          </form>
        ) : (
          <div className="actions">
            {freeRooms.length === 0 && d ? <p className="muted">{t.foNoFree}</p> : null}
            <AsyncButton
              variant="secondary"
              onClick={async () =>
                setInForm({
                  roomId: freeRooms[0]?.id ?? '',
                  guest: '',
                  phone: '',
                  outOn: '',
                  note: '',
                  rate: satangToBaht(freeRooms[0]?.nightRate ?? null),
                })
              }
            >
              {t.foCheckIn}
            </AsyncButton>
          </div>
        )
      ) : null}

      <section className="card admin-card" aria-label={t.foRooms}>
        <h2>{t.foRooms}</h2>
        <ul className="member-list">
          {(d?.rooms ?? []).map((r) => (
            <li key={r.id} className="member-row">
              <div className="member-head">
                <strong>{r.name}</strong>
                {r.nightRate ? (
                  <span className="muted">{fmt(t.foRateLine, { price: money(r.nightRate) })}</span>
                ) : null}
                {!r.active ? <span className="muted">{t.foRoomOff}</span> : null}
              </div>
              {canEdit ? (
                rateEdit?.id === r.id ? (
                  <div className="form-row">
                    <label className="label" htmlFor={`fo-rate-${r.id}`}>
                      {t.foNightRate}
                    </label>
                    <input
                      id={`fo-rate-${r.id}`}
                      className="field"
                      inputMode="decimal"
                      value={rateEdit.value}
                      onChange={(e) => setRateEdit({ id: r.id, value: e.target.value })}
                    />
                    <AsyncButton variant="secondary" onClick={saveRate}>
                      {t.foSaveRoom}
                    </AsyncButton>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => setRateEdit({ id: r.id, value: satangToBaht(r.nightRate) })}
                  >
                    {t.foNightRate}
                  </button>
                )
              ) : null}
            </li>
          ))}
        </ul>
        {canEdit ? (
          roomName !== null ? (
            <form
              className="auth-form"
              onSubmit={(e) => e.preventDefault()}
              aria-label={t.foAddRoom}
            >
              <div className="form-row">
                <label className="label" htmlFor="fo-rname">
                  {t.foRoomName}
                </label>
                <input
                  id="fo-rname"
                  className="field"
                  maxLength={40}
                  value={roomName}
                  onChange={(e) => setRoomName(e.target.value)}
                />
              </div>
              <div className="form-row">
                <label className="label" htmlFor="fo-rrate">
                  {t.foNightRate}
                </label>
                <input
                  id="fo-rrate"
                  className="field"
                  inputMode="decimal"
                  value={roomRate}
                  onChange={(e) => setRoomRate(e.target.value)}
                />
              </div>
              <div className="actions">
                <AsyncButton type="submit" onClick={saveRoom}>
                  {t.foSaveRoom}
                </AsyncButton>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setRoomName(null)}
                >
                  {t.menuCancel}
                </button>
              </div>
            </form>
          ) : (
            <div className="actions">
              <AsyncButton variant="secondary" onClick={async () => setRoomName('')}>
                {t.foAddRoom}
              </AsyncButton>
            </div>
          )
        ) : null}
      </section>

      {closed.length > 0 ? (
        <section className="card admin-card" aria-label={t.foClosed}>
          <h2>{t.foClosed}</h2>
          <ul>
            {closed.map((s) => (
              <li key={s.id}>
                {roomOf(s.roomId)} · {s.guestName} ·{' '}
                {s.closedAt ? formatDateTime(lang, s.closedAt) : ''} ·{' '}
                {money(folioBalance((d?.charges ?? []).filter((c) => c.folioId === s.id)))}{' '}
                <button type="button" className="link-button" onClick={() => setPrinting(s.id)}>
                  {t.foPrintFolio}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {printing && d
        ? (() => {
            const stay = d.stays.find((x) => x.id === printing);
            if (!stay) return null;
            const lines = statementLines(d.charges.filter((c) => c.folioId === stay.id));
            const settled = d.settlements.find((x) => x.folioId === stay.id);
            return (
              <PrintPortal pageCss="@page { size: A4; margin: 15mm; }">
                <div className="folio-statement">
                  <h1>{d.shopName}</h1>
                  <h2>{t.foStmtTitle}</h2>
                  <dl className="kv">
                    <dt>{t.foStmtGuest}</dt>
                    <dd>{stay.guestName}</dd>
                    <dt>{t.foStmtRoom}</dt>
                    <dd>{roomOf(stay.roomId)}</dd>
                    <dt>{t.foStmtIn}</dt>
                    <dd>{formatDateTime(lang, stay.checkInAt)}</dd>
                    <dt>{t.foStmtOut}</dt>
                    <dd>
                      {stay.closedAt
                        ? formatDateTime(lang, stay.closedAt)
                        : (stay.checkOutOn ?? '')}
                    </dd>
                    <dt>{t.foStmtNights}</dt>
                    <dd>{folioNights(lines)}</dd>
                  </dl>
                  <table className="folio-lines">
                    <caption>{t.foStmtLines}</caption>
                    <tbody>
                      {lines.map((c) => (
                        <tr
                          key={c.id}
                          style={c.voided ? { textDecoration: 'line-through' } : undefined}
                        >
                          <td>
                            {c.kind === 'night'
                              ? fmt(t.foNightLine, { date: c.nightDate })
                              : c.kind === 'return'
                                ? `${fmt(t.foReturnLine, { ref: '' })}${formatDateTime(lang, c.createdAt)}`
                                : `${formatDateTime(lang, c.createdAt)} · ${d.shops[c.storeId] ?? ''} · ${c.receiptNumber ?? ''}`}
                            {c.voided ? ` (${t.foStmtVoided})` : ''}
                          </td>
                          <td className="tabular">{money(c.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <th>{t.foStmtTotal}</th>
                        <th className="tabular">{money(folioBalance(lines))}</th>
                      </tr>
                    </tfoot>
                  </table>
                  <p>
                    {settled
                      ? fmt(t.foStmtSettled, {
                          method:
                            settled.method === 'none'
                              ? t.foSettleNone
                              : tx(
                                  t,
                                  `foMethod${settled.method[0]!.toUpperCase()}${settled.method.slice(1)}`,
                                ),
                        })
                      : t.foStmtOpen}
                  </p>
                  <p className="muted">{t.foStmtNote}</p>
                  <p className="signature">{t.foStmtSign}: ______________________</p>
                </div>
              </PrintPortal>
            );
          })()
        : null}
    </div>
  );
}
