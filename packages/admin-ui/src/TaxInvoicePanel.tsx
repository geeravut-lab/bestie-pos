import { useEffect, useState } from 'react';
import { formatTHB, guestName } from '@bestie/core';
import type { LocalizedText } from '@bestie/core';
import { fmt, formatDateTime, useI18n } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { PrintPortal } from './PrintPortal';
import { useRemote } from './useRemote';

type Inv = {
  id: string;
  number: string;
  issuedAt: string;
  buyerName: string;
  buyerTaxId: string;
  buyerBranch: string;
  buyerAddress: string;
  status: 'issued' | 'cancelled';
};
type Loaded = {
  receipt: {
    number: string;
    issuedAt: string;
    sellerName: string;
    sellerTaxId: string | null;
    branchCode: string;
    vatRegistered: boolean;
    vatBps: number;
    subtotal: number;
    serviceCharge: number;
    vat: number;
    net: number;
    total: number;
    rounding: number;
    payable: number;
  } | null;
  lines: { name: LocalizedText; qty: number; price: number }[];
  invoices: Inv[];
  address: string;
};

const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0;

/** A full tax invoice for a paid bill of a VAT-registered shop: ask for it with the buyer's details, print it on A4, cancel a wrong one. */
export function TaxInvoicePanel({ ctx, orderId }: { ctx: PageContext; orderId: string }) {
  const { t, lang } = useI18n();
  const canIssue = ctx.isOwner || ctx.permissions.includes('payment.take');
  const canCancel = ctx.isOwner || ctx.permissions.includes('refund.create');
  const [form, setForm] = useState<{
    name: string;
    taxId: string;
    branch: string;
    address: string;
  } | null>(null);
  const [cancelling, setCancelling] = useState<{ id: string; reason: string } | null>(null);
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

  const data = useRemote<Loaded>(async () => {
    const [r, l, i] = await Promise.all([
      ctx.client
        .from('receipts')
        .select(
          'number, issued_at, seller_name, seller_tax_id, branch_code, vat_registered, vat_bps, subtotal, service_charge, vat, net_before_vat, total, rounding, payable, store_id',
        )
        .eq('order_id', orderId)
        .maybeSingle(),
      ctx.client
        .from('order_lines')
        .select('name, unit_price, quantity, status')
        .eq('order_id', orderId),
      ctx.client
        .from('tax_invoices')
        .select(
          'id, number, issued_at, buyer_name, buyer_tax_id, buyer_branch, buyer_address, status',
        )
        .eq('order_id', orderId)
        .order('created_at'),
    ]);
    if (r.error) throw new Error('load');
    const row = r.data as Record<string, unknown> | null;
    let address = '';
    if (row?.store_id) {
      const s = await ctx.client
        .from('stores')
        .select('address, legal_entities(address)')
        .eq('id', String(row.store_id))
        .maybeSingle();
      const d = s.data as {
        address?: string | null;
        legal_entities?: { address?: string | null } | null;
      } | null;
      address = [d?.legal_entities?.address, d?.address].filter(Boolean).join(' · ');
    }
    return {
      receipt: row
        ? {
            number: String(row.number),
            issuedAt: String(row.issued_at),
            sellerName: String(row.seller_name),
            sellerTaxId: typeof row.seller_tax_id === 'string' ? row.seller_tax_id : null,
            branchCode: String(row.branch_code ?? '00000'),
            vatRegistered: row.vat_registered === true,
            vatBps: num(row.vat_bps),
            subtotal: num(row.subtotal),
            serviceCharge: num(row.service_charge),
            vat: num(row.vat),
            net: num(row.net_before_vat),
            total: num(row.total),
            rounding: num(row.rounding),
            payable: num(row.payable),
          }
        : null,
      lines: (
        (l.data ?? []) as {
          name: LocalizedText;
          unit_price: number;
          quantity: number;
          status: string;
        }[]
      )
        .filter((x) => x.status !== 'void')
        .map((x) => ({ name: x.name, qty: num(x.quantity), price: num(x.unit_price) })),
      invoices: ((i.data ?? []) as Record<string, unknown>[]).map((x) => ({
        id: String(x.id),
        number: String(x.number),
        issuedAt: String(x.issued_at),
        buyerName: String(x.buyer_name),
        buyerTaxId: String(x.buyer_tax_id),
        buyerBranch: String(x.buyer_branch),
        buyerAddress: String(x.buyer_address),
        status: x.status === 'cancelled' ? 'cancelled' : 'issued',
      })),
      address,
    };
  }, orderId);
  const { reload } = data;
  const d = data.data;
  const money = (n: number) => formatTHB(n, lang === 'th' ? 'th-TH' : 'en-GB');

  if (data.status === 'loading')
    return (
      <p className="sso-working" role="status">
        <Spinner /> {t.loading}
      </p>
    );
  if (!d || !d.receipt || !d.receipt.vatRegistered) return null;
  const live = d.invoices.find((x) => x.status === 'issued') ?? null;

  const fail = (code?: string) =>
    setMsg({
      kind: 'error',
      text:
        code === '42501'
          ? t.err_forbidden
          : code === '55000'
            ? t.tiNotReady
            : code === '23514' || code === '22023'
              ? t.tiBad
              : t.err_save_failed,
    });
  const issue = async () => {
    if (!form) return;
    setMsg(null);
    if (
      !form.name.trim() ||
      !/^\d{13}$/.test(form.taxId) ||
      !/^\d{5}$/.test(form.branch) ||
      form.address.trim().length < 5
    )
      return setMsg({ kind: 'error', text: t.tiBad });
    const r = await ctx.client.rpc('issue_tax_invoice', {
      p: {
        order_id: orderId,
        buyer_name: form.name.trim(),
        buyer_tax_id: form.taxId,
        buyer_branch: form.branch,
        buyer_address: form.address.trim(),
      },
    });
    if (r.error) return fail(r.error.code);
    setForm(null);
    reload();
  };
  const cancel = async () => {
    if (!cancelling) return;
    setMsg(null);
    const r = await ctx.client.rpc('cancel_tax_invoice', {
      p_id: cancelling.id,
      p_reason: cancelling.reason.trim(),
    });
    if (r.error) return fail(r.error.code);
    setCancelling(null);
    reload();
  };
  const rc = d.receipt;
  return (
    <section className="card admin-card" aria-label={t.tiTitle}>
      <h2>{t.tiTitle}</h2>
      {msg ? <Notice kind={msg.kind}>{msg.text}</Notice> : null}
      {d.invoices.map((x) => (
        <p key={x.id} className={x.status === 'cancelled' ? 'muted' : undefined}>
          <strong>{x.number}</strong> · {x.buyerName} · {formatDateTime(lang, x.issuedAt)}
          {x.status === 'cancelled' ? ` · ${t.tiCancelled}` : null}
        </p>
      ))}
      {live ? (
        <div className="actions">
          <AsyncButton variant="secondary" onClick={async () => setPrinting(live.id)}>
            {fmt(t.tiPrint, { number: live.number })}
          </AsyncButton>
          {canCancel ? (
            <AsyncButton
              variant="secondary"
              onClick={async () => setCancelling({ id: live.id, reason: '' })}
            >
              {t.tiCancel}
            </AsyncButton>
          ) : null}
        </div>
      ) : canIssue ? (
        form ? (
          <form className="auth-form" onSubmit={(e) => e.preventDefault()} aria-label={t.tiIssue}>
            {(
              [
                ['ti-name', t.tiBuyerName, 'name', 120],
                ['ti-tax', t.tiBuyerTaxId, 'taxId', 13],
                ['ti-branch', t.tiBuyerBranch, 'branch', 5],
                ['ti-addr', t.tiBuyerAddress, 'address', 300],
              ] as const
            ).map(([id, label, key, max]) => (
              <div key={id} className="form-row">
                <label className="label" htmlFor={id}>
                  {label}
                </label>
                <input
                  id={id}
                  className="field"
                  maxLength={max}
                  inputMode={key === 'taxId' || key === 'branch' ? 'numeric' : undefined}
                  value={form[key]}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      [key]:
                        key === 'taxId' || key === 'branch'
                          ? e.target.value.replace(/\D/g, '')
                          : e.target.value,
                    })
                  }
                />
              </div>
            ))}
            <p className="muted">{t.tiNote}</p>
            <div className="actions">
              <AsyncButton type="submit" onClick={issue}>
                {t.tiIssue}
              </AsyncButton>
              <button type="button" className="btn btn-secondary" onClick={() => setForm(null)}>
                {t.menuCancel}
              </button>
            </div>
          </form>
        ) : (
          <div className="actions">
            <AsyncButton
              variant="secondary"
              onClick={async () => setForm({ name: '', taxId: '', branch: '00000', address: '' })}
            >
              {t.tiAsk}
            </AsyncButton>
          </div>
        )
      ) : null}
      {cancelling ? (
        <div className="form-row">
          <label className="label" htmlFor="ti-reason">
            {t.tiReason}
          </label>
          <input
            id="ti-reason"
            className="field"
            maxLength={200}
            value={cancelling.reason}
            onChange={(e) => setCancelling({ ...cancelling, reason: e.target.value })}
          />
          <AsyncButton variant="secondary" onClick={cancel}>
            {t.tiCancelDo}
          </AsyncButton>
        </div>
      ) : null}
      {printing
        ? (() => {
            const inv = d.invoices.find((x) => x.id === printing);
            if (!inv) return null;
            return (
              <PrintPortal pageCss="@page { size: A4; margin: 15mm; }">
                <div className="folio-statement">
                  <h1>{t.tiDocTitle}</h1>
                  <p>
                    <strong>{rc.sellerName}</strong>
                    <br />
                    {d.address}
                    <br />
                    {t.tiTaxId}: {rc.sellerTaxId} · {t.tiBranch}: {rc.branchCode}
                  </p>
                  <dl className="kv">
                    <dt>{t.tiNumber}</dt>
                    <dd>{inv.number}</dd>
                    <dt>{t.tiDate}</dt>
                    <dd>{formatDateTime(lang, inv.issuedAt)}</dd>
                    <dt>{t.tiReplaces}</dt>
                    <dd>{rc.number}</dd>
                  </dl>
                  <h2>{t.tiBuyer}</h2>
                  <p>
                    <strong>{inv.buyerName}</strong>
                    <br />
                    {inv.buyerAddress}
                    <br />
                    {t.tiTaxId}: {inv.buyerTaxId} · {t.tiBranch}: {inv.buyerBranch}
                  </p>
                  <table className="folio-lines">
                    <tbody>
                      {d.lines.map((x, i) => (
                        <tr key={i}>
                          <td>{guestName(x.name, lang)}</td>
                          <td className="tabular">
                            {x.qty} × {money(x.price)}
                          </td>
                          <td className="tabular">{money(x.qty * x.price)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={2}>{t.tiNet}</td>
                        <td className="tabular">{money(rc.net)}</td>
                      </tr>
                      <tr>
                        <td colSpan={2}>{fmt(t.tiVat, { pct: rc.vatBps / 100 })}</td>
                        <td className="tabular">{money(rc.vat)}</td>
                      </tr>
                      {rc.serviceCharge > 0 ? (
                        <tr>
                          <td colSpan={2}>{t.tiService}</td>
                          <td className="tabular">{money(rc.serviceCharge)}</td>
                        </tr>
                      ) : null}
                      <tr>
                        <th colSpan={2}>{t.tiTotal}</th>
                        <th className="tabular">{money(rc.payable)}</th>
                      </tr>
                    </tfoot>
                  </table>
                  <p className="muted">{t.tiDocNote}</p>
                </div>
              </PrintPortal>
            );
          })()
        : null}
    </section>
  );
}
