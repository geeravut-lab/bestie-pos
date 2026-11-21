import { useState } from 'react';
import type { IslandShop, NetworkCategory } from '@bestie/core';
import { NETWORK_CATEGORIES, guestName } from '@bestie/core';
import { useI18n } from '@bestie/i18n';
import type { Dict } from '@bestie/i18n';

const CAT_KEY: Record<NetworkCategory, keyof Dict> = {
  food: 'niCatFood',
  cafe: 'niCatCafe',
  beauty: 'niCatBeauty',
  spa: 'niCatSpa',
  stay: 'niCatStay',
  shop: 'niCatShop',
  tour: 'niCatTour',
  other: 'niCatOther',
};

/** The shops of a network with a category filter. Names and descriptions are the shop's own words (Thai, English); other languages show English. */
export function IslandShops({ shops }: { shops: readonly IslandShop[] }) {
  const { t, lang } = useI18n();
  const [cat, setCat] = useState<NetworkCategory | 'all'>('all');
  const [query, setQuery] = useState('');
  const present = NETWORK_CATEGORIES.filter((c) => shops.some((s) => s.category === c));
  const q = query.trim().toLowerCase();
  const byCat = cat === 'all' ? shops : shops.filter((s) => s.category === cat);
  // a text search over the shop's name and description in both languages (and its category word)
  const shown = q
    ? byCat.filter((s) =>
        [s.title.th, s.title.en, s.about?.th, s.about?.en, t[CAT_KEY[s.category]]]
          .filter((x): x is string => typeof x === 'string')
          .some((x) => x.toLowerCase().includes(q)),
      )
    : byCat;
  return (
    <div className="island-shops">
      <input
        className="field"
        type="search"
        aria-label={t.niSearch}
        placeholder={t.niSearch}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {present.length > 1 ? (
        <div className="island-filter" role="group" aria-label={t.npShops}>
          <button type="button" aria-pressed={cat === 'all'} onClick={() => setCat('all')}>
            {t.niAll}
          </button>
          {present.map((c) => (
            <button key={c} type="button" aria-pressed={cat === c} onClick={() => setCat(c)}>
              {t[CAT_KEY[c]]}
            </button>
          ))}
        </div>
      ) : null}
      {shown.length === 0 ? <p className="muted">{q ? t.niNoMatch : t.niEmpty}</p> : null}
      <ul className="island-list">
        {shown.map((s, i) => {
          const about = s.about ? (lang === 'th' ? s.about.th : s.about.en || s.about.th) : null;
          return (
            <li key={`${s.title.th}-${i}`} className="card island-shop">
              <p className="muted island-cat">{t[CAT_KEY[s.category]]}</p>
              <h3>{guestName(s.title, lang)}</h3>
              {about ? <p>{about}</p> : null}
              {s.orderToken ? (
                <a className="btn btn-primary" href={`/t/${s.orderToken}`}>
                  {t.niOrder}
                </a>
              ) : null}
              {s.bookingToken ? (
                <a className="btn btn-secondary" href={`/book/${s.bookingToken}`}>
                  {t.niBook}
                </a>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
