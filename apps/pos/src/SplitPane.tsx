import { useState } from 'react';
import { equalShares, formatTHB, parsePriceInput, planSplit, priceInputValue } from '@bestie/core';
import type { RoundingRule, Satang, SplitLeg } from '@bestie/core';
import { errorText, fmt, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import { OnlinePane } from './OnlinePane';
import type { OnlinePay } from './onlinePay';

type Row = {
  tender: 'cash' | 'credit' | 'promptpay' | 'gateway';
  amount: string;
  tendered: string;
};

/** Split one bill between payers: each share paid in cash or from the customer's Bestie Credit. One receipt. */
export function SplitPane({
  total,
  rule,
  locale,
  online,
  pay,
  methods = { promptpay: false, gateway: false },
  held = 0,
  heldDeposit = false,
  credit,
  onPay,
  onClose,
}: {
  total: Satang;
  rule: RoundingRule;
  locale: 'th-TH' | 'en-GB';
  online: boolean;
  /** The online-payment helper: lets ONE share be PromptPay or card (the bill then closes when the provider confirms). */
  pay?: OnlinePay;
  methods?: { promptpay: boolean; gateway: boolean };
  /** PromptPay / card shares already held on this bill (paid, waiting for the bill to close). */
  held?: Satang;
  /** The held money is a deposit taken before the visit. */
  heldDeposit?: boolean;
  /** null = no customer on the bill or Credit is off in this shop. */
  credit: { name: string; balance: Satang } | null;
  onPay: (legs: SplitLeg[], held: Satang) => Promise<ErrorKey | null>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [people, setPeople] = useState(2);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [heldNow, setHeldNow] = useState(held);
  // the PromptPay / card shares being charged one after the other (the last one closes the bill)
  const [run, setRun] = useState<{
    /** the shares still to be paid (the PromptPay / card ones already held on the bill are taken out) */
    legs: SplitLeg[];
    done: number;
    total: number;
  } | null>(null);
  const money = (n: Satang) => formatTHB(n, locale);

  const legs: SplitLeg[] = rows.map((r) => ({
    tender: r.tender,
    amount: parsePriceInput(r.amount) ?? 0,
    tendered:
      r.tender === 'cash' && r.tendered.trim() !== ''
        ? (parsePriceInput(r.tendered) ?? 0)
        : undefined,
  }));
  const plan = planSplit({
    total,
    held: heldNow,
    rule,
    legs,
    creditBalance: credit ? credit.balance : null,
  });
  const shared = legs.reduce((a, l) => a + l.amount, 0);
  const remaining = total - heldNow - shared;

  const split = () => {
    const shares = equalShares(total - heldNow, people);
    setRows(
      shares.map((s) => ({ tender: 'cash' as const, amount: priceInputValue(s), tendered: '' })),
    );
    setError(null);
  };
  const update = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  if (!online) return <Notice kind="info">{t.paySplitOnlineOnly}</Notice>;
  if (run && pay) {
    const rest = planSplit({
      total,
      held: heldNow,
      rule,
      legs: run.legs,
      creditBalance: credit ? credit.balance : null,
    });
    const d = rest.digitals[0];
    if (!d) return <Notice kind="error">{errorText('err_pay_failed', t)}</Notice>;
    const last = rest.digitals.length === 1;
    return (
      <>
        <Notice kind="info">{t.paySplitDigitalNote}</Notice>
        {run.total > 1 ? (
          <p className="muted">{fmt(t.paySplitStep, { n: run.done + 1, total: run.total })}</p>
        ) : null}
        <OnlinePane
          key={run.done}
          tender={d.tender}
          total={d.amount}
          locale={locale}
          online={pay}
          split={{ legs: run.legs, step: 0, held: heldNow }}
          onPaid={
            last
              ? undefined
              : () => {
                  // this share is now held on the bill: take it out of the shares still to pay
                  const i = run.legs.findIndex(
                    (l) => l.tender === 'promptpay' || l.tender === 'gateway',
                  );
                  setHeldNow((h) => h + d.amount);
                  setRun({
                    legs: run.legs.filter((_, j) => j !== i),
                    done: run.done + 1,
                    total: run.total,
                  });
                }
          }
          onClose={() => setRun(null)}
        />
      </>
    );
  }

  return (
    <div className="split-pane">
      <p className="muted">{t.paySplitIntro}</p>
      {heldNow > 0 ? (
        <Notice kind="info">
          {fmt(heldDeposit ? t.paySplitDeposit : t.paySplitHeld, { amount: money(heldNow) })}
        </Notice>
      ) : null}
      <div className="filters">
        <div className="form-row">
          <label className="label" htmlFor="split-people">
            {t.paySplitPeople}
          </label>
          <input
            id="split-people"
            className="field tabular"
            type="number"
            min={2}
            max={20}
            value={people}
            onChange={(e) => setPeople(Math.min(20, Math.max(2, Number(e.target.value) || 2)))}
          />
        </div>
        <button type="button" className="btn btn-secondary" onClick={split}>
          {t.paySplitEqual}
        </button>
      </div>
      {credit ? (
        <p className="muted">
          {fmt(t.paySplitCreditLine, { name: credit.name, amount: money(credit.balance) })}
        </p>
      ) : (
        <p className="muted">{t.paySplitNoCredit}</p>
      )}
      <ul className="member-list">
        {rows.map((r, i) => {
          const n = i + 1;
          return (
            <li key={i} className="member-row">
              <strong>{fmt(t.paySplitLeg, { n })}</strong>
              <div className="filters">
                <div className="form-row">
                  <label className="label" htmlFor={`split-t-${i}`}>
                    {fmt(t.paySplitTender, { n })}
                  </label>
                  <select
                    id={`split-t-${i}`}
                    className="field"
                    value={r.tender}
                    onChange={(e) => update(i, { tender: e.target.value as Row['tender'] })}
                  >
                    <option value="cash">{t.paySplitCash}</option>
                    {credit ? <option value="credit">{t.paySplitCredit}</option> : null}
                    {pay && methods.promptpay ? (
                      <option value="promptpay">{t.paySplitPromptPay}</option>
                    ) : null}
                    {pay && methods.gateway && pay.hasReader ? (
                      <option value="gateway">{t.paySplitCard}</option>
                    ) : null}
                  </select>
                </div>
                <div className="form-row">
                  <label className="label" htmlFor={`split-a-${i}`}>
                    {fmt(t.paySplitAmount, { n })}
                  </label>
                  <input
                    id={`split-a-${i}`}
                    className="field tabular"
                    inputMode="decimal"
                    value={r.amount}
                    onChange={(e) => update(i, { amount: e.target.value })}
                  />
                </div>
                {r.tender === 'cash' ? (
                  <div className="form-row">
                    <label className="label" htmlFor={`split-c-${i}`}>
                      {fmt(t.paySplitTendered, { n })}
                    </label>
                    <input
                      id={`split-c-${i}`}
                      className="field tabular"
                      inputMode="decimal"
                      value={r.tendered}
                      onChange={(e) => update(i, { tendered: e.target.value })}
                    />
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                className="btn btn-secondary"
                aria-label={fmt(t.paySplitRemove, { n })}
                onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        className="btn btn-secondary"
        onClick={() =>
          setRows((rs) => [
            ...rs,
            {
              tender: 'cash',
              amount: remaining > 0 ? priceInputValue(remaining) : '',
              tendered: '',
            },
          ])
        }
      >
        {t.paySplitAddLeg}
      </button>
      <p className="guest-total">
        <span>{t.paySplitRemaining}</span>
        <strong className="tabular">{money(remaining)}</strong>
      </p>
      {plan.rounding !== 0 ? (
        <p className="muted">{fmt(t.paySplitRounding, { amount: money(plan.rounding) })}</p>
      ) : null}
      {rows.length > 0 ? (
        <p className="muted">{fmt(t.paySplitPayable, { amount: money(plan.payable) })}</p>
      ) : null}
      {rows.length > 0 && plan.problems.length > 0 ? (
        <ul className="muted">
          {plan.problems.map((p) => (
            <li key={p}>{(t as Record<string, string>)[`paySplitProblem_${p}`] ?? p}</li>
          ))}
        </ul>
      ) : null}
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      <div className="actions">
        <AsyncButton
          disabled={plan.problems.length > 0}
          onClick={async () => {
            setError(null);
            if (plan.digitals.length > 0) {
              setRun({ legs, done: 0, total: plan.digitals.length });
              return;
            }
            const err = await onPay(legs, heldNow);
            if (err) setError(err);
          }}
        >
          {plan.digitals.length > 0 ? t.paySplitDigitalStart : t.paySplitConfirm}
        </AsyncButton>
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          {t.menuCancel}
        </button>
      </div>
    </div>
  );
}
