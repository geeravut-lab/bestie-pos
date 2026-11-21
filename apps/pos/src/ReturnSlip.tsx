import { useEffect, useState } from 'react';
import { formatTHB } from '@bestie/core';
import type { Lang } from '@bestie/core';
import { dict, formatDateTime, useI18n } from '@bestie/i18n';
import { PrintPortal, useRemote } from '@bestie/admin-ui';
import { AsyncButton } from '@bestie/ui';
import type { PageContext } from '@bestie/auth';

type Slip = {
  number: string;
  receiptNumber: string;
  sellerName: string;
  taxId: string;
  branch: string;
  posId: string;
  amount: number;
  method: string;
  reason: string;
  at: string;
  staff: string;
  lines: { name: { th: string; en?: string }; quantity: number; unitPrice: number }[];
};

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

async function loadSlip(ctx: PageContext, returnId: string): Promise<Slip | null> {
  const c = ctx.client;
  const ret = await c
    .from('order_returns')
    .select('number, amount, refund_method, reason, created_at, receipt_id, staff_id')
    .eq('id', returnId)
    .maybeSingle();
  if (ret.error || !ret.data) return null;
  const r = ret.data as Record<string, unknown>;
  const [rec, lines, staff] = await Promise.all([
    c
      .from('receipts')
      .select('number, seller_name, seller_tax_id, branch_code, pos_id')
      .eq('id', str(r.receipt_id))
      .maybeSingle(),
    c.from('order_return_lines').select('name, quantity, unit_price').eq('return_id', returnId),
    r.staff_id
      ? c.from('staff').select('display_name').eq('id', str(r.staff_id)).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const rc = (rec.data ?? {}) as Record<string, unknown>;
  return {
    number: str(r.number),
    receiptNumber: str(rc.number),
    sellerName: str(rc.seller_name),
    taxId: str(rc.seller_tax_id),
    branch: str(rc.branch_code),
    posId: str(rc.pos_id),
    amount: num(r.amount),
    method: str(r.refund_method),
    reason: str(r.reason),
    at: str(r.created_at),
    staff: str((staff.data as Record<string, unknown> | null)?.display_name),
    lines: ((lines.data ?? []) as Record<string, unknown>[]).map((l) => ({
      name: l.name as Slip['lines'][number]['name'],
      quantity: num(l.quantity),
      unitPrice: num(l.unit_price),
    })),
  };
}

/** The paper copy of one return: shop, numbers, what came back, how much was paid back, a line for the customer's signature. */
export function ReturnSlipButton({
  ctx,
  returnId,
  lang: slipLang,
}: {
  ctx: PageContext;
  returnId: string;
  lang?: Lang;
}) {
  const { t, lang } = useI18n();
  const l = slipLang ?? lang;
  const d = dict[l];
  const slip = useRemote(() => loadSlip(ctx, returnId), `slip:${returnId}`);
  const s = slip.data;
  // the paper copy exists only while it is being printed (two slips on one page would print together)
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    if (!printing) return;
    const id = window.setTimeout(() => {
      window.print();
      setPrinting(false);
    }, 60);
    return () => window.clearTimeout(id);
  }, [printing]);
  const method = (m: string) =>
    m === 'cash'
      ? d.returnMethodCash
      : m === 'credit'
        ? d.returnMethodCredit
        : m === 'room'
          ? d.returnMethodRoom
          : d.returnMethodManual;
  const reason = (x: string) =>
    x === 'wrong_item'
      ? d.returnReasonWrong
      : x === 'defective'
        ? d.returnReasonDefective
        : x === 'changed_mind'
          ? d.returnReasonChanged
          : d.returnReasonOther;
  const money = (n: number) => formatTHB(n, l === 'th' ? 'th-TH' : 'en-GB');
  return (
    <>
      <AsyncButton variant="secondary" disabled={!s} onClick={() => setPrinting(true)}>
        {t.returnSlipButton}
      </AsyncButton>
      {s && printing ? (
        <PrintPortal pageCss="@page { size: 80mm auto; margin: 4mm; }">
          <div className="return-slip">
            <h1>{s.sellerName}</h1>
            {s.taxId ? (
              <p>
                {d.returnSlipTaxId}: {s.taxId} · {d.returnSlipBranch} {s.branch}
              </p>
            ) : null}
            {s.posId ? <p>POS ID: {s.posId}</p> : null}
            <h2>
              {d.returnSlipTitle} {s.number}
            </h2>
            <p>
              {formatDateTime(l, s.at)} · {d.returnSlipOriginal} {s.receiptNumber}
            </p>
            <table>
              <tbody>
                {s.lines.map((x, i) => (
                  <tr key={i}>
                    <td>{l === 'en' && x.name.en ? x.name.en : x.name.th}</td>
                    <td>
                      {x.quantity} × {money(x.unitPrice)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p>
              <strong>
                {d.returnSlipTotal}: {money(s.amount)}
              </strong>
            </p>
            <p>
              {method(s.method)} · {reason(s.reason)}
            </p>
            {s.staff ? (
              <p>
                {d.returnSlipStaff}: {s.staff}
              </p>
            ) : null}
            <p className="return-slip-sign">{d.returnSlipCustomer}</p>
            <p className="return-slip-note">{d.returnSlipNote}</p>
          </div>
        </PrintPortal>
      ) : null}
    </>
  );
}
