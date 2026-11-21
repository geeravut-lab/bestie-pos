import { useEffect, useRef, useState } from 'react';
import { addDays, bangkokParts, formatTHB, guestName } from '@bestie/core';
import type { BookingInfo, BookingResult } from '@bestie/core';
import { fmt, useI18n } from '@bestie/i18n';
import { AsyncButton, LangSwitch, Spinner } from '@bestie/ui';
import { cancelBooking, loadBooking, loadSlots, saveContact, sendBooking } from './bookingApi';
import type { BookingLoad } from './bookingApi';

type Done = { id: string; code: string | null; startsAt: string; provider: string | null };
const SAVED = (token: string) => `bestie.booking.${token}`;

function readSaved(token: string): Done | null {
  try {
    const v: unknown = JSON.parse(globalThis.localStorage?.getItem(SAVED(token)) ?? 'null');
    const o = v as Partial<Done> | null;
    if (
      o &&
      typeof o.id === 'string' &&
      typeof o.startsAt === 'string' &&
      Date.parse(o.startsAt) > Date.now()
    )
      return { id: o.id, code: o.code ?? null, startsAt: o.startsAt, provider: o.provider ?? null };
  } catch {
    /* private mode or broken value: no saved booking */
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

/** The guest's booking page for a shop's booking link: service → who → day → time → details → done (with a cancel code). */
export function BookingPage({ token }: { token: string }) {
  const { t, lang } = useI18n();
  const [load, setLoad] = useState<BookingLoad | null>(null);
  const [done, setDone] = useState<Done | null>(() => readSaved(token));
  const [cancelled, setCancelled] = useState(false);

  useEffect(() => {
    let alive = true;
    void loadBooking(token).then((r) => alive && setLoad(r));
    return () => {
      alive = false;
    };
  }, [token]);

  const head = (
    <div className="guest-head">
      <h1>{load?.ok ? load.info.storeName : t.bkTitle}</h1>
      <LangSwitch />
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
  if (done)
    return (
      <div className="guest-page">
        {head}
        <DonePanel
          token={token}
          done={done}
          cancelled={cancelled}
          lang={lang}
          lineBasicId={load.lineBasicId}
          onCancelled={() => {
            setCancelled(true);
            writeSaved(token, null);
          }}
          onAgain={() => {
            setDone(null);
            setCancelled(false);
            writeSaved(token, null);
          }}
        />
      </div>
    );
  return (
    <div className="guest-page">
      {head}
      <Form
        token={token}
        info={info}
        onBooked={(d) => {
          writeSaved(token, d);
          setDone(d);
        }}
      />
    </div>
  );
}

function whenLabel(iso: string, lang: 'th' | 'en'): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(lang === 'th' ? 'th-TH' : 'en-GB', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: 'Asia/Bangkok',
  }).format(d);
}

function DonePanel({
  token,
  done,
  cancelled,
  lang,
  lineBasicId,
  onCancelled,
  onAgain,
}: {
  token: string;
  done: Done;
  cancelled: boolean;
  lang: 'th' | 'en';
  lineBasicId: string | null;
  onCancelled: () => void;
  onAgain: () => void;
}) {
  const { t } = useI18n();
  const [problem, setProblem] = useState(false);
  const cancel = async () => {
    setProblem(false);
    if (!done.code) return;
    const r = await cancelBooking(token, done.id, done.code);
    if (r.ok) onCancelled();
    else setProblem(true);
  };
  return (
    <section className="card" aria-live="polite">
      <h2>{cancelled ? t.bkCancelled : t.bkDoneTitle}</h2>
      {cancelled ? null : (
        <>
          <dl className="kv">
            <dt>{t.bkDoneWhen}</dt>
            <dd>{whenLabel(done.startsAt, lang)}</dd>
            {done.provider ? (
              <>
                <dt>{t.bkDoneWho}</dt>
                <dd>{done.provider}</dd>
              </>
            ) : null}
            {done.code ? (
              <>
                <dt>{t.bkCodeLabel}</dt>
                <dd>
                  <strong className="tabular">{done.code}</strong>
                </dd>
              </>
            ) : null}
          </dl>
          <p className="muted">{t.bkDoneNote}</p>
          {done.code ? (
            <ReminderBox token={token} id={done.id} code={done.code} lineBasicId={lineBasicId} />
          ) : null}
          {problem ? <p role="alert">{t.bkCancelClosed}</p> : null}
          {done.code ? (
            <AsyncButton variant="secondary" onClick={cancel}>
              {t.bkCancel}
            </AsyncButton>
          ) : null}
        </>
      )}
      <div className="actions">
        <button type="button" className="btn btn-primary" onClick={onAgain}>
          {t.bkBookAnother}
        </button>
      </div>
    </section>
  );
}

/** How the guest gets a reminder: add the shop's LINE and send the booking code, and / or leave an e-mail address. */
function ReminderBox({
  token,
  id,
  code,
  lineBasicId,
}: {
  token: string;
  id: string;
  code: string;
  lineBasicId: string | null;
}) {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'saved' | 'bad' | 'failed'>('idle');
  const save = async () => {
    setState('idle');
    const r = await saveContact(token, id, code, email.trim());
    setState(r.ok ? 'saved' : r.error === 'bad_email' ? 'bad' : 'failed');
  };
  const lineUrl = lineBasicId ? `https://line.me/R/ti/p/${lineBasicId}` : null;
  return (
    <div className="card" aria-label={t.bkRemindTitle}>
      <h3>{t.bkRemindTitle}</h3>
      {lineUrl ? (
        <>
          <p>{fmt(t.bkRemindLine, { code })}</p>
          <a className="btn btn-secondary" href={lineUrl} target="_blank" rel="noopener noreferrer">
            {t.bkRemindLineAdd}
          </a>
        </>
      ) : null}
      <div className="form-row">
        <label className="label" htmlFor="bk-remind-email">
          {t.bkRemindEmail}
        </label>
        <input
          id="bk-remind-email"
          className="field"
          type="email"
          inputMode="email"
          autoComplete="email"
          maxLength={120}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <AsyncButton variant="secondary" onClick={save} disabled={email.trim() === ''}>
          {t.bkRemindEmailSave}
        </AsyncButton>
      </div>
      {state === 'saved' ? <p role="status">{t.bkRemindEmailSaved}</p> : null}
      {state === 'bad' ? <p role="alert">{t.bkRemindEmailBad}</p> : null}
      {state === 'failed' ? <p role="alert">{t.err_load_failed}</p> : null}
      <p className="muted">{t.bkRemindNote}</p>
    </div>
  );
}

function Form({
  token,
  info,
  onBooked,
}: {
  token: string;
  info: Extract<BookingInfo, { open: true }>;
  onBooked: (d: Done) => void;
}) {
  const { t, lang } = useI18n();
  const today = bangkokParts(new Date().toISOString()).date;
  const last = addDays(today, info.settings.maxDays);
  const [service, setService] = useState('');
  const [provider, setProvider] = useState('');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<BookingResult | null>(null);
  const [slots, setSlots] = useState<{ key: string; list: string[] | null } | null>(null);
  const clientId = useRef(crypto.randomUUID());
  const key = `${service}|${provider}|${date}`;

  useEffect(() => {
    if (!service || !date) return;
    let alive = true;
    void loadSlots(token, { service, provider, date }).then(
      (list) => alive && setSlots({ key, list }),
    );
    return () => {
      alive = false;
    };
  }, [token, service, provider, date, key]);

  const loading = !!service && !!date && slots?.key !== key;
  const list = slots?.key === key ? (slots.list ?? []) : [];
  const picked = info.services.find((s) => s.id === service);

  const submit = async () => {
    setProblem(null);
    const r = await sendBooking(token, {
      serviceId: service,
      providerId: provider,
      date,
      time,
      name: name.trim(),
      phone: phone.trim(),
      note: note.trim(),
      clientId: clientId.current,
    });
    if (r.ok) {
      clientId.current = crypto.randomUUID();
      return onBooked({ id: r.id, code: r.code, startsAt: r.startsAt, provider: r.provider });
    }
    setProblem(r);
    if (r.error === 'taken') {
      setTime('');
      setSlots(null);
      void loadSlots(token, { service, provider, date }).then((l) => setSlots({ key, list: l }));
    }
  };
  const errorText = (r: BookingResult): string =>
    r.ok
      ? ''
      : r.error === 'taken'
        ? t.bkTaken
        : r.error === 'invalid'
          ? t.bkInvalid
          : r.error === 'too_many'
            ? t.bkTooMany
            : t.bkFailed;
  const ready = !!service && !!date && !!time && name.trim().length > 0 && phone.trim().length >= 6;

  if (info.services.length === 0) return <p>{t.bkNoServices}</p>;
  return (
    <form className="card auth-form" onSubmit={(e) => e.preventDefault()} aria-label={t.bkTitle}>
      <fieldset className="form-row">
        <legend className="label">{t.bkStepService}</legend>
        <div className="chips">
          {info.services.map((s) => (
            <button
              key={s.id}
              type="button"
              className="chip"
              aria-pressed={service === s.id}
              onClick={() => {
                setService(s.id);
                setTime('');
              }}
            >
              {guestName(s.name, lang)} · {fmt(t.bkMinutes, { n: s.durationMin })}
              {s.price > 0 ? ` · ${formatTHB(s.price)}` : ''}
            </button>
          ))}
        </div>
      </fieldset>
      {info.providers.length > 1 ? (
        <fieldset className="form-row">
          <legend className="label">{t.bkStepStaff}</legend>
          <div className="chips">
            <button
              type="button"
              className="chip"
              aria-pressed={provider === ''}
              onClick={() => {
                setProvider('');
                setTime('');
              }}
            >
              {t.bkAnyone}
            </button>
            {info.providers.map((p) => (
              <button
                key={p.id}
                type="button"
                className="chip"
                aria-pressed={provider === p.id}
                onClick={() => {
                  setProvider(p.id);
                  setTime('');
                }}
              >
                {p.name}
              </button>
            ))}
          </div>
        </fieldset>
      ) : null}
      <div className="form-row">
        <label className="label" htmlFor="bk-date">
          {t.bkStepDay}
        </label>
        <input
          id="bk-date"
          className="field"
          type="date"
          min={today}
          max={last}
          value={date}
          onChange={(e) => {
            setDate(e.target.value);
            setTime('');
          }}
        />
      </div>
      <fieldset className="form-row">
        <legend className="label">{t.bkStepTime}</legend>
        {!service || !date ? (
          <p className="muted">{t.bkPickDayFirst}</p>
        ) : loading ? (
          <p className="sso-working" role="status">
            <Spinner /> {t.loading}
          </p>
        ) : list.length === 0 ? (
          <p className="muted">{t.bkNoTimes}</p>
        ) : (
          <div className="chips">
            {list.map((s) => (
              <button
                key={s}
                type="button"
                className="chip"
                aria-pressed={time === s}
                onClick={() => setTime(s)}
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </fieldset>
      <h2 className="label">{t.bkStepYou}</h2>
      <div className="form-row">
        <label className="label" htmlFor="bk-name">
          {t.bkName}
        </label>
        <input
          id="bk-name"
          className="field"
          autoComplete="name"
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="form-row">
        <label className="label" htmlFor="bk-phone">
          {t.bkPhone}
        </label>
        <input
          id="bk-phone"
          className="field"
          type="tel"
          autoComplete="tel"
          maxLength={30}
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
      </div>
      <div className="form-row">
        <label className="label" htmlFor="bk-note">
          {t.bkNote}
        </label>
        <input
          id="bk-note"
          className="field"
          maxLength={300}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      {picked && time ? (
        <p className="muted">
          {guestName(picked.name, lang)} · {date} {time}
        </p>
      ) : null}
      {problem ? <p role="alert">{errorText(problem)}</p> : null}
      <div className="actions">
        <AsyncButton type="submit" disabled={!ready} onClick={submit}>
          {t.bkSubmit}
        </AsyncButton>
      </div>
    </form>
  );
}
