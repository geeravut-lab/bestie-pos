import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { addLine, buildCashReceipt, newOrder, orderBill, sendNew } from '@bestie/core';
import type { BillConfig, OrderDoc } from '@bestie/core';
import { I18nProvider } from '@bestie/i18n';
import { ReceiptView } from './ReceiptView';

afterEach(cleanup);

const cfg: BillConfig = { priceMode: 'inclusive', vatBps: 700, serviceChargeBps: 0 };
const base = (): OrderDoc =>
  sendNew(
    addLine(
      newOrder({
        id: 'o1',
        orgId: 'org',
        storeId: 'st',
        number: 'A001',
        channel: 'takeaway',
        now: Date.UTC(2026, 10, 18, 5),
      }),
      {
        lineId: 'l1',
        item: {
          id: 'i',
          name: { th: 'x', en: 'Pad Thai' },
          prices: { base: 9000 },
          station: 'kitchen',
        },
        groups: [],
        selected: [],
        quantity: 2,
      },
    ),
    1,
  ).order;

const receiptOf = (o: OrderDoc, lang: 'th' | 'en') =>
  buildCashReceipt({
    order: o,
    bill: orderBill(o, cfg),
    billConfig: cfg,
    roundingRule: 'none',
    tendered: 20000,
    number: 'A-000001',
    paymentId: 'p1',
    seller: {
      sellerName: 'Acme Co',
      sellerTaxId: '0105560123456',
      branchCode: '00001',
      posId: 'POS-77',
      vatRegistered: true,
      staffName: 'Nok',
    },
    lang,
    now: Date.UTC(2026, 10, 18, 5, 30),
  });

const show = (o: OrderDoc, lang: 'th' | 'en') =>
  render(
    <I18nProvider initialLang="en">
      <ReceiptView order={o} receipt={receiptOf(o, lang)} lang={lang} />
    </I18nProvider>,
  );

describe('<ReceiptView> Points discount', () => {
  it('prints a discount line with the points used, and the lower total', () => {
    show({ ...base(), customerId: 'c1', pointsUsed: 30, pointsDiscount: 3000 }, 'en');
    expect(screen.getByText('Points discount (30 points)')).toBeTruthy();
    expect(screen.getByText('−฿30')).toBeTruthy();
  });
  it('in the language chosen for the receipt', () => {
    show({ ...base(), customerId: 'c1', pointsUsed: 30, pointsDiscount: 3000 }, 'th');
    expect(screen.getByText(/ส่วนลดจากแต้ม \(30 แต้ม\)/)).toBeTruthy();
  });
  it('a receipt without points has no such line', () => {
    show(base(), 'en');
    expect(screen.queryByText(/Points discount/)).toBeNull();
  });
});
