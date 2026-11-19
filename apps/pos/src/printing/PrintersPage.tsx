import { useState } from 'react';
import { PRINTER_KINDS, newPrinterId, printerProblems, printersToColumn } from '@bestie/core';
import type { CustomPrinterKind, PaperMm, Printer } from '@bestie/core';
import { errorText, fmt, useI18n } from '@bestie/i18n';
import type { Dict, ErrorKey } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { Page, Loading } from '../PosBits';
import { usePosStore } from '../posData';
import { browserDeps } from './browser';
import { supportedKinds } from './drivers';
import { printPicture } from './print';
import { printErrorKey } from './PrintButton';
import { sampleReceiptRows } from './rows';
import { usePrinters } from './usePrinters';

const tx = (t: Dict, key: string): string => (t as Record<string, string>)[key] ?? key;

/** Add / remove the shop's printers, pick the shop default, pick this tablet's own, and print a test page. */
export function PrintersPage({ ctx }: { ctx: PageContext }) {
  const { t, lang } = useI18n();
  const { storeId } = usePosStore(ctx);
  const pr = usePrinters(ctx, storeId);
  const canManage = ctx.isOwner || ctx.permissions.includes('settings.manage');
  const [error, setError] = useState<ErrorKey | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const kinds = supportedKinds();

  if (!storeId)
    return (
      <Page title={t.printersTitle}>
        <Notice kind="error">{t.posNoShop}</Notice>
      </Page>
    );
  if (!pr.loaded && pr.custom.length === 0) return <Loading />;

  const save = async (list: Printer[], defaultId: string | null | undefined = undefined) => {
    setError(null);
    setMessage(null);
    const values: Record<string, unknown> = { printers: printersToColumn(list) };
    if (defaultId !== undefined) values.default_printer = defaultId;
    const { data, error: err } = await ctx.client
      .from('stores')
      .update(values)
      .eq('id', storeId)
      .select('id');
    if (err || data?.length !== 1)
      return setError(err?.code === '42501' ? 'err_forbidden' : 'err_save_failed');
    await pr.reload();
    setMessage(t.printerSaved);
  };

  const testPrint = async (p: Printer) => {
    setError(null);
    setMessage(null);
    try {
      await printPicture(p, 'printer-test', browserDeps(sampleReceiptRows(lang)));
      setMessage(p.kind === 'pdf' ? t.printerPdfSaved : t.printerSent);
    } catch (e) {
      setError(printErrorKey(e));
    }
  };

  return (
    <Page title={t.printersTitle}>
      <Notice kind="info">{t.printersIntro}</Notice>
      {!canManage ? <Notice kind="info">{t.printerOwnerOnly}</Notice> : null}
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      {message ? <Notice kind="success">{message}</Notice> : null}
      <ul className="member-list">
        {pr.all.map((p) => {
          const builtIn = p.kind === 'pdf' || p.kind === 'browser';
          const isShop = (pr.shopDefault ?? 'pdf') === p.id;
          const isHere = pr.current.id === p.id;
          return (
            <li key={p.id} className="member-row">
              <div className="member-head">
                <strong>{builtIn ? tx(t, `printerName_${p.kind}`) : p.name}</strong>
                <span className="muted">{tx(t, `printerKind_${p.kind}`)}</span>
                {builtIn ? null : (
                  <span className="badge">
                    {p.paperMm === 58 ? t.printerPaper58 : t.printerPaper80}
                  </span>
                )}
                {isShop ? <span className="badge">{t.printerShopDefault}</span> : null}
                {isHere ? <span className="badge">{t.printerThisTablet}</span> : null}
              </div>
              <div className="actions">
                {p.kind === 'browser' ? null : (
                  <AsyncButton
                    variant="secondary"
                    onClick={() => testPrint(p)}
                    disabled={!kinds[p.kind]}
                  >
                    {t.printerTest}
                  </AsyncButton>
                )}
                {isHere && pr.tablet !== null ? (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => pr.chooseForTablet(null)}
                  >
                    {t.printerClearHere}
                  </button>
                ) : !isHere ? (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => pr.chooseForTablet(p.id)}
                  >
                    {t.printerUseHere}
                  </button>
                ) : null}
                {canManage && !isShop ? (
                  <AsyncButton variant="secondary" onClick={() => save(pr.custom, p.id)}>
                    {t.printerMakeDefault}
                  </AsyncButton>
                ) : null}
                {canManage && !builtIn ? (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setConfirm(p.id)}
                  >
                    {t.printerRemove}
                  </button>
                ) : null}
                {!builtIn && !kinds[p.kind] ? (
                  <span className="muted">{t.printerUnsupported}</span>
                ) : null}
              </div>
              {confirm === p.id ? (
                <div className="confirm-box" role="alertdialog" aria-label={p.name}>
                  <p>{fmt(t.printerRemoveConfirm, { name: p.name })}</p>
                  <div className="actions">
                    <AsyncButton
                      variant="danger"
                      onClick={async () => {
                        await save(
                          pr.custom.filter((x) => x.id !== p.id),
                          pr.shopDefault === p.id ? null : undefined,
                        );
                        setConfirm(null);
                      }}
                    >
                      {t.printerRemove}
                    </AsyncButton>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setConfirm(null)}
                    >
                      {t.menuCancel}
                    </button>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {canManage ? (
        adding ? (
          <AddPrinter
            taken={pr.all.map((p) => p.id)}
            kinds={kinds}
            onCancel={() => setAdding(false)}
            onSave={async (p) => {
              await save([...pr.custom, p]);
              setAdding(false);
            }}
          />
        ) : (
          <div className="actions">
            <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
              {t.printerAdd}
            </button>
          </div>
        )
      ) : null}
    </Page>
  );
}

function AddPrinter({
  taken,
  kinds,
  onSave,
  onCancel,
}: {
  taken: string[];
  kinds: Record<string, boolean>;
  onSave: (p: Printer) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<CustomPrinterKind>('usb');
  const [paper, setPaper] = useState<PaperMm>(80);
  const [cutter, setCutter] = useState(true);
  const [drawer, setDrawer] = useState(false);
  const [bridge, setBridge] = useState('');
  const [baud, setBaud] = useState('9600');
  const [bad, setBad] = useState(false);

  const submit = async () => {
    const p: Printer = {
      id: newPrinterId(name, taken),
      name: name.trim(),
      kind,
      paperMm: paper,
      cutter,
      drawer,
      ...(kind === 'network' ? { bridgeUrl: bridge.trim() } : {}),
      ...(kind === 'serial' ? { baud: Number(baud) } : {}),
    };
    if (printerProblems(p).length > 0) return setBad(true);
    setBad(false);
    await onSave(p);
  };

  return (
    <form
      className="card admin-card auth-form"
      onSubmit={(e) => e.preventDefault()}
      aria-label={t.printerAddTitle}
    >
      <h2>{t.printerAddTitle}</h2>
      <div className="form-row">
        <label className="label" htmlFor="pr-name">
          {t.printerName}
        </label>
        <input
          id="pr-name"
          className="field"
          value={name}
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="form-row">
        <label className="label" htmlFor="pr-kind">
          {t.printerKind}
        </label>
        <select
          id="pr-kind"
          className="field"
          value={kind}
          onChange={(e) => setKind(e.target.value as CustomPrinterKind)}
        >
          {PRINTER_KINDS.map((k) => (
            <option key={k} value={k}>
              {tx(t, `printerKind_${k}`)}
              {kinds[k] ? '' : ` — ${t.printerUnsupported}`}
            </option>
          ))}
        </select>
        <p className="muted">{tx(t, `printerKindNote_${kind}`)}</p>
      </div>
      <div className="form-row">
        <label className="label" htmlFor="pr-paper">
          {t.printerPaper}
        </label>
        <select
          id="pr-paper"
          className="field"
          value={paper}
          onChange={(e) => setPaper(Number(e.target.value) as PaperMm)}
        >
          <option value={58}>{t.printerPaper58}</option>
          <option value={80}>{t.printerPaper80}</option>
        </select>
      </div>
      {kind === 'network' ? (
        <div className="form-row">
          <label className="label" htmlFor="pr-bridge">
            {t.printerBridge}
          </label>
          <input
            id="pr-bridge"
            className="field"
            value={bridge}
            onChange={(e) => setBridge(e.target.value)}
          />
        </div>
      ) : null}
      {kind === 'serial' ? (
        <div className="form-row">
          <label className="label" htmlFor="pr-baud">
            {t.printerBaud}
          </label>
          <input
            id="pr-baud"
            className="field tabular"
            inputMode="numeric"
            value={baud}
            onChange={(e) => setBaud(e.target.value)}
          />
        </div>
      ) : null}
      <label className="check-row">
        <input type="checkbox" checked={cutter} onChange={(e) => setCutter(e.target.checked)} />
        <span>{t.printerCutter}</span>
      </label>
      <label className="check-row">
        <input type="checkbox" checked={drawer} onChange={(e) => setDrawer(e.target.checked)} />
        <span>{t.printerDrawer}</span>
      </label>
      {bad ? <Notice kind="error">{t.printerInvalid}</Notice> : null}
      <div className="actions">
        <AsyncButton type="submit" onClick={submit}>
          {t.printerSave}
        </AsyncButton>
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          {t.menuCancel}
        </button>
      </div>
    </form>
  );
}
