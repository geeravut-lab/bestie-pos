import { useState } from 'react';
import { bangkokDate, formatTHB } from '@bestie/core';
import type { Lang } from '@bestie/core';
import { dict, fmt, formatDateTime, useI18n } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useOrder, useOutboxCounts, usePaidOrders } from '@bestie/offline';
import { usePosData, usePosStore } from './posData';
import { Loading, Page } from './PosBits';
import { PrintButton } from './printing/PrintButton';
import { ReceiptView } from './ReceiptView';

/** One receipt: view in the guest's language, print (browser print, 80 mm layout), back to selling. */
export function ReceiptPage({ ctx, orderId }: { ctx: PageContext; orderId: string }) {
  const { t } = useI18n();
  const order = useOrder(orderId);
  const remote = usePosData(ctx, order?.storeId ?? null);
  const { pending } = useOutboxCounts();
  const [chosen, setChosen] = useState<Lang | null>(null);

  if (order === undefined) return <Loading />;
  if (order === null || !order.receipt)
    return (
      <Page title={t.receiptsTitle}>
        <Notice kind="info">{order === null ? t.orderNotFound : t.receiptNotPaid}</Notice>
        <AsyncButton
          variant="secondary"
          onClick={() => ctx.navigate(order ? `/order/${order.id}` : '/receipts')}
        >
          {t.receiptsTitle}
        </AsyncButton>
      </Page>
    );
  const lang = chosen ?? remote.data?.config.defaultLang ?? order.receipt.lang;
  return (
    <Page title={fmt(t.receiptNumber, { number: order.receipt.number })}>
      {pending > 0 ? <Notice kind="info">{t.receiptWaiting}</Notice> : null}
      <div className="actions no-print">
        <div className="chips" role="group" aria-label={t.receiptLanguage}>
          {(['th', 'en'] as const).map((l) => (
            <button
              key={l}
              type="button"
              className="chip"
              aria-pressed={lang === l}
              onClick={() => setChosen(l)}
            >
              {dict[l].langName}
            </button>
          ))}
        </div>
        <PrintButton ctx={ctx} order={order} receipt={order.receipt} lang={lang} />
        {ctx.isOwner || ctx.permissions.includes('refund.create') ? (
          <AsyncButton variant="secondary" onClick={() => ctx.navigate(`/return/${order.id}`)}>
            {t.returnButton}
          </AsyncButton>
        ) : null}
        <AsyncButton variant="secondary" onClick={() => ctx.navigate('/sell')}>
          {t.sellNew}
        </AsyncButton>
      </div>
      <ReceiptView order={order} receipt={order.receipt} lang={lang} />
    </Page>
  );
}

/** Today's receipts of this shop (this tablet's and, once synced, the others'), for looking up and reprinting. */
export function ReceiptsPage({ ctx }: { ctx: PageContext }) {
  const { t, lang } = useI18n();
  const locale = lang === 'th' ? ('th-TH' as const) : ('en-GB' as const);
  const { storeId } = usePosStore(ctx);
  usePosData(ctx, storeId); // keeps the shop's orders pulled while this page is open
  // the business day is fixed when the page opens (a bill paid after midnight shows up on the next visit)
  const [today] = useState(() => bangkokDate(Date.now()));
  const paid = usePaidOrders(storeId, today);
  if (!storeId)
    return (
      <Page title={t.receiptsTitle}>
        <Notice kind="error">{t.posNoShop}</Notice>
      </Page>
    );
  if (paid === undefined) return <Loading />;
  return (
    <Page title={t.receiptsTitle}>
      {paid.length === 0 ? <p className="muted">{t.receiptsNone}</p> : null}
      <ul className="member-list">
        {paid.map((o) => (
          <li key={o.id} className="member-row">
            <button
              type="button"
              className="order-row"
              onClick={() => ctx.navigate(`/receipt/${o.id}`)}
            >
              <strong className="tabular">{o.receipt?.number ?? o.number}</strong>
              <span className="muted">{o.closedAt ? formatDateTime(lang, o.closedAt) : ''}</span>
              <span className="tabular">{formatTHB(o.receipt?.payable ?? 0, locale)}</span>
            </button>
          </li>
        ))}
      </ul>
    </Page>
  );
}
