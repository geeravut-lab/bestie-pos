import { useState } from 'react';
import { EXPORT_DATASETS, rowsToCsv } from '@bestie/core';
import type { ExportDataset } from '@bestie/core';
import { fmt, useI18n } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';

const save = (name: string, body: string, type: string) => {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
};

/** The owner's own copy of the business data: one list as CSV, or everything as one JSON backup. Staff PINs and passwords are never part of it. */
export function DataExportPanel({ ctx }: { ctx: PageContext }) {
  const { t } = useI18n();
  const [set, setSet] = useState<ExportDataset>('customers');
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const label = (d: ExportDataset) => (t as Record<string, string>)[`ex_${d}`] ?? d;
  const fetchSet = async (d: ExportDataset): Promise<Record<string, unknown>[] | null> => {
    const r = await ctx.client.rpc('export_data', { p: { org_id: ctx.orgId, dataset: d } });
    return r.error || !Array.isArray(r.data) ? null : (r.data as Record<string, unknown>[]);
  };
  const stamp = new Date().toISOString().slice(0, 10);
  const one = async () => {
    setMsg(null);
    const rows = await fetchSet(set);
    if (!rows) return setMsg({ kind: 'error', text: t.exErr });
    save(`bestie-${set}-${stamp}.csv`, rowsToCsv(rows), 'text/csv;charset=utf-8');
    setMsg({ kind: 'success', text: fmt(t.exDone, { n: rows.length }) });
  };
  const all = async () => {
    setMsg(null);
    const out: Record<string, unknown> = { exported_at: new Date().toISOString() };
    for (const d of EXPORT_DATASETS) {
      const rows = await fetchSet(d);
      if (!rows) return setMsg({ kind: 'error', text: t.exErr });
      out[d] = rows;
    }
    save(`bestie-backup-${stamp}.json`, JSON.stringify(out, null, 1), 'application/json');
    setMsg({ kind: 'success', text: t.exBackupDone });
  };
  return (
    <section className="card admin-card" aria-label={t.exTitle}>
      <h2>{t.exTitle}</h2>
      <p className="muted">{t.exIntro}</p>
      {msg ? <Notice kind={msg.kind}>{msg.text}</Notice> : null}
      <div className="form-inline">
        <div className="form-row">
          <label className="label" htmlFor="ex-set">
            {t.exWhat}
          </label>
          <select id="ex-set" value={set} onChange={(e) => setSet(e.target.value as ExportDataset)}>
            {EXPORT_DATASETS.map((d) => (
              <option key={d} value={d}>
                {label(d)}
              </option>
            ))}
          </select>
        </div>
        <AsyncButton onClick={one}>{t.exDownload}</AsyncButton>
        <AsyncButton variant="secondary" onClick={all}>
          {t.exBackup}
        </AsyncButton>
      </div>
    </section>
  );
}
