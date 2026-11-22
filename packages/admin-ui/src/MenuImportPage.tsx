import { useState } from 'react';
import { formatTHB, parseMenuCsv } from '@bestie/core';
import type { ImportParse } from '@bestie/core';
import { fmt, useI18n } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';

type Done = { items: number; categories: number; skipped: { row: number; reason: string }[] };

/** Bring a menu from another POS: a CSV file or a pasted table, checked in the browser, then sent to `import_menu` (needs `menu.edit`). */
export function MenuImportPage({ ctx }: { ctx: PageContext }) {
  const { t, lang } = useI18n();
  const storeId = ctx.storeId ?? ctx.homeStoreId ?? null;
  const canEdit = ctx.isOwner || ctx.permissions.includes('menu.edit');
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState<ImportParse | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!canEdit)
    return (
      <div className="admin-page">
        <Notice kind="error">{t.miNoAccess}</Notice>
      </div>
    );
  const read = (s: string) => {
    setDone(null);
    setError(null);
    setParsed(s.trim() ? parseMenuCsv(s) : null);
    if (!s.trim()) setError(t.miEmpty);
  };
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    const s = await f.text();
    setText(s);
    read(s);
  };
  const run = async () => {
    if (!parsed || !storeId) return;
    setError(null);
    const r = await ctx.client.rpc('import_menu', { p: { store_id: storeId, rows: parsed.rows } });
    if (r.error) return setError(r.error.code === '42501' ? t.err_forbidden : t.err_save_failed);
    const o = (r.data ?? {}) as {
      items?: number;
      categories?: number;
      skipped?: { row: number; reason: string }[];
    };
    setDone({ items: o.items ?? 0, categories: o.categories ?? 0, skipped: o.skipped ?? [] });
    setParsed(null);
  };
  const why: Record<string, string> = {
    exists: t.miSkipExists,
    barcode_used: t.miSkipBarcode,
    invalid: t.miSkipInvalid,
  };
  const noColumns =
    parsed !== null &&
    parsed.rows.length === 0 &&
    (parsed.columns.name_th === undefined || parsed.columns.price === undefined);
  return (
    <div className="admin-page">
      <h1>{t.miTitle}</h1>
      <Notice kind="info">{t.miIntro}</Notice>
      {error ? <Notice kind="error">{error}</Notice> : null}
      <section className="card admin-card auth-form">
        <div className="form-row">
          <label className="label" htmlFor="mi-file">
            {t.miFile}
          </label>
          <input
            id="mi-file"
            className="field"
            type="file"
            accept=".csv,.tsv,.txt,text/csv"
            onChange={(e) => void onFile(e.target.files?.[0])}
          />
        </div>
        <div className="form-row">
          <label className="label" htmlFor="mi-text">
            {t.miPaste}
          </label>
          <textarea
            id="mi-text"
            className="field"
            rows={6}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <div className="actions">
          <AsyncButton variant="secondary" onClick={async () => read(text)}>
            {t.miRead}
          </AsyncButton>
        </div>
      </section>
      {noColumns ? <Notice kind="error">{t.miNoColumns}</Notice> : null}
      {parsed && parsed.rows.length > 0 ? (
        <section className="card admin-card" aria-label={t.miFound}>
          <p>{fmt(t.miFound, { n: parsed.rows.length })}</p>
          {parsed.issues.length > 0 ? (
            <p className="muted">{fmt(t.miIssues, { n: parsed.issues.length })}</p>
          ) : null}
          {parsed.truncated ? <Notice kind="info">{t.miTrunc}</Notice> : null}
          <table className="table">
            <thead>
              <tr>
                {[t.miCategory, t.miName, t.miPrice].map((h) => (
                  <th key={h} scope="col">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {parsed.rows.slice(0, 20).map((r, i) => (
                <tr key={i}>
                  <td>{r.category}</td>
                  <td>{r.name_th}</td>
                  <td className="tabular">
                    {formatTHB(r.price, lang === 'th' ? 'th-TH' : 'en-GB')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="actions">
            <AsyncButton onClick={run}>{fmt(t.miImport, { n: parsed.rows.length })}</AsyncButton>
          </div>
        </section>
      ) : null}
      {done ? (
        <Notice kind="success">
          {fmt(t.miDone, {
            items: done.items,
            cats: done.categories,
            skipped: done.skipped.length,
          })}
          {done.skipped.length > 0 ? (
            <ul>
              {done.skipped.slice(0, 10).map((s) => (
                <li key={s.row}>
                  #{s.row}: {why[s.reason] ?? t.miSkipInvalid}
                </li>
              ))}
            </ul>
          ) : null}
        </Notice>
      ) : null}
    </div>
  );
}
