import { useEffect, useState } from 'react';
import {
  SPA_FLAGS,
  SPA_RULES,
  SPA_RULES_VERSION,
  SPA_TAGS,
  guestName,
  parseSpaTags,
} from '@bestie/core';
import type { SpaTag } from '@bestie/core';
import { fmt, formatDateTime, useI18n } from '@bestie/i18n';
import type { Dict } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { PrintPortal } from './PrintPortal';
import { useRemote } from './useRemote';

const tx = (t: Dict, key: string): string => (t as Record<string, string>)[key] ?? key;
type Svc = { id: string; name: { th: string; en?: string }; tags: SpaTag[] };
type Loaded = { services: Svc[]; signoff: { name: string; at: string; version: number } | null };

/** Tag the services, read the rules, record the therapist's sign-off. The advisor reaches guests only when all three are in place. */
export function SpaAdvisorPage({ ctx }: { ctx: PageContext }) {
  const { t, lang } = useI18n();
  const storeId = ctx.storeId ?? ctx.homeStoreId ?? null;
  const canEdit = ctx.isOwner || ctx.permissions.includes('menu.edit');
  const [draft, setDraft] = useState<Record<string, SpaTag[]>>({});
  const [note, setNote] = useState<'saved' | 'failed' | null>(null);
  const [name, setName] = useState('');
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    if (!printing) return;
    const id = window.setTimeout(() => {
      window.print();
      setPrinting(false);
    }, 60);
    return () => window.clearTimeout(id);
  }, [printing]);

  const data = useRemote<Loaded>(async () => {
    if (!storeId) return { services: [], signoff: null };
    const [m, s] = await Promise.all([
      ctx.client
        .from('menu_items')
        .select('id, name, spa_tags, duration_min')
        .eq('store_id', storeId)
        .is('deleted_at', null)
        .not('duration_min', 'is', null)
        .order('sort'),
      ctx.client.from('stores').select('spa_rules_signoff').eq('id', storeId).maybeSingle(),
    ]);
    if (m.error) throw new Error('load');
    const so = ((s.data ?? {}) as { spa_rules_signoff?: Record<string, unknown> | null })
      .spa_rules_signoff;
    return {
      services: ((m.data ?? []) as Record<string, unknown>[]).map((r) => {
        const n = (r.name ?? {}) as { th?: string; en?: string };
        return {
          id: String(r.id),
          name: { th: n.th ?? '', ...(n.en ? { en: n.en } : {}) },
          tags: parseSpaTags(r.spa_tags),
        };
      }),
      signoff:
        so && typeof so.name === 'string'
          ? { name: so.name, at: String(so.at ?? ''), version: Number(so.version) || 0 }
          : null,
    };
  }, storeId ?? '');

  if (data.status === 'loading')
    return (
      <div className="admin-page">
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      </div>
    );
  if (data.status === 'error' || !data.data)
    return (
      <div className="admin-page">
        <Notice kind="error">{t.err_load_failed}</Notice>
      </div>
    );
  const { services, signoff } = data.data;
  const tagsOf = (s: Svc): SpaTag[] => draft[s.id] ?? s.tags;
  const flip = (s: Svc, tag: SpaTag) => {
    const cur = tagsOf(s);
    const next = cur.includes(tag) ? cur.filter((x) => x !== tag) : [...cur, tag];
    if (next.length > 6) return;
    setDraft({ ...draft, [s.id]: next });
  };
  const save = async (s: Svc) => {
    setNote(null);
    const r = await ctx.client.rpc('save_spa_tags', { p_item: s.id, p_tags: tagsOf(s) });
    setNote(r.error ? 'failed' : 'saved');
    if (!r.error) data.reload();
  };
  const confirm = async (withdraw: boolean) => {
    setNote(null);
    if (!storeId) return;
    const r = await ctx.client.rpc('confirm_spa_rules', {
      p_store: storeId,
      p_name: withdraw ? null : name.trim(),
    });
    setNote(r.error ? 'failed' : 'saved');
    if (!r.error) {
      setName('');
      data.reload();
    }
  };
  const current = signoff && signoff.version === SPA_RULES_VERSION;
  const rulesTable = (
    <table className="clearing-table">
      <thead>
        <tr>
          <th />
          <th>{t.saAvoid}</th>
          <th>{t.saAsk}</th>
        </tr>
      </thead>
      <tbody>
        {SPA_FLAGS.map((f) => {
          const r = SPA_RULES[f];
          const list = (v: 'avoid' | 'ask') =>
            SPA_TAGS.filter((x) => r[x] === v)
              .map((x) => tx(t, `saTag_${x}`))
              .join('; ');
          return (
            <tr key={f}>
              <td>{tx(t, `spaFlag_${f}`)}</td>
              <td>{f === 'fever_infection' ? '—' : list('avoid')}</td>
              <td>{list('ask')}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  return (
    <div className="admin-page">
      {printing ? (
        <PrintPortal pageCss="@page { size: A4; margin: 12mm; }">
          <div className="return-slip" style={{ width: 'auto' }}>
            <h1>{t.saRulesTitle}</h1>
            <p>{fmt(t.saRulesVersion, { v: SPA_RULES_VERSION })}</p>
            <p>{t.saRulesHow}</p>
            {rulesTable}
          </div>
        </PrintPortal>
      ) : null}
      <h1>{t.saTitle}</h1>
      <Notice kind="info">{t.saIntro}</Notice>
      <Notice kind="info">{t.saModule}</Notice>
      {note === 'saved' ? <Notice kind="success">{t.saSaved}</Notice> : null}
      {note === 'failed' ? <Notice kind="error">{t.saSaveFailed}</Notice> : null}

      <section className="card admin-card" aria-label={t.saSignoff}>
        <h2>{t.saSignoff}</h2>
        <p className="muted">{fmt(t.saRulesVersion, { v: SPA_RULES_VERSION })}</p>
        <p className="muted">{t.saRulesRead}</p>
        {signoff && current ? (
          <Notice kind="success">
            {fmt(t.saSignedBy, { name: signoff.name, at: formatDateTime(lang, signoff.at) })}
          </Notice>
        ) : signoff ? (
          <Notice kind="error">{t.saOutdated}</Notice>
        ) : (
          <Notice kind="info">{t.saNotSigned}</Notice>
        )}
        {ctx.isOwner ? (
          <form className="auth-form" onSubmit={(e) => e.preventDefault()}>
            <div className="form-row">
              <label className="label" htmlFor="sa-name">
                {t.saTherapist}
              </label>
              <input
                id="sa-name"
                className="field"
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="actions">
              <AsyncButton
                type="submit"
                disabled={name.trim().length < 2}
                onClick={() => confirm(false)}
              >
                {t.saConfirm}
              </AsyncButton>
              {signoff ? (
                <AsyncButton variant="secondary" onClick={() => confirm(true)}>
                  {t.saWithdraw}
                </AsyncButton>
              ) : null}
            </div>
          </form>
        ) : (
          <p className="muted">{t.saOwnerOnly}</p>
        )}
      </section>

      <section className="card admin-card" aria-label={t.saServices}>
        <h2>{t.saServices}</h2>
        <p className="muted">{t.saTagsMax}</p>
        {services.length === 0 ? <p className="muted">{t.saNoServices}</p> : null}
        {services.map((s) => (
          <fieldset key={s.id} className="form-row" disabled={!canEdit}>
            <legend className="label">{guestName(s.name, lang)}</legend>
            <div className="chips">
              {SPA_TAGS.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className="chip"
                  aria-pressed={tagsOf(s).includes(tag)}
                  onClick={() => flip(s, tag)}
                >
                  {tx(t, `saTag_${tag}`)}
                </button>
              ))}
            </div>
            {draft[s.id] ? (
              <AsyncButton variant="secondary" onClick={() => save(s)}>
                {t.nwSave}
              </AsyncButton>
            ) : null}
          </fieldset>
        ))}
      </section>

      <section className="card admin-card" aria-label={t.saRulesTitle}>
        <h2>{t.saRulesTitle}</h2>
        <p className="muted">{t.saRulesHow}</p>
        {rulesTable}
        <div className="actions">
          <AsyncButton variant="secondary" onClick={async () => setPrinting(true)}>
            {t.saPrint}
          </AsyncButton>
        </div>
      </section>
    </div>
  );
}
