import { useEffect, useRef, useState } from 'react';
import { addDays, bangkokParts, formatTHB, karaokeAmount, karaokeDepositFor } from '@bestie/core';
import type { KaraokeBookingInfo } from '@bestie/core';
import { GUEST_LANGS, fmt, useI18n } from '@bestie/i18n';
import { AsyncButton, LangSwitch, Spinner } from '@bestie/ui';
import {
  cancelKaraokeBooking,
  loadKaraokeBookStatus,
  loadKaraokeBooking,
  loadKaraokeSlots,
  sendKaraokeBooking,
} from './karaokeBookApi';
import type { KaraokeBookLoad, KaraokeBookOutcome } from './karaokeBookApi';

type Done = {
  id: string;
  code: string | null;
  startsAt: string;
  minutes: number;
  room: string;
  depositDue: number;
  holdUntil: string | null;
};
const SAVED = (token: string) => `bestie.kbook.${token}`;

function readSaved(token: string): Done | null {
  try {
    const o = JSON.parse(
      globalThis.localStorage?.getItem(SAVED(token)) ?? 'null',
    ) as Partial<Done> | null;
    if (
      o &&
      typeof o.id === 'string' &&
      typeof o.startsAt === 'string' &&
      Date.parse(o.startsAt) > Date.now()
    )
      return {
        id: o.id,
        code: o.code ?? null,
        startsAt: o.startsAt,
        minutes: o.minutes ?? 0,
        room: o.room ?? '',
        depositDue: o.depositDue ?? 0,
        holdUntil: o.holdUntil ?? null,
      };
  } catch {
    /* private mode or a broken value: no saved booking */
  }
  return null;
}
function writeSaved(token: string, d: Done | null): void {
  try {
    if (d) globalThis.localStorage?.setItem(SAVED(token), JSON.stringify(d));
    else globalThis.localStorage?.removeItem(SAVED(token));
  } catch {
    /* private mode */
  }
}

function whenLabel(iso: string, lang: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(lang === 'th' ? 'th-TH' : 'en-GB', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: 'Asia/Bangkok',
  }).format(d);
}
const timeOnly = (iso: string, lang: string): string =>
  new Intl.DateTimeFormat(lang === 'th' ? 'th-TH' : 'en-GB', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Asia/Bangkok',
  }).format(new Date(iso));

/** The guest's page for a karaoke shop's booking link (`/kb/<token>`): room → length → day → start time → details → done (cancel code + the deposit to pay). */
export function KaraokeBookPage({ token }: { token: string }) {
  const { t, lang } = useI18n();
  const [load, setLoad] = useState<KaraokeBookLoad | null>(null);
  const [done, setDone] = useState<Done | null>(() => readSaved(token));

  useEffect(() => {
    let alive = true;
    void loadKaraokeBooking(token).then((r) => alive && setLoad(r));
    return () => {
      alive = false;
    };
  }, [token]);

  const head = (
    <div className="guest-head">
      <h1>{load?.ok ? load.info.storeName : t.kbkTitle}</h1>
      <LangSwitch langs={GUEST_LANGS} />
    </div>
  );
  if (!load)
    return (
      <div className="guest-page">
        {head}
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      </div>
    );
  if (!load.ok)
    return (
      <div className="guest-page">
        {head}
        <p role="alert">{load.reason === 'not_found' ? t.bkNotFound : t.err_load_failed}</p>
      </div>
    );
  const info = load.info;
  if (!info.open)
    return (
      <div className="guest-page">
        {head}
        <p>{t.bkClosed}</p>
      </div>
    );
  return (
    <div className="guest-page">
      {head}
      {done ? (
        <DonePanel
          token={token}
          done={done}
          payNote={info.settings.payNote}
          lang={lang}
          onAgain={() => {
            setDone(null);
            writeSaved(token, null);
          }}
        />
      ) : (
        <Form
          token={token}
          info={info}
          onBooked={(d) => {
            writeSaved(token, d);
            setDone(d);
          }}
        />
      )}
    </div>
  );
}

function DonePanel({
  token,
  done,
  payNote,
  lang,
  onAgain,
}: {
  token: string;
  done: Done;
  payNote: string;
  lang: string;
  onAgain: () => void;
}) {
  const { t } = useI18n();
  const [paid, setPaid] = useState(0);
  const [state, setState] = useState<'booked' | 'cancelled' | 'released'>('booked');
  const [problem, setProblem] = useState(false);
  const code = done.code;
  const check = async () => {
    if (!code) return;
    const r = await loadKaraokeBookStatus(token, done.id, code);
    if (!r.ok) return;
    setPaid(r.depositPaid);
    if (r.status === 'cancelled') setState((s) => (s === 'cancelled' ? s : 'released'));
  };
  const cancel = async () => {
    setProblem(false);
    if (!code) return;
    const r = await cancelKaraokeBooking(token, done.id, code);
    if (r.ok) {
      setState('cancelled');
      writeSaved(token, null);
    } else setProblem(true);
  };
  useEffect(() => {
    if (!code) return;
    let alive = true;
    void loadKaraokeBookStatus(token, done.id, code).then((r) => {
      if (!alive || !r.ok) return;
      setPaid(r.depositPaid);
      if (r.status === 'cancelled') setState('released');
    });
    return () => {
      alive = false;
    };
  }, [token, done.id, code]);

  const needDeposit = done.depositDue > 0;
  const heading =
    state === 'cancelled' ? t.bkCancelled : state === 'released' ? t.kbkReleased : t.bkDoneTitle;
  return (
    <section className="card" aria-live="polite">
      <h2>{heading}</h2>
      {state === 'booked' ? (
        <>
          <dl className="kv">
            <dt>{t.bkDoneWhen}</dt>
            <dd>{whenLabel(done.startsAt, lang)}</dd>
            <dt>{t.kbkRoom}</dt>
            <dd>
              {done.room} · {fmt(t.bkMinutes, { n: done.minutes })}
            </dd>
            {code ? (
              <>
                <dt>{t.bkCodeLabel}</dt>
                <dd>
                  <strong className="tabular">{code}</strong>
                </dd>
              </>
            ) : null}
          </dl>
          {needDeposit ? (
            paid >= done.depositDue ? (
              <p role="status">{t.kbkDepositPaid}</p>
            ) : (
              <div className="card" aria-label={t.kbkDepositTitle}>
                <h3>{t.kbkDepositTitle}</h3>
                <p>
                  <strong className="tabular">{formatTHB(done.depositDue)}</strong>
                </p>
                {done.holdUntil ? (
                  <p>{fmt(t.kbkDepositHold, { when: timeOnly(done.holdUntil, lang) })}</p>
                ) : null}
                {payNote ? <p>{payNote}</p> : <p className="muted">{t.kbkDepositAsk}</p>}
                <p className="muted">
                  {fmt(t.kbkDepositSoFar, {
                    paid: formatTHB(paid),
                    due: formatTHB(done.depositDue),
                  })}
                </p>
                {code ? (
                  <AsyncButton variant="secondary" onClick={check}>
                    {t.kbkDepositCheck}
                  </AsyncButton>
                ) : null}
              </div>
            )
          ) : null}
          <p className="muted">{t.bkDoneNote}</p>
          {needDeposit ? <p className="muted">{t.kbkCancelNote}</p> : null}
          {problem ? <p role="alert">{t.bkCancelClosed}</p> : null}
          {code ? (
            <AsyncButton variant="secondary" onClick={cancel}>
              {t.bkCancel}
            </AsyncButton>
          ) : null}
        </>
      ) : null}
      <div className="actions">
        <button type="button" className="btn btn-primary" onClick={onAgain}>
          {t.bkBookAnother}
        </button>
      </div>
    </section>
  );
}

function Form({
  token,
  info,
  onBooked,
}: {
  token: string;
  info: Extract<KaraokeBookingInfo, { open: true }>;
  onBooked: (d: Done) => void;
}) {
  const { t, lang } = useI18n();
  const today = bangkokParts(new Date().toISOString()).date;
  const last = addDays(today, info.settings.maxDays);
  const [roomId, setRoomId] = useState('');
  const [minutes, setMinutes] = useState(0);
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [guests, setGuests] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<KaraokeBookOutcome | null>(null);
  const [slots, setSlots] = useState<{ key: string; list: string[] | null } | null>(null);
  const clientId = useRef(crypto.randomUUID());
  const key = `${roomId}|${minutes}|${date}`;
  const room = info.rooms.find((r) => r.id === roomId);

  useEffect(() => {
    if (!roomId || !minutes || !date) return;
    let alive = true;
    void loadKaraokeSlots(token, { room: roomId, date, minutes }).then(
      (list) => alive && setSlots({ key, list }),
    );
    return () => {
      alive = false;
    };
  }, [token, roomId, minutes, date, key]);

  const loading = !!roomId && !!minutes && !!date && slots?.key !== key;
  const list = slots?.key === key ? (slots.list ?? []) : [];
  const price = room && minutes ? karaokeAmount(room.ratePerHour, minutes) : 0;
  const deposit = karaokeDepositFor(price, info.settings.depositPct);

  const submit = async () => {
    setProblem(null);
    const g = Number.parseInt(guests, 10);
    const r = await sendKaraokeBooking(token, {
      roomId,
      date,
      time,
      minutes,
      name: name.trim(),
      phone: phone.trim(),
      guests: Number.isFinite(g) && g > 0 ? g : null,
      note: note.trim(),
      clientId: clientId.current,
    });
    if (r.ok) {
      clientId.current = crypto.randomUUID();
      return onBooked({
        id: r.id,
        code: r.code,
        startsAt: r.startsAt,
        minutes: r.minutes,
        room: r.room,
        depositDue: r.depositDue,
        holdUntil: r.holdUntil,
      });
    }
    setProblem(r);
    if (r.error === 'taken') {
      setTime('');
      setSlots(null);
      void loadKaraokeSlots(token, { room: roomId, date, minutes }).then((l) =>
        setSlots({ key, list: l }),
      );
    }
  };
  const errorText = (r: KaraokeBookOutcome): string =>
    r.ok
      ? ''
      : r.error === 'taken'
        ? t.bkTaken
        : r.error === 'invalid'
          ? t.bkInvalid
          : r.error === 'too_many'
            ? t.bkTooMany
            : t.bkFailed;
  const ready =
    !!roomId && !!minutes && !!date && !!time && name.trim().length > 0 && phone.trim().length >= 6;

  if (info.rooms.length === 0) return <p>{t.kbkNoRooms}</p>;
  return (
    <form className="auth-form" onSubmit={(e) => e.preventDefault()}>
      <fieldset className="card">
        <legend>{t.kbkStepRoom}</legend>
        {info.rooms.map((r) => (
          <label key={r.id} className="choice">
            <input
              type="radio"
              name="kb-room"
              checked={roomId === r.id}
              onChange={() => {
                setRoomId(r.id);
                setMinutes(r.lengths.includes(minutes) ? minutes : 0);
                setTime('');
              }}
            />{' '}
            {r.name} · {fmt(t.kbkPerHour, { price: formatTHB(r.ratePerHour) })}
          </label>
        ))}
      </fieldset>
      <fieldset className="card">
        <legend>{t.kbkStepLength}</legend>
        {room ? (
          <div className="actions">
            {room.lengths.map((m) => (
              <button
                key={m}
                type="button"
                className={minutes === m ? 'btn btn-primary' : 'btn btn-secondary'}
                aria-pressed={minutes === m}
                onClick={() => {
                  setMinutes(m);
                  setTime('');
                }}
              >
                {fmt(t.bkMinutes, { n: m })}
              </button>
            ))}
          </div>
        ) : (
          <p className="muted">{t.kbkPickRoomFirst}</p>
        )}
      </fieldset>
      <fieldset className="card">
        <legend>{t.bkStepDay}</legend>
        <input
          className="field"
          type="date"
          aria-label={t.bkStepDay}
          min={today}
          max={last}
          value={date}
          onChange={(e) => {
            setDate(e.target.value);
            setTime('');
          }}
        />
      </fieldset>
      <fieldset className="card">
        <legend>{t.bkStepTime}</legend>
        {!roomId || !minutes || !date ? (
          <p className="muted">{t.kbkPickFirst}</p>
        ) : loading ? (
          <p className="sso-working" role="status">
            <Spinner /> {t.loading}
          </p>
        ) : list.length === 0 ? (
          <p>{t.bkNoTimes}</p>
        ) : (
          <div className="actions">
            {list.map((s) => (
              <button
                key={s}
                type="button"
                className={time === s ? 'btn btn-primary' : 'btn btn-secondary'}
                aria-pressed={time === s}
                onClick={() => setTime(s)}
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </fieldset>
      <fieldset className="card">
        <legend>{t.bkStepYou}</legend>
        <div className="form-row">
          <label className="label" htmlFor="kbk-name">
            {t.bkName}
          </label>
          <input
            id="kbk-name"
            className="field"
            autoComplete="name"
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="form-row">
          <label className="label" htmlFor="kbk-phone">
            {t.bkPhone}
          </label>
          <input
            id="kbk-phone"
            className="field"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            maxLength={30}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </div>
        <div className="form-row">
          <label className="label" htmlFor="kbk-guests">
            {t.kbkGuests}
          </label>
          <input
            id="kbk-guests"
            className="field"
            inputMode="numeric"
            maxLength={3}
            value={guests}
            onChange={(e) => setGuests(e.target.value.replace(/\D/g, ''))}
          />
        </div>
        <div className="form-row">
          <label className="label" htmlFor="kbk-note">
            {t.bkNote}
          </label>
          <input
            id="kbk-note"
            className="field"
            maxLength={300}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      </fieldset>
      {room && minutes ? (
        <p className="card" aria-live="polite">
          {fmt(t.kbkPrice, { price: formatTHB(price) })}
          <br />
          {deposit > 0
            ? fmt(t.kbkDeposit, { amount: formatTHB(deposit), pct: info.settings.depositPct })
            : t.kbkDepositNone}
          {time && date ? (
            <>
              <br />
              <span className="muted">{whenLabel(`${date}T${time}:00+07:00`, lang)}</span>
            </>
          ) : null}
        </p>
      ) : null}
      {problem && !problem.ok ? <p role="alert">{errorText(problem)}</p> : null}
      <div className="actions">
        <AsyncButton type="submit" onClick={submit} disabled={!ready}>
          {t.kbkBook}
        </AsyncButton>
      </div>
    </form>
  );
}
