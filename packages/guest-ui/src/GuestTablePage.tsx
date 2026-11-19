import { useEffect, useMemo, useRef, useState } from 'react';
import {
  EMPTY_FILTER,
  addToGuestCart,
  applyFilter,
  cartCount,
  cartTotal,
  formatTHB,
  groupsOf,
  guestName,
  guestSelectionProblem,
  hasDietConstraint,
  setCartQuantity,
  statusStep,
  unitPrice,
} from '@bestie/core';
import type { CartLine, DietFilter, GuestGroup, GuestItem } from '@bestie/core';
import { fmt, useI18n } from '@bestie/i18n';
import type { Dict } from '@bestie/i18n';
import { AsyncButton, LangSwitch, Spinner } from '@bestie/ui';
import {
  cancelGuestPayment,
  guestPaymentStatus,
  loadGuestTable,
  placeGuestOrder,
  startGuestPayment,
} from './guestApi';
import { FoodFilter, dietName } from './FoodFilter';
import type { GuestCharge, GuestFailure, GuestLoad, GuestTable, PlacedOrder } from './guestApi';

const POLL_MS = 10_000;
const PAY_POLL_MS = 3_000;
const newId = (): string => globalThis.crypto.randomUUID();

const failureText = (t: Dict, reason: GuestFailure): string =>
  (t as Record<string, string>)[`gsErr_${reason === 'not_found' ? 'failed' : reason}`] ??
  t.gsErr_failed;

/** The page a guest sees after scanning the table's QR: menu → basket → order → what is happening to it. No account. */
export function GuestTablePage({ token }: { token: string }) {
  const { t } = useI18n();
  const [state, setState] = useState<GuestLoad | 'loading'>('loading');

  const retry = async () => {
    setState('loading');
    setState(await loadGuestTable(token));
  };
  useEffect(() => {
    let alive = true;
    void loadGuestTable(token).then((r) => alive && setState(r));
    return () => {
      alive = false;
    };
  }, [token]);

  if (state === 'loading')
    return (
      <p className="sso-working" role="status">
        <Spinner /> {t.gsLoading}
      </p>
    );
  if (!state.ok) {
    return (
      <div className="guest-page">
        <GuestHead store={state.storeName} table={state.tableName} />
        <p className="notice notice-error" role="alert">
          {state.reason === 'not_found'
            ? t.gsNotFound
            : state.reason === 'ordering_off'
              ? t.gsOff
              : t.gsLoadFailed}
        </p>
        {state.reason === 'failed' || state.reason === 'rate_limited' ? (
          <AsyncButton variant="secondary" onClick={retry}>
            {t.gsRetry}
          </AsyncButton>
        ) : null}
      </div>
    );
  }
  return <GuestOrdering token={token} initial={state.data} />;
}

function GuestHead({ store, table }: { store?: string; table?: string }) {
  const { t } = useI18n();
  return (
    <header className="guest-head">
      <div>
        <h1>{store || t.appName}</h1>
        {table ? <p className="muted">{fmt(t.gsTable, { table })}</p> : null}
      </div>
      <LangSwitch />
    </header>
  );
}

function GuestOrdering({ token, initial }: { token: string; initial: GuestTable }) {
  const { t, lang } = useI18n();
  const locale = lang === 'th' ? 'th-TH' : 'en-GB';
  const [data, setData] = useState(initial);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [open, setOpen] = useState<GuestItem | null>(null);
  const [cat, setCat] = useState('');
  const [diet, setDiet] = useState<DietFilter>(EMPTY_FILTER);
  const [error, setError] = useState<GuestFailure | null>(null);
  const [placed, setPlaced] = useState<PlacedOrder | null>(null);
  const [charge, setCharge] = useState<GuestCharge | null>(initial.pay.live);
  const [paid, setPaid] = useState<{ receipt: string | null } | null>(null);
  const [payNote, setPayNote] = useState<'failed' | 'review' | null>(null);
  const [payError, setPayError] = useState<GuestFailure | null>(null);
  // One id per basket: pressing "Place order" again after a lost answer can never order twice; changing the basket starts a new id.
  const clientId = useRef(newId());
  const keySeq = useRef(0);
  const menu = data.menu;

  // keep the "already ordered" list fresh while the page is visible
  useEffect(() => {
    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      const r = await loadGuestTable(token);
      if (r.ok)
        setData((d) => ({ ...d, bill: r.data.bill, menu: r.data.menu, autoSend: r.data.autoSend }));
    };
    const id = setInterval(() => void tick(), POLL_MS);
    return () => clearInterval(id);
  }, [token]);

  // while a PromptPay QR is on screen, ask the server every few seconds whether the bank has confirmed it
  const chargeId = charge?.attemptId ?? null;
  useEffect(() => {
    if (!chargeId) return;
    let alive = true;
    const tick = async () => {
      const r = await guestPaymentStatus(token, chargeId);
      if (!alive || !r) return;
      if (r.status === 'succeeded') {
        setPaid({ receipt: r.receipt });
        setCharge(null);
      } else if (r.status === 'failed' || r.status === 'canceled') {
        setPayNote('failed');
        setCharge(null);
      } else if (r.status === 'needs_review') {
        setPayNote('review');
        setCharge(null);
      }
    };
    const id = setInterval(() => void tick(), PAY_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [token, chargeId]);

  const inCat = useMemo(
    () => menu.items.filter((i) => !cat || i.categoryId === cat),
    [menu.items, cat],
  );
  // the food filter is plain code over what the shop said (packages/core/src/dietary.ts); no AI is involved here
  const found = useMemo(
    () =>
      applyFilter(
        inCat.map((i) => ({ id: i.id, name: i.name, price: i.price, food: i.food })),
        diet,
      ),
    [inCat, diet],
  );
  const byId = useMemo(() => new Map(inCat.map((i) => [i.id, i])), [inCat]);
  const items = found.ok.map((id) => byId.get(id)!);
  const unconfirmed = found.unverified.map((id) => byId.get(id)!);
  const dietActive = hasDietConstraint(diet);
  const money = (n: number) => formatTHB(n, locale);
  const changeCart = (next: CartLine[]) => {
    setCart(next);
    clientId.current = newId();
    setError(null);
    setPlaced(null);
  };

  const pay = async () => {
    setPayError(null);
    setPayNote(null);
    const r = await startGuestPayment(token, lang);
    if (!r.ok) return setPayError(r.reason);
    setCharge(r.charge);
  };
  const cancelPay = async () => {
    if (!charge) return;
    await cancelGuestPayment(token, charge.attemptId);
    setCharge(null);
  };

  const send = async () => {
    setError(null);
    const r = await placeGuestOrder(token, clientId.current, cart);
    if (!r.ok) return setError(r.reason);
    setPlaced(r.order);
    setCart([]);
    clientId.current = newId();
    const fresh = await loadGuestTable(token);
    if (fresh.ok) setData(fresh.data);
  };

  return (
    <div className="guest-page">
      <GuestHead store={data.storeName} table={data.tableName} />

      {placed ? (
        <section className="card guest-sent" role="status">
          <h2>{t.gsSentTitle}</h2>
          <p>{placed.status === 'sent' ? t.gsSentKitchen : t.gsSentWaiting}</p>
          {placed.number ? (
            <p className="muted">{fmt(t.gsOrderNumber, { number: placed.number })}</p>
          ) : null}
        </section>
      ) : null}

      {menu.categories.length > 1 ? (
        <div className="chips" role="group" aria-label={t.menuItemCategory}>
          <button
            type="button"
            className="chip"
            aria-pressed={cat === ''}
            onClick={() => setCat('')}
          >
            {t.gsAll}
          </button>
          {menu.categories.map((c) => (
            <button
              key={c.id}
              type="button"
              className="chip"
              aria-pressed={cat === c.id}
              onClick={() => setCat(c.id)}
            >
              {guestName(c.name, lang)}
            </button>
          ))}
        </div>
      ) : null}

      <FoodFilter token={token} ai={data.ai} filter={diet} onChange={setDiet} />
      {dietActive ? <p className="muted">{t.gsFilterWarning}</p> : null}

      {menu.items.length === 0 ? <p className="muted">{t.gsEmptyMenu}</p> : null}
      {menu.items.length > 0 && items.length === 0 && dietActive ? (
        <p className="muted">{t.gsFilterNone}</p>
      ) : null}
      <ul className="guest-items">
        {items.map((i) => (
          <li key={i.id}>
            <ItemButton item={i} lang={lang} money={money} onOpen={() => setOpen(i)} />
          </li>
        ))}
      </ul>
      {unconfirmed.length > 0 ? (
        <>
          <p className="notice notice-warning" role="note">
            {t.gsFilterUnverified}
          </p>
          <ul className="guest-items">
            {unconfirmed.map((i) => (
              <li key={i.id}>
                <ItemButton item={i} lang={lang} money={money} onOpen={() => setOpen(i)} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {found.hidden > 0 && dietActive ? (
        <p className="muted">{fmt(t.gsFilterHidden, { n: found.hidden })}</p>
      ) : null}

      <section className="card guest-cart" aria-label={t.gsCart}>
        <h2>{t.gsCart}</h2>
        {cart.length === 0 ? (
          <p className="muted">{t.gsCartEmpty}</p>
        ) : (
          <ul className="guest-cart-lines">
            {cart.map((l) => {
              const item = menu.items.find((i) => i.id === l.itemId);
              if (!item) return null;
              const name = guestName(item.name, lang);
              const groups = groupsOf(menu, item);
              const optionNames = groups
                .flatMap((g) => g.options.filter((o) => l.optionIds.includes(o.id)))
                .map((o) => guestName(o.name, lang));
              return (
                <li key={l.key} className="guest-cart-line">
                  <div>
                    <strong>{name}</strong>
                    {optionNames.length ? <p className="muted">{optionNames.join(', ')}</p> : null}
                    {l.note ? <p className="muted">“{l.note}”</p> : null}
                  </div>
                  <div
                    className="qty-stepper"
                    role="group"
                    aria-label={fmt(t.gsQtyLabel, { name })}
                  >
                    <button
                      type="button"
                      aria-label={fmt(l.quantity === 1 ? t.gsRemove : t.gsLess, { name })}
                      onClick={() => changeCart(setCartQuantity(cart, l.key, l.quantity - 1))}
                    >
                      −
                    </button>
                    <output className="tabular">{l.quantity}</output>
                    <button
                      type="button"
                      aria-label={fmt(t.gsMore, { name })}
                      onClick={() => changeCart(setCartQuantity(cart, l.key, l.quantity + 1))}
                    >
                      +
                    </button>
                  </div>
                  <span className="tabular">
                    {money(unitPrice(item, groups, l.optionIds) * l.quantity)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {cart.length > 0 ? (
          <>
            <p className="guest-total">
              <span>{t.gsTotalNote}</span>
              <strong className="tabular">{money(cartTotal(menu, cart))}</strong>
            </p>
            {error ? (
              <p className="notice notice-error" role="alert">
                {failureText(t, error)}
              </p>
            ) : null}
            {charge ? (
              <p className="muted">{t.gsPayLocked}</p>
            ) : (
              <AsyncButton onClick={send}>
                {t.gsSend} ({cartCount(cart)})
              </AsyncButton>
            )}
          </>
        ) : null}
      </section>

      {data.bill.lines.length > 0 ? (
        <section className="card" aria-label={t.gsBillTitle}>
          <h2>{t.gsBillTitle}</h2>
          <ul className="guest-bill">
            {data.bill.lines.map((l, i) => (
              <li key={i}>
                <span>
                  {l.quantity} × {guestName(l.name, lang)}
                </span>
                <span className="muted">
                  {(t as Record<string, string>)[`gsStep_${statusStep(l.status)}`]}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {paid ? (
        <section className="card guest-sent" role="status">
          <h2>{t.gsPaid}</h2>
          {paid.receipt ? (
            <p className="muted">{fmt(t.gsPayReceipt, { number: paid.receipt })}</p>
          ) : null}
        </section>
      ) : data.pay.enabled && data.bill.lines.length > 0 && data.pay.total > 0 ? (
        <section className="card guest-pay" aria-label={t.gsPay}>
          <h2>{t.gsPay}</h2>
          {payNote ? (
            <p className="notice notice-error" role="alert">
              {payNote === 'review' ? t.gsPayReview : t.gsPayFailed}
            </p>
          ) : null}
          {payError ? (
            <p className="notice notice-error" role="alert">
              {failureText(t, payError)}
            </p>
          ) : null}
          {charge ? (
            <>
              <p>{fmt(t.gsPayScan, { amount: money(charge.amount) })}</p>
              <img className="guest-qr" src={charge.qrImageUrl} alt={t.gsPayQrAlt} />
              <p className="muted" role="status">
                <Spinner /> {t.gsPayWaiting}
              </p>
              <AsyncButton variant="secondary" onClick={cancelPay}>
                {t.gsPayCancel}
              </AsyncButton>
            </>
          ) : data.pay.unconfirmed ? (
            <p className="muted">{t.gsPayUnconfirmed}</p>
          ) : (
            <>
              {data.pay.pointsDiscount > 0 ? (
                <p className="guest-total">
                  <span>{t.gsPointsDiscount}</span>
                  <strong className="tabular">−{money(data.pay.pointsDiscount)}</strong>
                </p>
              ) : null}
              <p className="guest-total">
                <span>{t.gsPayTotal}</span>
                <strong className="tabular">{money(data.pay.total)}</strong>
              </p>
              <AsyncButton onClick={pay}>{t.gsPay}</AsyncButton>
            </>
          )}
        </section>
      ) : null}

      {open ? (
        <ItemSheet
          key={open.id}
          item={open}
          groups={groupsOf(menu, open)}
          onClose={() => setOpen(null)}
          onAdd={(optionIds, quantity, note) => {
            keySeq.current += 1;
            changeCart(
              addToGuestCart(
                cart,
                { itemId: open.id, quantity, optionIds, note },
                `k${keySeq.current}`,
              ),
            );
            setOpen(null);
          }}
        />
      ) : null}
    </div>
  );
}

function ItemSheet({
  item,
  groups,
  onAdd,
  onClose,
}: {
  item: GuestItem;
  groups: GuestGroup[];
  onAdd: (optionIds: string[], quantity: number, note: string) => void;
  onClose: () => void;
}) {
  const { t, lang } = useI18n();
  const locale = lang === 'th' ? 'th-TH' : 'en-GB';
  const name = guestName(item.name, lang);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState('');
  const selected = Object.values(picked).flat();
  const ok = guestSelectionProblem(groups, selected) === null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggle = (g: GuestGroup, id: string) =>
    setPicked((p) => {
      const cur = p[g.id] ?? [];
      if (g.max === 1) return { ...p, [g.id]: cur[0] === id ? [] : [id] };
      return {
        ...p,
        [g.id]: cur.includes(id)
          ? cur.filter((x) => x !== id)
          : cur.length < g.max
            ? [...cur, id]
            : cur,
      };
    });

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={fmt(t.gsChoose, { name })}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          <h2>{name}</h2>
          <button type="button" className="sheet-close" aria-label={t.gsClose} onClick={onClose}>
            ✕
          </button>
        </div>
        {groups.map((g) => {
          const chosen = picked[g.id] ?? [];
          return (
            <fieldset key={g.id} className="audit-group">
              <legend>
                {guestName(g.name, lang)}{' '}
                <span className="muted">
                  {g.min > 0 ? `${t.gsPickRequired} · ` : ''}
                  {fmt(t.gsPickRule, { min: g.min, max: g.max })}
                </span>
              </legend>
              {g.options.map((o) => (
                <label key={o.id} className="check-row">
                  <input
                    type={g.max === 1 ? 'radio' : 'checkbox'}
                    name={g.id}
                    checked={chosen.includes(o.id)}
                    disabled={g.max > 1 && !chosen.includes(o.id) && chosen.length >= g.max}
                    onChange={() => toggle(g, o.id)}
                  />
                  <span>{guestName(o.name, lang)}</span>
                  {o.delta !== 0 ? (
                    <span className="muted tabular">
                      {o.delta > 0 ? '+' : '−'}
                      {formatTHB(Math.abs(o.delta), locale)}
                    </span>
                  ) : null}
                </label>
              ))}
            </fieldset>
          );
        })}
        <div className="form-row">
          <label className="label" htmlFor="guest-note">
            {t.gsNote}
          </label>
          <input
            id="guest-note"
            className="field"
            value={note}
            maxLength={200}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <div className="qty-stepper" role="group" aria-label={fmt(t.gsQtyLabel, { name })}>
          <button
            type="button"
            aria-label={fmt(t.gsLess, { name })}
            disabled={qty <= 1}
            onClick={() => setQty(qty - 1)}
          >
            −
          </button>
          <output className="tabular">{qty}</output>
          <button
            type="button"
            aria-label={fmt(t.gsMore, { name })}
            disabled={qty >= 99}
            onClick={() => setQty(qty + 1)}
          >
            +
          </button>
        </div>
        <div className="actions">
          <button
            type="button"
            className="btn"
            disabled={!ok}
            onClick={() => onAdd(selected, qty, note)}
          >
            {t.gsAddToCart} · {formatTHB(unitPrice(item, groups, selected) * qty, locale)}
          </button>
        </div>
      </div>
    </div>
  );
}

/** One dish in the list: name, price, and what the shop says about it (recommended, spice, what it contains). */
function ItemButton({
  item,
  lang,
  money,
  onOpen,
}: {
  item: GuestItem;
  lang: 'th' | 'en';
  money: (n: number) => string;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const contains = item.food.tags
    .filter((x) => x.startsWith('contains_'))
    .map((x) => dietName(t, x));
  const labels = item.food.tags
    .filter((x) => !x.startsWith('contains_'))
    .map((x) => dietName(t, x));
  const facts = [
    ...labels,
    ...(item.food.spice !== null && item.food.spice > 0
      ? [fmt(t.gsSpiceLevel, { n: item.food.spice })]
      : []),
    ...(contains.length ? [fmt(t.gsContains, { list: contains.join(', ') })] : []),
  ];
  return (
    <button type="button" className="guest-item" onClick={onOpen}>
      <span className="guest-item-name">
        {guestName(item.name, lang)}
        {item.food.highlight ? <span className="badge">{t.gsRecommended}</span> : null}
        {facts.length ? <span className="muted guest-item-facts">{facts.join(' · ')}</span> : null}
      </span>
      <span className="tabular">{money(item.price)}</span>
    </button>
  );
}
