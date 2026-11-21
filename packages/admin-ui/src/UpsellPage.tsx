import { useState } from 'react';
import { guestName, pairConfidence, parsePairStats, parseUpsellRules } from '@bestie/core';
import type { LocalizedText, PairStat } from '@bestie/core';
import { fmt, useI18n } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice, useLiveSync } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useRemote } from './useRemote';

/** "When this dish is on the bill, offer that one" rules, plus the pairs customers really order together (needs `menu.edit`; pairs need `report.view`). */
export function UpsellPage({ ctx }: { ctx: PageContext }) {
  const { t, lang } = useI18n();
  const storeId = ctx.storeId ?? ctx.homeStoreId ?? null;
  const canEdit = ctx.isOwner || ctx.permissions.includes('menu.edit');
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [pairs, setPairs] = useState<PairStat[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const data = useRemote(async () => {
    if (!storeId) throw new Error('no store');
    const [rules, items] = await Promise.all([
      ctx.client
        .from('upsell_rules')
        .select('id, item_id, suggest_id, sort, active')
        .eq('store_id', storeId)
        .order('sort'),
      ctx.client
        .from('menu_items')
        .select('id, name')
        .eq('store_id', storeId)
        .is('deleted_at', null)
        .order('sort'),
    ]);
    if (rules.error || items.error) throw new Error('load');
    return {
      rules: parseUpsellRules(rules.data),
      items: (items.data ?? []) as { id: string; name: LocalizedText }[],
    };
  }, `${storeId}`);
  const { reload } = data;
  useLiveSync(ctx.client, storeId ? [`store:${storeId}`] : [], reload);
  const d = data.data;
  const nameOf = (id: string) => {
    const i = d?.items.find((x) => x.id === id);
    return i ? guestName(i.name, lang) : '…';
  };
  const add = async (item: string, suggest: string) => {
    setMsg(null);
    if (!item || !suggest || item === suggest) return setMsg(t.upSame);
    const r = await ctx.client.rpc('save_upsell_rule', {
      p: { store_id: storeId, item_id: item, suggest_id: suggest },
    });
    if (r.error) return setMsg(r.error.code === '42501' ? t.err_forbidden : t.err_save_failed);
    setA('');
    setB('');
    reload();
  };
  const loadPairs = async () => {
    setMsg(null);
    const r = await ctx.client.rpc('pair_stats', { p: { store_id: storeId, days: 60 } });
    if (r.error) return setMsg(r.error.code === '42501' ? t.err_forbidden : t.err_load_failed);
    setPairs(parsePairStats(r.data));
  };
  const remove = async (id: string) => {
    const r = await ctx.client.rpc('delete_upsell_rule', { p_id: id });
    if (r.error) return setMsg(t.err_save_failed);
    reload();
  };
  const options = (
    <>
      <option value="">—</option>
      {(d?.items ?? []).map((i) => (
        <option key={i.id} value={i.id}>
          {guestName(i.name, lang)}
        </option>
      ))}
    </>
  );
  return (
    <div className="admin-page">
      <h1>{t.upTitle}</h1>
      <Notice kind="info">{t.upIntro}</Notice>
      {msg ? <Notice kind="error">{msg}</Notice> : null}
      {data.status === 'loading' ? (
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      ) : null}
      {d && d.rules.length === 0 ? <p className="muted">{t.upNone}</p> : null}
      <ul className="member-list">
        {(d?.rules ?? []).map((r) => (
          <li key={r.id} className="card admin-card">
            {t.upWhen} <strong>{nameOf(r.itemId)}</strong> → {t.upOffer}{' '}
            <strong>{nameOf(r.suggestId)}</strong>
            {canEdit ? (
              <AsyncButton variant="secondary" onClick={() => remove(r.id)}>
                {t.upDelete}
              </AsyncButton>
            ) : null}
          </li>
        ))}
      </ul>
      {canEdit ? (
        <form
          className="card admin-card auth-form"
          onSubmit={(e) => e.preventDefault()}
          aria-label={t.upAdd}
        >
          <div className="form-row">
            <label className="label" htmlFor="up-a">
              {t.upWhen}
            </label>
            <select id="up-a" className="field" value={a} onChange={(e) => setA(e.target.value)}>
              {options}
            </select>
          </div>
          <div className="form-row">
            <label className="label" htmlFor="up-b">
              {t.upOffer}
            </label>
            <select id="up-b" className="field" value={b} onChange={(e) => setB(e.target.value)}>
              {options}
            </select>
          </div>
          <div className="actions">
            <AsyncButton type="submit" onClick={() => add(a, b)}>
              {t.upAdd}
            </AsyncButton>
            <AsyncButton variant="secondary" onClick={loadPairs}>
              {t.upSuggest}
            </AsyncButton>
          </div>
        </form>
      ) : null}
      {pairs ? (
        <section className="card admin-card" aria-label={t.upSuggest}>
          {pairs.length === 0 ? <p className="muted">{t.upNoPairs}</p> : null}
          <ul>
            {pairs.map((p) => (
              <li key={`${p.a}|${p.b}`}>
                <strong>{guestName(p.aName, lang)}</strong> →{' '}
                <strong>{guestName(p.bName, lang)}</strong>:{' '}
                {fmt(t.upPairs, {
                  together: p.together,
                  pct: pairConfidence(p),
                  a: guestName(p.aName, lang),
                })}{' '}
                {canEdit ? (
                  <AsyncButton variant="secondary" onClick={() => add(p.a, p.b)}>
                    {t.upUse}
                  </AsyncButton>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
