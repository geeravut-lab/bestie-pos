import { useEffect, useState } from 'react';
import { useI18n } from '@bestie/i18n';
import { AsyncButton, QrSvg, Spinner } from '@bestie/ui';
import { Notice, useLiveSync } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { PrintPortal } from './PrintPortal';
import { useRemote } from './useRemote';

type Kiosk = { id: string; name: string; token: string; active: boolean };

const rows = (v: unknown): Kiosk[] =>
  (Array.isArray(v) ? v : []).flatMap((x) => {
    const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    return typeof o.id === 'string' && typeof o.name === 'string' && typeof o.qr_token === 'string'
      ? [{ id: o.id, name: o.name, token: o.qr_token, active: o.active !== false }]
      : [];
  });

/** Self-order kiosks (module `kiosk`): the link and QR of each screen, a new link, switching one off (a kiosk is a guest table of kind `kiosk`). */
export function KioskPage({ ctx }: { ctx: PageContext }) {
  const { t } = useI18n();
  const storeId = ctx.storeId ?? ctx.homeStoreId ?? null;
  const canEdit = ctx.isOwner || ctx.permissions.includes('menu.edit');
  const moduleOn = ctx.isModuleOn ? ctx.isModuleOn('kiosk') : true;
  const [name, setName] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);
  const [printing, setPrinting] = useState<string | null>(null);
  useEffect(() => {
    if (!printing) return;
    const id = window.setTimeout(() => {
      window.print();
      setPrinting(null);
    }, 60);
    return () => window.clearTimeout(id);
  }, [printing]);

  const data = useRemote(async () => {
    if (!storeId) throw new Error('shop');
    const r = await ctx.client
      .from('dining_tables')
      .select('id, name, qr_token, active')
      .eq('store_id', storeId)
      .eq('kind', 'kiosk')
      .is('deleted_at', null)
      .order('created_at');
    if (r.error) throw new Error('load');
    return { kiosks: rows(r.data), shop: '' };
  }, storeId ?? '');
  const { reload } = data;
  useLiveSync(ctx.client, storeId ? [`store:${storeId}`] : [], reload);
  if (!storeId) return <Notice kind="error">{t.err_load_failed}</Notice>;
  const link = (k: Kiosk) => `${globalThis.location?.origin ?? ''}/t/${k.token}`;

  const call = async (p: Record<string, unknown>) => {
    setMsg(null);
    const r = await ctx.client.rpc('save_kiosk', { p: { store_id: storeId, ...p } });
    if (r.error) {
      setMsg({
        kind: 'error',
        text:
          r.error.code === '42501'
            ? t.err_forbidden
            : r.error.code === '23505' || r.error.code === '23514'
              ? t.kiBad
              : t.err_save_failed,
      });
      return false;
    }
    reload();
    return true;
  };
  const add = async () => {
    const n = (name ?? '').trim();
    if (!n || n.length > 40) return setMsg({ kind: 'error', text: t.kiBad });
    if (await call({ name: n })) setName(null);
  };
  const copy = (k: Kiosk) => async () => {
    try {
      await navigator.clipboard.writeText(link(k));
      setMsg({ kind: 'info', text: t.kiCopied });
    } catch {
      /* the link is shown anyway */
    }
  };

  return (
    <div className="admin-page">
      <h1>{t.kiTitle}</h1>
      <Notice kind="info">{t.kiIntro}</Notice>
      {!moduleOn ? <Notice kind="info">{t.kiOff}</Notice> : null}
      {msg ? <Notice kind={msg.kind}>{msg.text}</Notice> : null}
      {data.status === 'loading' ? (
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      ) : null}
      {data.status === 'error' ? <Notice kind="error">{t.err_load_failed}</Notice> : null}
      {data.data && data.data.kiosks.length === 0 ? <p className="muted">{t.kiNone}</p> : null}
      <ul className="member-list">
        {(data.data?.kiosks ?? []).map((k) => (
          <li key={k.id} className="member-row">
            <div className="member-head">
              <strong>{k.name}</strong>
              {!k.active ? <span className="muted">{t.kiInactive}</span> : null}
            </div>
            <label className="label" htmlFor={`ki-${k.id}`}>
              {t.kiLink}
            </label>
            <input
              id={`ki-${k.id}`}
              className="field"
              readOnly
              value={link(k)}
              onFocus={(e) => e.currentTarget.select()}
            />
            <div className="qr-print booking-qr">
              <QrSvg value={link(k)} label={t.kiScan} />
            </div>
            {printing === k.id ? (
              <PrintPortal pageCss="@page { size: A5; margin: 10mm; }">
                <div className="booking-poster">
                  <h1>{k.name}</h1>
                  <h2>{t.kiScan}</h2>
                  <QrSvg value={link(k)} label={t.kiScan} />
                  <p className="mono">{link(k)}</p>
                </div>
              </PrintPortal>
            ) : null}
            <div className="actions">
              <AsyncButton variant="secondary" onClick={copy(k)}>
                {t.kiCopy}
              </AsyncButton>
              <AsyncButton variant="secondary" onClick={async () => setPrinting(k.id)}>
                {t.kiPrint}
              </AsyncButton>
              {canEdit ? (
                <>
                  <AsyncButton
                    variant="secondary"
                    onClick={async () => void (await call({ id: k.id, rotate: true }))}
                  >
                    {t.kiNew}
                  </AsyncButton>
                  <AsyncButton
                    variant="secondary"
                    onClick={async () => void (await call({ id: k.id, active: !k.active }))}
                  >
                    {k.active ? t.kiOffBtn : t.kiOnBtn}
                  </AsyncButton>
                </>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {canEdit ? (
        name !== null ? (
          <form className="auth-form" onSubmit={(e) => e.preventDefault()} aria-label={t.kiAdd}>
            <div className="form-row">
              <label className="label" htmlFor="ki-name">
                {t.kiName}
              </label>
              <input
                id="ki-name"
                className="field"
                maxLength={40}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="actions">
              <AsyncButton type="submit" onClick={add}>
                {t.kiSave}
              </AsyncButton>
              <button type="button" className="btn btn-secondary" onClick={() => setName(null)}>
                {t.menuCancel}
              </button>
            </div>
          </form>
        ) : (
          <div className="actions">
            <AsyncButton variant="secondary" onClick={async () => setName('')}>
              {t.kiAdd}
            </AsyncButton>
          </div>
        )
      ) : null}
    </div>
  );
}
