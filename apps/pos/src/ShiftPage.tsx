import { useEffect, useState } from 'react';
import {
  bangkokDate,
  cashVariance,
  closeShift,
  formatTHB,
  openShift,
  parsePriceInput,
  priceInputValue,
  summarizeShift,
} from '@bestie/core';
import type { OrderDoc } from '@bestie/core';
import { errorText, fmt, formatDateTime, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { saveShift, useClosedShifts, useOpenShift, usePaidOrders } from '@bestie/offline';
import { usePosData, usePosStore } from './posData';
import { Loading, NeedsDevice, Page } from './PosBits';
import { OpenDrawer } from './printing/OpenDrawer';

/** Open the cash drawer session, see what it took, close it with the counted cash. Works offline; the server re-checks the expected cash. */
export function ShiftPage({ ctx }: { ctx: PageContext }) {
  const { t, lang } = useI18n();
  const locale = lang === 'th' ? ('th-TH' as const) : ('en-GB' as const);
  const { storeId, binding } = usePosStore(ctx);
  usePosData(ctx, storeId);
  const shift = useOpenShift(binding?.deviceId ?? null);
  const history = useClosedShifts(binding?.deviceId ?? null);
  const [today] = useState(() => bangkokDate(Date.now()));
  const openedDay = shift ? bangkokDate(Date.parse(shift.openedAt)) : today;
  const paidToday = usePaidOrders(storeId, today);
  const paidOpened = usePaidOrders(storeId, openedDay);
  const canRun = ctx.isOwner || ctx.permissions.includes('shift.open_close');

  if (!storeId)
    return (
      <Page title={t.shiftTitle}>
        <Notice kind="error">{t.posNoShop}</Notice>
      </Page>
    );
  if (!binding)
    return (
      <Page title={t.shiftTitle}>
        <NeedsDevice ctx={ctx} />
      </Page>
    );
  if (
    shift === undefined ||
    history === undefined ||
    paidToday === undefined ||
    paidOpened === undefined
  )
    return <Loading />;

  const paid: OrderDoc[] = [
    ...new Map([...paidOpened, ...paidToday].map((o) => [o.id, o])).values(),
  ];

  return (
    <Page title={t.shiftTitle}>
      <Notice kind="info">{t.shiftIntro}</Notice>
      <div className="actions">
        <OpenDrawer ctx={ctx} storeId={storeId} deviceId={binding.deviceId} />
      </div>
      {shift === null ? (
        <OpenForm ctx={ctx} binding={binding} canRun={canRun} />
      ) : (
        <CloseForm
          ctx={ctx}
          shift={shift}
          deviceCode={binding.code}
          paid={paid}
          locale={locale}
          canRun={canRun}
        />
      )}
      <section className="card admin-card">
        <h2>{t.shiftHistory}</h2>
        {history.length === 0 ? <p className="muted">—</p> : null}
        <ul className="member-list">
          {history.map((s) => (
            <li key={s.id} className="member-row">
              <div className="member-head">
                <strong>{s.closedAt ? formatDateTime(lang, s.closedAt) : ''}</strong>
                <span className="tabular">{formatTHB(s.countedCash ?? 0, locale)}</span>
                <span className={s.variance ? 'badge badge-warn' : 'badge'}>
                  {varianceText(t, s.variance ?? 0, locale)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </Page>
  );
}

function varianceText(
  t: ReturnType<typeof useI18n>['t'],
  v: number,
  locale: 'th-TH' | 'en-GB',
): string {
  return v === 0
    ? t.shiftVarianceOk
    : v < 0
      ? fmt(t.shiftVarianceShort, { amount: formatTHB(-v, locale) })
      : fmt(t.shiftVarianceOver, { amount: formatTHB(v, locale) });
}

function OpenForm({
  ctx,
  binding,
  canRun,
}: {
  ctx: PageContext;
  binding: NonNullable<ReturnType<typeof usePosStore>['binding']>;
  canRun: boolean;
}) {
  const { t } = useI18n();
  const [cash, setCash] = useState('');
  const [error, setError] = useState<ErrorKey | null>(null);
  const open = async () => {
    setError(null);
    const v = parsePriceInput(cash);
    if (v === null) return setError('err_shift_invalid');
    await saveShift(
      openShift({
        id: crypto.randomUUID(),
        orgId: binding.orgId,
        storeId: binding.storeId,
        deviceId: binding.deviceId,
        openedBy: ctx.staffId ?? null,
        openingCash: v,
        now: Date.now(),
      }),
      'open',
      ctx.staffId ?? null,
    );
  };
  return (
    <section className="card admin-card">
      <h2>{t.shiftOpenTitle}</h2>
      <p className="muted">{t.shiftNone}</p>
      {canRun ? (
        <form className="auth-form" onSubmit={(e) => e.preventDefault()}>
          <div className="form-row">
            <label className="label" htmlFor="shift-open-cash">
              {t.shiftOpeningCash}
            </label>
            <input
              id="shift-open-cash"
              className="field tabular"
              inputMode="decimal"
              value={cash}
              onChange={(e) => setCash(e.target.value)}
            />
          </div>
          {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
          <AsyncButton type="submit" onClick={open}>
            {t.shiftOpenButton}
          </AsyncButton>
        </form>
      ) : (
        <Notice kind="info">{t.err_forbidden}</Notice>
      )}
    </section>
  );
}

function CloseForm({
  ctx,
  shift,
  deviceCode,
  paid,
  locale,
  canRun,
}: {
  ctx: PageContext;
  shift: NonNullable<ReturnType<typeof useOpenShift>>;
  deviceCode: string;
  paid: OrderDoc[];
  locale: 'th-TH' | 'en-GB';
  canRun: boolean;
}) {
  const { t, lang } = useI18n();
  const now = useNow(15_000);
  const sum = summarizeShift(shift, deviceCode, paid, now);
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<ErrorKey | null>(null);
  const [done, setDone] = useState(false);
  const countedSatang = parsePriceInput(counted);
  const variance = countedSatang === null ? null : cashVariance(countedSatang, sum.expectedCash);

  const close = async () => {
    setError(null);
    if (countedSatang === null) return setError('err_shift_invalid');
    await saveShift(
      closeShift(shift, {
        countedCash: countedSatang,
        expectedCash: sum.expectedCash,
        now: clock(),
        note,
      }),
      'close',
      ctx.staffId ?? null,
    );
    setDone(true);
  };

  return (
    <section className="card admin-card">
      <h2>{t.shiftSummary}</h2>
      <p className="muted">
        {fmt(t.shiftOpenedAt, { time: formatDateTime(lang, shift.openedAt) })}
      </p>
      <dl className="preview-list tabular">
        <div>
          <dt>{t.shiftOpeningCash}</dt>
          <dd>{formatTHB(shift.openingCash, locale)}</dd>
        </div>
        <div>
          <dt>{t.shiftCashSales}</dt>
          <dd>{formatTHB(sum.cash, locale)}</dd>
        </div>
        <div>
          <dt>{t.shiftPromptPay}</dt>
          <dd>{formatTHB(sum.promptpay, locale)}</dd>
        </div>
        <div>
          <dt>{t.shiftCard}</dt>
          <dd>{formatTHB(sum.card, locale)}</dd>
        </div>
        <div>
          <dt>{t.shiftBills}</dt>
          <dd>{sum.bills}</dd>
        </div>
        <div>
          <dt>
            <strong>{t.shiftExpected}</strong>
          </dt>
          <dd>
            <strong>{formatTHB(sum.expectedCash, locale)}</strong>
          </dd>
        </div>
      </dl>
      {canRun ? (
        <form className="auth-form" onSubmit={(e) => e.preventDefault()}>
          <div className="form-row">
            <label className="label" htmlFor="shift-counted">
              {t.shiftCounted}
            </label>
            <input
              id="shift-counted"
              className="field tabular"
              inputMode="decimal"
              value={counted}
              onChange={(e) => setCounted(e.target.value)}
            />
          </div>
          <div className="chips" role="group" aria-label={t.shiftExpected}>
            <button
              type="button"
              className="chip"
              onClick={() => setCounted(priceInputValue(sum.expectedCash))}
            >
              {t.payExact}
            </button>
          </div>
          {variance !== null ? (
            <p aria-live="polite" className="tabular">
              <strong>{t.shiftVariance}: </strong>
              <span className={variance === 0 ? '' : 'pay-short'}>
                {varianceText(t, variance, locale)}
              </span>
            </p>
          ) : null}
          <div className="form-row">
            <label className="label" htmlFor="shift-note">
              {t.shiftNote}
            </label>
            <input
              id="shift-note"
              className="field"
              value={note}
              maxLength={300}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
          {done ? <Notice kind="success">{t.shiftClosed}</Notice> : null}
          <AsyncButton type="submit" variant="danger" onClick={close}>
            {t.shiftCloseButton}
          </AsyncButton>
        </form>
      ) : null}
    </section>
  );
}

/** The current time, refreshed every `ms` (so a figure that depends on "now" stays right while the screen stays open). */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(i);
  }, [ms]);
  return now;
}

/** The wall clock, read only inside event handlers (kept out of render on purpose). */
const clock = (): number => Date.now();
