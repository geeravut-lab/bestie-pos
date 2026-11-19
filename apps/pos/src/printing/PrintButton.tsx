import { useState } from 'react';
import type { Lang, OrderDoc, ReceiptDoc } from '@bestie/core';
import { errorText, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { browserDeps } from './browser';
import { PrintError } from './drivers';
import { printPicture } from './print';
import type { PrintDeps } from './print';
import { buildReceiptRows } from './rows';
import { usePrinters } from './usePrinters';

export const printErrorKey = (e: unknown): ErrorKey =>
  e instanceof PrintError
    ? e.code === 'unsupported'
      ? 'err_print_unsupported'
      : e.code === 'cancelled'
        ? 'err_print_cancelled'
        : e.code === 'no_device'
          ? 'err_print_no_device'
          : e.code === 'bridge'
            ? 'err_print_bridge'
            : 'err_print_failed'
    : 'err_print_failed';

/**
 * Print one receipt on this tablet's printer (its own choice, else the shop's default, else a PDF). The browser dialog prints the
 * receipt already on screen; every other printer gets a picture of the receipt in the guest's language.
 * `deps` is injected by tests.
 */
export function PrintButton({
  ctx,
  order,
  receipt,
  lang,
  deps,
}: {
  ctx: PageContext;
  order: OrderDoc;
  receipt: ReceiptDoc;
  lang: Lang;
  deps?: (rows: ReturnType<typeof buildReceiptRows>) => PrintDeps;
}) {
  const { t } = useI18n();
  const pr = usePrinters(ctx, order.storeId);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [done, setDone] = useState<'sent' | 'pdf' | null>(null);

  const print = async () => {
    setError(null);
    setDone(null);
    const p = pr.current;
    if (p.kind === 'browser') return void globalThis.print();
    try {
      const rows = buildReceiptRows(order, receipt, lang);
      await printPicture(p, receipt.number, (deps ?? browserDeps)(rows));
      setDone(p.kind === 'pdf' ? 'pdf' : 'sent');
    } catch (e) {
      setError(printErrorKey(e));
    }
  };

  return (
    <>
      <div className="form-row print-on">
        <label className="label" htmlFor="print-on">
          {t.printerPrintOn}
        </label>
        <select
          id="print-on"
          className="field"
          value={pr.current.id}
          onChange={(e) => pr.chooseForTablet(e.target.value)}
        >
          {pr.all.map((p) => (
            <option key={p.id} value={p.id}>
              {p.kind === 'pdf' || p.kind === 'browser'
                ? (t as Record<string, string>)[`printerName_${p.kind}`]
                : p.name}
            </option>
          ))}
        </select>
      </div>
      <AsyncButton onClick={print}>{t.receiptPrint}</AsyncButton>
      <button
        type="button"
        className="btn btn-secondary"
        onClick={() => ctx.navigate('/settings/printers')}
      >
        {t.printerManage}
      </button>
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      {done ? (
        <Notice kind="success">{done === 'pdf' ? t.printerPdfSaved : t.printerSent}</Notice>
      ) : null}
    </>
  );
}
