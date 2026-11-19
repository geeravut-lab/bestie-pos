import { useState } from 'react';
import { countSheetRows, splitQty } from '@bestie/core';
import type { StockItem } from '@bestie/core';
import { useI18n } from '@bestie/i18n';
import { PrintPortal } from './PrintPortal';
import { tx } from './stockInput';

/** The paper a person walks the shelves with: every stock item, what the system thinks is there (or not, for a blind count), and empty boxes to write in. */
export function CountSheet({ items, shop }: { items: StockItem[]; shop: string }) {
  const { t, lang } = useI18n();
  const [blind, setBlind] = useState(false);
  const rows = countSheetRows(
    items.map((i) => ({
      id: i.id,
      name: i.name,
      unit: i.unit,
      quantity: i.quantity,
      barcode: i.barcode,
    })),
    { blind, lang },
  );
  const byId = new Map(items.map((i) => [i.id, i]));
  const today = new Date().toLocaleDateString(lang === 'th' ? 'th-TH' : 'en-GB');
  return (
    <section className="card admin-card" aria-label={t.stockCountSheet}>
      <div className="form-row">
        <label className="label" htmlFor="count-blind">
          <input
            id="count-blind"
            type="checkbox"
            checked={blind}
            onChange={(e) => setBlind(e.target.checked)}
          />{' '}
          {t.stockCountBlind}
        </label>
      </div>
      <div className="actions">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={rows.length === 0}
          onClick={() => window.print()}
        >
          {t.stockCountSheet}
        </button>
      </div>
      {rows.length > 0 ? (
        <PrintPortal pageCss="@page { size: A4; margin: 10mm; }">
          <div className="count-sheet">
            <h1>{t.stockCountSheetTitle}</h1>
            <p>
              {shop} · {today}
            </p>
            <table>
              <thead>
                <tr>
                  <th>{t.stockCountColItem}</th>
                  <th>{t.stockCountColBarcode}</th>
                  <th>{t.stockCountColUnit}</th>
                  {blind ? null : <th>{t.stockCountColSystem}</th>}
                  <th>{t.stockCountColCounted}</th>
                  {blind ? null : <th>{t.stockCountColDiff}</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const it = byId.get(r.id)!;
                  const q = splitQty(it.quantity, it.unit);
                  return (
                    <tr key={r.id}>
                      <td>{r.name}</td>
                      <td className="tabular">{r.barcode}</td>
                      <td>{tx(t, `stockU_${it.unit}`)}</td>
                      {blind ? null : (
                        <td className="tabular">
                          {q.value} {tx(t, `stockU_${q.unit}`)}
                        </td>
                      )}
                      <td className="write" />
                      {blind ? null : <td className="write" />}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p>{t.stockCountSign}</p>
          </div>
        </PrintPortal>
      ) : (
        <p className="muted">{t.stockCountEmpty}</p>
      )}
    </section>
  );
}
