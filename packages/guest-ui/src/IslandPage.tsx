import { useEffect, useState } from 'react';
import { guestName, joinLink } from '@bestie/core';
import type { Island } from '@bestie/core';
import { GUEST_LANGS, useI18n } from '@bestie/i18n';
import { LangSwitch, Spinner } from '@bestie/ui';
import { IslandShops } from './IslandShops';
import { loadIsland } from './networkApi';
import type { Loaded } from './networkApi';

/** The public island page (`/island/<network>`): the shops that joined, by category, with booking links. No account, no commission. */
export function IslandPage({ slug }: { slug: string }) {
  const { t, lang } = useI18n();
  const [load, setLoad] = useState<Loaded<Island> | null>(null);
  useEffect(() => {
    let alive = true;
    void loadIsland(slug).then((r) => alive && setLoad(r));
    return () => {
      alive = false;
    };
  }, [slug]);

  const head = (
    <div className="guest-head">
      <h1>{load?.ok ? guestName(load.data.name, lang) : t.npShops}</h1>
      <LangSwitch langs={GUEST_LANGS} />
    </div>
  );
  if (!load)
    return (
      <>
        {head}
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      </>
    );
  if (!load.ok)
    return (
      <>
        {head}
        <p role="alert">{load.reason === 'not_found' ? t.niNotFound : t.niFailed}</p>
      </>
    );
  const about = load.data.about
    ? lang === 'th'
      ? load.data.about.th
      : load.data.about.en || load.data.about.th
    : null;
  return (
    <>
      {head}
      {about ? <p>{about}</p> : null}
      <a className="btn btn-primary" href={joinLink('', load.data.slug)}>
        {t.niGetPass}
      </a>
      <IslandShops shops={load.data.shops} />
    </>
  );
}
