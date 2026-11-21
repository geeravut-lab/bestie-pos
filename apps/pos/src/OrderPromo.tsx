import { useEffect, useState } from 'react';
import {
  applyPromotion,
  clearPromotion,
  formatTHB,
  guestName,
  offerablePromotions,
  parsePromotions,
  parseUpsellRules,
  suggestUpsells,
} from '@bestie/core';
import type { OrderDoc, Promotion } from '@bestie/core';
import type { Item, Menu } from '@bestie/admin-ui';
import { fmt, useI18n } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import type { PageContext } from '@bestie/auth';
import { cachedRead } from '@bestie/offline';

type Extras = { promos: Promotion[]; rules: ReturnType<typeof parseUpsellRules> };

/** The shop's promotions and "offer also" suggestions, kept for offline use. Both only touch lines that are not sent yet. */
export function useOrderExtras(ctx: PageContext, storeId: string): Extras | null {
  const [x, setX] = useState<Extras | null>(null);
  useEffect(() => {
    let alive = true;
    if (!storeId) return;
    void cachedRead(`extras:${storeId}`, async () => {
      const [p, r] = await Promise.all([
        ctx.client.from('promotions').select('*').eq('store_id', storeId).eq('active', true),
        ctx.client
          .from('upsell_rules')
          .select('id, item_id, suggest_id, sort, active')
          .eq('store_id', storeId)
          .eq('active', true),
      ]);
      if (p.error || r.error) throw new Error('extras');
      return { promos: p.data ?? [], rules: r.data ?? [] };
    })
      .then((res) => {
        if (alive)
          setX({
            promos: parsePromotions(res.data.promos),
            rules: parseUpsellRules(res.data.rules),
          });
      })
      .catch(() => {
        if (alive) setX({ promos: [], rules: [] });
      });
    return () => {
      alive = false;
    };
  }, [ctx.client, storeId]);
  return x;
}

export function OrderPromo({
  order,
  menu,
  extras,
  apply,
  onAdd,
}: {
  order: OrderDoc;
  menu: Menu;
  extras: Extras;
  apply: (fn: (o: OrderDoc) => OrderDoc) => Promise<void>;
  onAdd: (item: Item) => void;
}) {
  const { t, lang } = useI18n();
  const locale = lang === 'th' ? ('th-TH' as const) : ('en-GB' as const);
  const [code, setCode] = useState('');
  const [note, setNote] = useState<string | null>(null);
  // the clock the promotions are judged by: refreshed every 30 seconds so a happy hour starts and ends by itself
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  const offers = offerablePromotions(extras.promos, order, { now, code });
  const hasPromo = order.lines.some((l) => l.status === 'new' && l.promoId);
  const live = order.lines.filter((l) => l.status !== 'void');
  const availableIds = new Set(menu.items.filter((i) => i.available).map((i) => i.id));
  const ids = suggestUpsells(
    live.map((l) => l.itemId).filter((x): x is string => x !== null),
    extras.rules,
    availableIds,
  );
  const suggested = ids
    .map((id) => menu.items.find((i) => i.id === id))
    .filter((i): i is Item => i !== undefined);
  if (
    offers.length === 0 &&
    !hasPromo &&
    suggested.length === 0 &&
    extras.promos.every((p) => p.code === null)
  )
    return null;
  const use = async (p: Promotion) => {
    setNote(null);
    const r = applyPromotion(order, p, { now });
    if ('error' in r)
      return setNote(
        r.error === 'not_running'
          ? t.prNotRunning
          : r.error === 'min_subtotal'
            ? t.prMinNot
            : t.prNothing,
      );
    await apply(() => r.order);
    setNote(fmt(t.prAppliedSave, { money: formatTHB(r.given, locale) }));
  };
  return (
    <section className="card admin-card" aria-label={t.prTill}>
      {offers.length > 0 || hasPromo || extras.promos.some((p) => p.code !== null) ? (
        <>
          <h2>{t.prTill}</h2>
          {extras.promos.some((p) => p.code !== null) ? (
            <div className="form-row">
              <label className="label" htmlFor="promo-code">
                {t.prCodeField}
              </label>
              <input
                id="promo-code"
                className="field"
                maxLength={20}
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
              />
            </div>
          ) : null}
          <div className="chips">
            {offers.map((p) => (
              <AsyncButton key={p.id} variant="secondary" onClick={() => use(p)}>
                {t.prApply}: {p.name}
              </AsyncButton>
            ))}
            {hasPromo ? (
              <AsyncButton variant="secondary" onClick={() => apply((o) => clearPromotion(o))}>
                {t.prRemove}
              </AsyncButton>
            ) : null}
          </div>
          {note ? (
            <p className="muted" role="status">
              {note}
            </p>
          ) : null}
        </>
      ) : null}
      {suggested.length > 0 ? (
        <>
          <h2>{t.upTill}</h2>
          <div className="chips">
            {suggested.map((i) => (
              <button key={i.id} type="button" className="chip" onClick={() => onAdd(i)}>
                + {guestName(i.name, lang)}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}
