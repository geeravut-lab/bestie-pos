import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@bestie/i18n';
import { DepositSlip } from './DepositSlip';

afterEach(() => {
  cleanup();
  document.getElementById('print-root')?.remove();
  vi.unstubAllGlobals();
});

const deposit = {
  id: 'd1',
  appointmentId: 'a1',
  amount: 30000,
  method: 'cash' as const,
  status: 'held' as const,
  reference: null,
  invoiceNo: 'DP-000007',
  invoiceVat: 1963,
  feeInvoiceNo: 'NF-000002',
  feeVat: 1308,
  createdAt: '2026-11-20T05:00:00Z',
  resolvedAt: '2026-11-21T05:00:00Z',
};
const seller = {
  shop: 'Salon',
  name: 'Island Co',
  taxId: '0105500000000',
  branch: '00001',
  vatBps: 700,
};
const mount = (fee: boolean, s = seller) => {
  const print = vi.fn();
  vi.stubGlobal('print', print);
  const done = vi.fn();
  render(
    <I18nProvider initialLang="en">
      <DepositSlip
        deposit={deposit}
        fee={fee}
        seller={s}
        service="Massage"
        guest="Anna"
        onDone={done}
      />
    </I18nProvider>,
  );
  return { print, done };
};

describe('<DepositSlip>', () => {
  it("prints the deposit receipt with its number, the VAT inside and the seller's tax id, then goes away", async () => {
    const { print, done } = mount(false);
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(done).toHaveBeenCalled();
    const text = document.getElementById('print-root')!.textContent!;
    expect(text).toContain('Deposit receipt / tax invoice');
    expect(text).toContain('DP-000007');
    expect(text).toContain('0105500000000');
    expect(text).toContain('VAT 7%');
    expect(text).toContain('฿19.63');
    expect(text).toContain('฿280.37'); // 300.00 - 19.63
  });
  it('the kept no-show fee has its own number and VAT; a shop without VAT shows none', async () => {
    const { print } = mount(true, { ...seller, vatBps: 0 });
    await waitFor(() => expect(print).toHaveBeenCalled());
    const text = document.getElementById('print-root')!.textContent!;
    expect(text).toContain('No-show fee receipt');
    expect(text).toContain('NF-000002');
    expect(text).toContain('Not VAT registered');
    expect(text).not.toContain('VAT 7%');
  });
});
