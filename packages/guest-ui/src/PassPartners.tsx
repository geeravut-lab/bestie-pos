import { useEffect, useState } from 'react';
import type { PassPartner } from '@bestie/core';
import { useI18n } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { loadPassPartners, setPassBlock } from './networkApi';

/** The guest decides which businesses of the network share her points: each one has its own switch (on = sharing). */
export function PassPartners({ token }: { token: string }) {
  const { t } = useI18n();
  const [partners, setPartners] = useState<PassPartner[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    void loadPassPartners(token).then((p) => alive && setPartners(p));
    return () => {
      alive = false;
    };
  }, [token]);
  if (!partners || partners.length < 2) return null; // with one business there is nothing to choose
  const flip = async (p: PassPartner) => {
    setFailed(false);
    const ok = await setPassBlock(token, p.orgId, !p.blocked);
    if (!ok) return setFailed(true);
    setPartners((list) =>
      list ? list.map((x) => (x.orgId === p.orgId ? { ...x, blocked: !p.blocked } : x)) : list,
    );
  };
  return (
    <section className="card" aria-label={t.pcnTitle}>
      <h2>{t.pcnTitle}</h2>
      <p className="muted">{t.pcnIntro}</p>
      <ul className="pass-history">
        {partners.map((p) => (
          <li key={p.orgId}>
            <span>{p.name}</span>
            <AsyncButton variant="secondary" aria-pressed={!p.blocked} onClick={() => flip(p)}>
              {p.blocked ? t.pcnOff : t.pcnOn}
            </AsyncButton>
          </li>
        ))}
      </ul>
      {failed ? <p role="alert">{t.pcnFailed}</p> : null}
    </section>
  );
}
