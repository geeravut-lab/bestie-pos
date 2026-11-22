import { useEffect, useRef, useState } from 'react';
import { formatTHB, guestName, tourDepositFor } from '@bestie/core';
import type { TourOnlineInfo } from '@bestie/core';
import { GUEST_LANGS, fmt, useI18n } from '@bestie/i18n';
import { AsyncButton, LangSwitch, Spinner } from '@bestie/ui';
import { cancelTourBooking, loadTourPage, loadTourStatus, sendTourBooking } from './tourApi';
import type { TourBookOutcome, TourLoad } from './tourApi';

type Done = {
  id: string;
  code: string | null;
  title: string;
  startsAt: string;
  seats: number;
  depositDue: number;
  holdUntil: string | null;
};
const SAVED = (token: string) => `bestie.tour.${token}`;

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
        title: o.title ?? '',
        startsAt: o.startsAt,
        seats: o.seats ?? 0,
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
const when = (iso: string, lang: string, full = true): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(lang === 'th' ? 'th-TH' : 'en-GB', {
    dateStyle: full ? 'full' : 'short',
    timeStyle: 'short',
    timeZone: 'Asia/Bangkok',
  }).format(d);
};

/** The guest's page for a shop's tour link (`/tour/<token>`): choose a tour → seats → name + phone → done (cancel code + the deposit to pay). */
export function TourBookPage({ token }: { token: string }) {
  const { t, lang } = useI18n();
  const [load, setLoad] = useState<TourLoad | null>(null);
  const [done, setDone] = useState<Done | null>(() => readSaved(token));
  useEffect(() => {
    let alive = true;
    void loadTourPage(token).then((r) => alive && setLoad(r));
    return () => {
      alive = false;
    };
  }, [token]);

  const head = (
    <div className="guest-head">
      <h1>{load?.ok ? load.info.storeName : t.tbkTitle}</h1>
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
          payNote={info.payNote}
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
  const apply = (s: Exclude<Awaited<ReturnType<typeof loadTourStatus>>, 'failed'>) => {
    if (!s) return;
    setPaid(s.depositReceived);
    if (s.status === 'cancelled') setState((x) => (x === 'cancelled' ? x : 'released'));
  };
  const check = async () => {
    if (!code) return;
    const s = await loadTourStatus(token, done.id, code);
    if (s !== 'failed') apply(s);
  };
  const cancel = async () => {
    setProblem(false);
    if (!code) return;
    const r = await cancelTourBooking(token, done.id, code);
    if (r.ok) {
      setState('cancelled');
      writeSaved(token, null);
    } else setProblem(true);
  };
  useEffect(() => {
    if (!code) return;
    let alive = true;
    void loadTourStatus(token, done.id, code).then((s) => {
      if (alive && s !== 'failed') apply(s);
    });
    return () => {
      alive = false;
    };
  }, [token, done.id, code]);

  const needDeposit = done.depositDue > 0;
  const heading =
    state === 'cancelled' ? t.bkCancelled : state === 'released' ? t.tbkReleased : t.bkDoneTitle;
  return (
    <section className="card" aria-live="polite">
      <h2>{heading}</h2>
      {state === 'booked' ? (
        <>
          <dl className="kv">
            <dt>{t.bkDoneWhen}</dt>
            <dd>{when(done.startsAt, lang)}</dd>
            <dt>{t.tbkStepTour}</dt>
            <dd>
              {done.title} · {fmt(t.tbkSeatsN, { n: done.seats })}
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
              <p role="status">{t.tbkDepositPaid}</p>
            ) : (
              <div className="card" aria-label={t.tbkDepositTitle}>
                <h3>{t.tbkDepositTitle}</h3>
                <p>
                  <strong className="tabular">{formatTHB(done.depositDue)}</strong>
                </p>
                {done.holdUntil ? (
                  <p>{fmt(t.tbkDepositHold, { when: when(done.holdUntil, lang, false) })}</p>
                ) : null}
                {payNote ? <p>{payNote}</p> : <p className="muted">{t.tbkDepositAsk}</p>}
                <p className="muted">
                  {fmt(t.tbkDepositSoFar, {
                    paid: formatTHB(paid),
                    due: formatTHB(done.depositDue),
                  })}
                </p>
                {code ? (
                  <AsyncButton variant="secondary" onClick={check}>
                    {t.tbkDepositCheck}
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
  info: TourOnlineInfo;
  onBooked: (d: Done) => void;
}) {
  const { t, lang } = useI18n();
  const [slotId, setSlotId] = useState('');
  const [seatsText, setSeatsText] = useState('1');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [problem, setProblem] = useState<TourBookOutcome | null>(null);
  const clientId = useRef(crypto.randomUUID());
  const slot = info.slots.find((s) => s.id === slotId);
  const max = slot ? Math.max(1, Math.min(slot.seatsLeft, 20)) : 1;
  const seats = Math.min(Math.max(Number.parseInt(seatsText, 10) || 1, 1), max);
  const total = slot ? slot.price * seats : 0;
  const deposit = slot ? tourDepositFor(slot.price, seats, info.depositPct) : 0;
  const ready = !!slot && seats >= 1 && name.trim().length > 0 && phone.trim().length >= 6;

  const submit = async () => {
    if (!slot) return;
    setProblem(null);
    const r = await sendTourBooking(token, {
      slotId: slot.id,
      seats,
      name: name.trim(),
      phone: phone.trim(),
      clientId: clientId.current,
    });
    if (r.ok) {
      clientId.current = crypto.randomUUID();
      return onBooked({
        id: r.id,
        code: r.code,
        title: guestName(slot.title, lang),
        startsAt: slot.startsAt,
        seats,
        depositDue: r.depositDue,
        holdUntil: r.holdUntil,
      });
    }
    setProblem(r);
  };
  const errorText = (r: TourBookOutcome): string =>
    r.ok
      ? ''
      : r.error === 'full'
        ? t.tbkFull
        : r.error === 'unavailable' || r.error === 'closed'
          ? t.tbkUnavailable
          : r.error === 'invalid'
            ? t.bkInvalid
            : r.error === 'too_many' || r.error === 'rate_limited'
              ? t.bkTooMany
              : t.bkFailed;

  if (info.slots.length === 0) return <p>{t.tbkNoSlots}</p>;
  return (
    <form className="auth-form" onSubmit={(e) => e.preventDefault()}>
      <fieldset className="card">
        <legend>{t.tbkStepTour}</legend>
        {info.slots.map((s) => (
          <label key={s.id} className="choice">
            <input
              type="radio"
              name="tour-slot"
              checked={slotId === s.id}
              disabled={s.seatsLeft < 1}
              onChange={() => {
                setSlotId(s.id);
              }}
            />{' '}
            <strong>{guestName(s.title, lang)}</strong> · {when(s.startsAt, lang)} ·{' '}
            {fmt(t.bkMinutes, { n: s.durationMin })} ·{' '}
            {fmt(t.tbkPerSeat, { price: formatTHB(s.price) })} ·{' '}
            {fmt(t.tbkSeatsLeft, { n: s.seatsLeft })}
            {s.note ? <span className="muted"> · {s.note}</span> : null}
          </label>
        ))}
      </fieldset>
      <fieldset className="card">
        <legend>{t.tbkStepSeats}</legend>
        <div className="form-row">
          <label className="label" htmlFor="tbk-seats">
            {t.tbkSeats}
          </label>
          <input
            id="tbk-seats"
            className="field"
            type="number"
            inputMode="numeric"
            min={1}
            max={max}
            value={seatsText}
            onChange={(e) => setSeatsText(e.target.value.replace(/\D/g, '').slice(0, 2))}
            onBlur={() => setSeatsText(String(seats))}
          />
        </div>
      </fieldset>
      <fieldset className="card">
        <legend>{t.bkStepYou}</legend>
        <div className="form-row">
          <label className="label" htmlFor="tbk-name">
            {t.bkName}
          </label>
          <input
            id="tbk-name"
            className="field"
            autoComplete="name"
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="form-row">
          <label className="label" htmlFor="tbk-phone">
            {t.bkPhone}
          </label>
          <input
            id="tbk-phone"
            className="field"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            maxLength={30}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </div>
      </fieldset>
      {slot ? (
        <p className="card" aria-live="polite">
          {fmt(t.tbkTotal, { price: formatTHB(total) })}
          <br />
          {deposit > 0
            ? fmt(t.tbkDeposit, { amount: formatTHB(deposit), pct: info.depositPct })
            : t.tbkDepositNone}
        </p>
      ) : null}
      {problem && !problem.ok ? <p role="alert">{errorText(problem)}</p> : null}
      <div className="actions">
        <AsyncButton type="submit" onClick={submit} disabled={!ready}>
          {t.tbkBook}
        </AsyncButton>
      </div>
    </form>
  );
}
