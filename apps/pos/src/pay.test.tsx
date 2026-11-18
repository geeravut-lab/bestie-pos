import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addLine, closeOrder, newOrder, sendNew } from '@bestie/core';
import type { OrderDoc, ReceiptDoc } from '@bestie/core';
import { getOrder, listOutbox, resetOfflineDb, saveOrder, setDeviceBinding } from '@bestie/offline';
import { OrderPage } from './OrderPage';
import { ReceiptPage, ReceiptsPage } from './ReceiptPages';
import { ORG, STORE, baseTables, bindTablet, mountEn, pageCtx, posClient } from './testKit';

afterEach(() => {
  cleanup();
  setDeviceBinding(null);
});
beforeEach(async () => {
  await resetOfflineDb();
  localStorage.clear();
});

const ID = '11111111-1111-4111-8111-111111111111';
const seed = async (
  opts: { channel?: 'dine-in' | 'takeaway'; sent?: boolean; qty?: number } = {},
): Promise<OrderDoc> => {
  let o = newOrder({
    id: ID,
    orgId: ORG,
    storeId: STORE,
    number: 'A001',
    channel: opts.channel ?? 'takeaway',
    now: Date.now(),
  });
  o = addLine(o, {
    lineId: 'l1',
    item: {
      id: 'i1',
      name: { th: 'ผัดไทย', en: 'Pad Thai' },
      prices: { base: 8000 },
      station: 'kitchen',
    },
    groups: [],
    selected: [],
    quantity: opts.qty ?? 2,
  });
  if (opts.sent) o = sendNew(o, Date.now()).order;
  await saveOrder(null, o);
  return o;
};
const mountOrder = (tables = baseTables(), over = {}) => {
  const ctx = pageCtx(posClient(tables), { path: `/order/${ID}`, ...over });
  mountEn(<OrderPage ctx={ctx} orderId={ID} />);
  return ctx;
};
const openPay = async () => {
  await userEvent.click(await screen.findByRole('button', { name: 'Take payment' }));
  return screen.findByRole('dialog', { name: 'Cash payment' });
};

describe('taking cash', () => {
  it('shows the amount due and quick amounts; the button stays off until the cash covers the bill', async () => {
    bindTablet();
    await seed(); // 2 × 80.00 = 160.00 takeaway (VAT included, no service charge)
    mountOrder();
    const sheet = await openPay();
    expect(sheet.textContent).toContain('฿160');
    const confirm = within(sheet).getByRole('button', {
      name: 'Confirm payment',
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await userEvent.type(within(sheet).getByLabelText('Cash received (baht)'), '100');
    expect(within(sheet).getByText(/still missing/).textContent).toContain('฿60');
    expect(confirm.disabled).toBe(true);
    await userEvent.click(within(sheet).getByRole('button', { name: '฿200' }));
    expect(within(sheet).getByText(/Change: ฿40/)).toBeTruthy();
    expect(confirm.disabled).toBe(false);
  });

  it('pays: the bill is closed on the tablet, one close_order call is queued, and the receipt opens', async () => {
    bindTablet();
    await seed({ sent: true });
    const ctx = mountOrder();
    const sheet = await openPay();
    await userEvent.click(within(sheet).getByRole('button', { name: 'Exact' }));
    await userEvent.click(within(sheet).getByRole('button', { name: 'Confirm payment' }));
    await waitFor(() => expect(ctx.navigate).toHaveBeenCalledWith(`/receipt/${ID}`));
    const o = (await getOrder(ID))!;
    expect(o.status).toBe('paid');
    expect(o.receipt).toMatchObject({
      number: 'A-000001',
      payable: 16000,
      posId: 'POS-77',
      sellerName: 'Acme Co',
      sellerTaxId: '0105560123456',
      branchCode: '00001',
      staffName: 'Nok',
    });
    const rpcs = (await listOutbox()).filter((e) => e.op.kind === 'rpc');
    expect(rpcs).toHaveLength(1);
    expect(rpcs[0]!.op).toMatchObject({
      fn: 'close_order',
      args: { p: { order_id: ID, receipt_number: 'A-000001', payable: 16000 } },
    });
  });

  it('paying sends anything still new to the kitchen first (the close call comes last)', async () => {
    bindTablet();
    await seed(); // not sent
    const ctx = mountOrder();
    const sheet = await openPay();
    await userEvent.click(within(sheet).getByRole('button', { name: 'Exact' }));
    await userEvent.click(within(sheet).getByRole('button', { name: 'Confirm payment' }));
    await waitFor(() => expect(ctx.navigate).toHaveBeenCalled());
    expect((await getOrder(ID))!.lines[0]!.status).toBe('sent');
    const ops = (await listOutbox()).map((e) =>
      e.op.kind === 'rpc' ? e.op.fn : `${e.op.kind}:${e.op.table}`,
    );
    expect(ops.at(-1)).toBe('close_order');
    expect(ops.indexOf('insert:order_lines')).toBeLessThan(ops.indexOf('close_order'));
  });

  it("applies the shop's cash rounding as its own line", async () => {
    bindTablet();
    const t = baseTables();
    t.stores[0]!.rounding = { cash: 'nearest-baht' } as never;
    await seed({ qty: 1 });
    // 80.00 → make the line 79.90 so rounding matters
    const o = (await getOrder(ID))!;
    await saveOrder(o, { ...o, lines: o.lines.map((l) => ({ ...l, unitPrice: 7990 })) });
    mountOrder(t);
    const sheet = await openPay();
    expect(within(sheet).getByText('Rounding').closest('div')!.textContent).toContain('+฿0.10');
    expect(sheet.textContent).toContain('฿80');
  });

  it('a receipt number is never reused: the next bill gets the next number', async () => {
    bindTablet();
    await seed({ sent: true });
    const ctx = mountOrder();
    const sheet = await openPay();
    await userEvent.click(within(sheet).getByRole('button', { name: 'Exact' }));
    await userEvent.click(within(sheet).getByRole('button', { name: 'Confirm payment' }));
    await waitFor(() => expect(ctx.navigate).toHaveBeenCalled());
    cleanup();
    const second = newOrder({
      id: '22222222-2222-4222-8222-222222222222',
      orgId: ORG,
      storeId: STORE,
      number: 'A002',
      channel: 'takeaway',
      now: Date.now(),
    });
    await saveOrder(
      null,
      sendNew(
        addLine(second, {
          lineId: 'x',
          item: { id: 'i1', name: { th: 'ชา' }, prices: { base: 3000 }, station: null },
          groups: [],
          selected: [],
          quantity: 1,
        }),
        1,
      ).order,
    );
    const ctx2 = pageCtx(posClient(baseTables()), { path: '/order/2' });
    mountEn(<OrderPage ctx={ctx2} orderId="22222222-2222-4222-8222-222222222222" />);
    const sheet2 = await openPay();
    await userEvent.click(within(sheet2).getByRole('button', { name: 'Exact' }));
    await userEvent.click(within(sheet2).getByRole('button', { name: 'Confirm payment' }));
    await waitFor(() => expect(ctx2.navigate).toHaveBeenCalled());
    expect((await getOrder('22222222-2222-4222-8222-222222222222'))!.receipt!.number).toBe(
      'A-000002',
    );
  });

  it('no payment.take, or a tablet that is not set up → no Take payment button', async () => {
    bindTablet();
    await seed();
    mountOrder(baseTables(), { permissions: ['order.create'] });
    await screen.findByRole('button', { name: /^Pad Thai/ });
    expect(screen.queryByRole('button', { name: 'Take payment' })).toBeNull();
    cleanup();
    setDeviceBinding(null);
    mountOrder();
    await screen.findByRole('button', { name: /^Pad Thai/ });
    expect(screen.queryByRole('button', { name: 'Take payment' })).toBeNull();
  });

  it('an empty bill cannot be paid', async () => {
    bindTablet();
    await saveOrder(
      null,
      newOrder({
        id: ID,
        orgId: ORG,
        storeId: STORE,
        number: 'A001',
        channel: 'takeaway',
        now: Date.now(),
      }),
    );
    mountOrder();
    expect(
      ((await screen.findByRole('button', { name: 'Take payment' })) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('a paid bill shows "View receipt" and cannot be paid again', async () => {
    bindTablet();
    const o = await seed({ sent: true });
    const receipt = fakeReceipt();
    await saveOrder(o, closeOrder(o, receipt));
    const ctx = mountOrder();
    await userEvent.click(await screen.findByRole('button', { name: 'View receipt' }));
    expect(ctx.navigate).toHaveBeenCalledWith(`/receipt/${ID}`);
    expect(screen.queryByRole('button', { name: 'Take payment' })).toBeNull();
  });
});

const fakeReceipt = (over: Partial<ReceiptDoc> = {}): ReceiptDoc => ({
  number: 'A-000005',
  issuedAt: '2026-11-18T05:30:00.000Z',
  lang: 'en',
  sellerName: 'Acme Co',
  sellerTaxId: '0105560123456',
  branchCode: '00001',
  posId: 'POS-77',
  vatRegistered: true,
  vatBps: 700,
  serviceBps: 0,
  priceMode: 'inclusive',
  subtotal: 16000,
  serviceCharge: 0,
  vat: 1047,
  netBeforeVat: 14953,
  total: 16000,
  rounding: 0,
  payable: 16000,
  staffName: 'Nok',
  payments: [
    {
      id: 'p',
      tender: 'cash',
      amount: 16000,
      tendered: 20000,
      change: 4000,
      createdAt: '2026-11-18T05:30:00.000Z',
    },
  ],
  ...over,
});

describe('<ReceiptPage>', () => {
  const paid = async (r: ReceiptDoc) => {
    const o = await seed({ sent: true });
    await saveOrder(o, closeOrder(o, r));
  };
  const mountReceipt = () =>
    mountEn(
      <ReceiptPage
        ctx={pageCtx(posClient(baseTables()), { path: `/receipt/${ID}` })}
        orderId={ID}
      />,
    );

  it('carries what an abbreviated tax invoice needs: seller, tax id, branch, POS ID, number, items, VAT, cash and change', async () => {
    bindTablet();
    await paid(fakeReceipt());
    mountReceipt();
    const r = await screen.findByRole('article');
    for (const text of [
      'Acme Co',
      'Tax ID 0105560123456',
      'Branch 00001',
      'POS ID POS-77',
      'No. A-000005',
      'Receipt / Abbreviated tax invoice',
      '2 × Pad Thai',
      'VAT 7%',
      'Prices include VAT',
    ])
      expect(r.textContent, text).toContain(text);
    expect(r.textContent).toContain('฿160'); // total
    expect(r.textContent).toContain('฿200'); // cash handed over
    expect(r.textContent).toContain('฿40'); // change
  });

  it('can be printed in Thai or English regardless of the staff screen language', async () => {
    bindTablet();
    await paid(fakeReceipt());
    mountReceipt();
    await screen.findByRole('article');
    await userEvent.click(screen.getByRole('button', { name: 'ไทย' }));
    expect(screen.getByRole('article').textContent).toContain('ใบเสร็จรับเงิน / ใบกำกับภาษีอย่างย่อ');
    expect(screen.getByRole('article').textContent).toContain(
      'สำนักงานใหญ่'.length ? 'สาขา 00001' : '',
    );
    expect(screen.getByRole('article').getAttribute('lang')).toBe('th');
  });

  it('a shop that is not VAT-registered gets a plain receipt without VAT lines', async () => {
    bindTablet();
    await paid(fakeReceipt({ vatRegistered: false, vatBps: 0, vat: 0, netBeforeVat: 16000 }));
    mountReceipt();
    const r = await screen.findByRole('article');
    expect(r.textContent).not.toContain('VAT');
    expect(r.textContent).not.toContain('Abbreviated tax invoice');
  });

  it('shows rounding and service charge lines when they exist', async () => {
    bindTablet();
    await paid(
      fakeReceipt({
        serviceCharge: 1600,
        total: 17590,
        rounding: 10,
        payable: 17600,
        subtotal: 16000,
      }),
    );
    mountReceipt();
    const r = await screen.findByRole('article');
    expect(r.textContent).toContain('Service charge');
    expect(r.textContent).toContain('Rounding');
  });

  it('a bill that is not paid has no receipt', async () => {
    bindTablet();
    await seed();
    mountReceipt();
    expect(await screen.findByText('This bill has not been paid yet.')).toBeTruthy();
  });
});

describe('<ReceiptsPage>', () => {
  it('lists the bills paid today with number, time and amount', async () => {
    bindTablet();
    const o = await seed({ sent: true });
    await saveOrder(o, closeOrder(o, fakeReceipt({ issuedAt: new Date().toISOString() })));
    const ctx = pageCtx(posClient(baseTables()), { path: '/receipts' });
    mountEn(<ReceiptsPage ctx={ctx} />);
    const row = await screen.findByText('A-000005');
    expect(row.closest('button')!.textContent).toContain('฿160');
    await userEvent.click(row.closest('button')!);
    expect(ctx.navigate).toHaveBeenCalledWith(`/receipt/${ID}`);
  });

  it('says so when nothing was paid today', async () => {
    bindTablet();
    mountEn(<ReceiptsPage ctx={pageCtx(posClient(baseTables()), { path: '/receipts' })} />);
    expect(await screen.findByText('No receipts yet today.')).toBeTruthy();
  });
});
