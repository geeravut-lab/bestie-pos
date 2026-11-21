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
  menuImageUrl,
  packCart,
  restoreCart,
  setCartQuantity,
  statusStep,
  unitPrice,
} from '@bestie/core';
import type { CartLine, DietFilter, GuestGroup, GuestItem } from '@bestie/core';
import { GUEST_LANGS, fmt, useI18n } from '@bestie/i18n';
import type { Dict } from '@bestie/i18n';
import { AsyncButton, LangSwitch, Spinner } from '@bestie/ui';
import { FeedbackForm, ShopInfo } from './ShopInfo';
import {
  callStaff,
  cancelGuestPayment,
  guestPaymentStatus,
  loadGuestTable,
  placeGuestOrder,
  startGuestPayment,
} from './guestApi';
import { FoodFilter, dietName } from './FoodFilter';
import type { GuestCharge, GuestFailure, GuestLoad, GuestTable, PlacedOrder } from './guestApi';

const POLL_MS = 4_000; // everybody at a table sees the same bill within a few seconds (a guest has no account, so no push channel)
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
      <LangSwitch langs={GUEST_LANGS} />
    </header>
  );
}

function GuestOrdering({ token, initial }: { token: string; initial: GuestTable }) {
  const { t, lang } = useI18n();
  const locale = lang === 'th' ? 'th-TH' : 'en-GB';
  const [data, setData] = useState(initial);
  const cartKey = `bestie-guest-cart:${token}`;
  // the basket survives closing the browser: it is kept on THIS phone only (no account, nothing is sent until "Place order")
  const [cart, setCart] = useState<CartLine[]>(() => {
    try {
      return restoreCart(
        globalThis.localStorage?.getItem(cartKey) ?? null,
        initial.menu,
        Date.now(),
      );
    } catch {
      return [];
    }
  });
  const [open, setOpen] = useState<GuestItem | null>(null);
  const [cat, setCat] = useState('');
  const [diet, setDiet] = useState<DietFilter>(EMPTY_FILTER);
  const [error, setError] = useState<GuestFailure | null>(null);
  const [placed, setPlaced] = useState<PlacedOrder | null>(null);
  const web = data.kind === 'web';
  const infoOnly = data.kind === 'info';
  const contactKey = `bestie-guest-contact:${token}`;
  const [contact, setContact] = useState<{ name: string; phone: string }>(() => {
    try {
      const v = JSON.parse(globalThis.localStorage?.getItem(contactKey) ?? 'null') as {
        name?: string;
        phone?: string;
      } | null;
      return { name: v?.name ?? '', phone: v?.phone ?? '' };
    } catch {
      return { name: '', phone: '' };
    }
  });
  const contactOk =
    !web || (contact.name.trim().length > 0 && contact.phone.replace(/\D/g, '').length >= 6);
  const [charge, setCharge] = useState<GuestCharge | null>(initial.pay.live);
  const [paid, setPaid] = useState<{ receipt: string | null } | null>(null);
  const [payNote, setPayNote] = useState<'failed' | 'review' | null>(null);
  const [payError, setPayError] = useState<GuestFailure | null>(null);
  // One id per basket: pressing "Place order" again after a lost answer can never order twice; changing the basket starts a new id.
  const clientId = useRef(newId());
  const keySeq = useRef(0);
  const menu = data.menu;

  useEffect(() => {
    try {
      if (cart.length === 0) globalThis.localStorage?.removeItem(cartKey);
      else globalThis.localStorage?.setItem(cartKey, packCart(cart, Date.now()));
    } catch {
      /* private mode: the basket just is not remembered */
    }
  }, [cart, cartKey]);

  // keep the "already ordered" list fresh while the page is visible
  useEffect(() => {
    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      const r = await loadGuestTable(token);
      if (r.ok)
        setData((d) => ({ ...d, bill: r.data.bill, menu: r.data.menu, autoSend: r.data.autoSend }));
    };
    const id = setInterval(() => void tick(), POLL_MS);
    // coming back to the page (after the phone slept, or another app) refreshes at once instead of waiting for the next beat
    const onVisible = () => void tick();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
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
    if (web) {
      try {
        globalThis.localStorage?.setItem(contactKey, JSON.stringify(contact));
      } catch {
        /* private mode: just not remembered */
      }
    }
    const r = await placeGuestOrder(
      token,
      clientId.current,
      cart,
      undefined,
      web ? { name: contact.name.trim(), phone: contact.phone.trim() } : undefined,
    );
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

      {placed && data.kiosk ? (
        <section className="card guest-sent kiosk-number" role="status">
          <h2>{t.kioskNumberTitle}</h2>
          <p className="kiosk-big tabular">{placed.number}</p>
          <p>{web ? t.webPickupNote : t.kioskPayAtCounter}</p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setPlaced(null);
              clientId.current = newId();
            }}
          >
            {t.kioskNew}
          </button>
        </section>
      ) : null}
      {placed && !data.kiosk ? (
        <section className="card guest-sent" role="status">
          <h2>{t.gsSentTitle}</h2>
          <p>{placed.status === 'sent' ? t.gsSentKitchen : t.gsSentWaiting}</p>
          {placed.number ? (
            <p className="muted">{fmt(t.gsOrderNumber, { number: placed.number })}</p>
          ) : null}
        </section>
      ) : null}

      {infoOnly ? null : menu.categories.length > 1 ? (
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

      {infoOnly ? <p className="muted">{t.guestInfoIntro}</p> : null}
      {data.kiosk ? (
        <p className="muted">{web ? t.webIntro : t.kioskIntro}</p>
      ) : (
        <CallStaff token={token} />
      )}
      {data.kiosk ? null : <ShopInfo token={token} ai={data.ai} />}
      {infoOnly ? null : <FoodFilter token={token} ai={data.ai} filter={diet} onChange={setDiet} />}
      {dietActive && !infoOnly ? <p className="muted">{t.gsFilterWarning}</p> : null}

      {!infoOnly && menu.items.length === 0 ? <p className="muted">{t.gsEmptyMenu}</p> : null}
      {menu.items.length > 0 && items.length === 0 && dietActive ? (
        <p className="muted">{t.gsFilterNone}</p>
      ) : null}
      <ul className="guest-items">
        {(infoOnly ? [] : items).map((i) => (
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

      {infoOnly ? null : (
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
                      {optionNames.length ? (
                        <p className="muted">{optionNames.join(', ')}</p>
                      ) : null}
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
          {cart.length > 0 && web ? (
            <div className="form-row">
              <label className="label" htmlFor="web-name">
                {t.webName}
              </label>
              <input
                id="web-name"
                className="field"
                autoComplete="name"
                maxLength={80}
                value={contact.name}
                onChange={(e) => setContact({ ...contact, name: e.target.value })}
              />
              <label className="label" htmlFor="web-phone">
                {t.webPhone}
              </label>
              <input
                id="web-phone"
                className="field"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                maxLength={30}
                value={contact.phone}
                onChange={(e) => setContact({ ...contact, phone: e.target.value })}
              />
            </div>
          ) : null}
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
                <AsyncButton onClick={send} disabled={!contactOk}>
                  {t.gsSend} ({cartCount(cart)})
                </AsyncButton>
              )}
            </>
          ) : null}
        </section>
      )}

      {!data.kiosk && data.bill.lines.length > 0 ? (
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
      ) : !data.kiosk && data.pay.enabled && data.bill.lines.length > 0 && data.pay.total > 0 ? (
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

      {data.kiosk ? null : <FeedbackForm token={token} />}

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
  lang: string;
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
      {menuImageUrl(item.id, item.imageV) ? (
        <img
          className="guest-item-pic"
          src={menuImageUrl(item.id, item.imageV)!}
          alt=""
          loading="lazy"
        />
      ) : null}
      <span className="guest-item-name">
        {guestName(item.name, lang)}
        {item.food.highlight ? <span className="badge">{t.gsRecommended}</span> : null}
        {facts.length ? <span className="muted guest-item-facts">{facts.join(' · ')}</span> : null}
      </span>
      <span className="tabular">{money(item.price)}</span>
    </button>
  );
}

/** Two always-visible buttons: ask for help, ask for the bill. A second tap while a call is open says so instead of adding another. */
function CallStaff({ token }: { token: string }) {
  const { t } = useI18n();
  const [note, setNote] = useState<'called' | 'already' | 'failed' | null>(null);
  const call = async (reason: 'help' | 'bill') => setNote(await callStaff(token, reason));
  return (
    <section className="guest-call" aria-label={t.gsCallTitle}>
      <div className="actions">
        <AsyncButton variant="secondary" onClick={() => call('help')}>
          {t.gsCallHelp}
        </AsyncButton>
        <AsyncButton variant="secondary" onClick={() => call('bill')}>
          {t.gsCallBill}
        </AsyncButton>
      </div>
      {note === 'called' || note === 'already' ? (
        <p className="notice notice-success" role="status">
          {note === 'called' ? t.gsCalled : t.gsCallAlready}
        </p>
      ) : null}
      {note === 'failed' ? (
        <p className="notice notice-error" role="alert">
          {t.gsCallFailed}
        </p>
      ) : null}
    </section>
  );
}
