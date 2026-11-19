import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PaySheet } from './PaySheet';
import { SplitPane } from './SplitPane';
import type { OnlinePay } from './onlinePay';
import { mountEn } from './testKit';

afterEach(cleanup);

const online = (available = true): OnlinePay => ({
  available,
  hasReader: false,
  start: async () => ({ error: 'err_pay_failed' }),
  cancel: async () => {},
  status: async () => null,
  findLive: async () => null,
  finish: async () => {},
});

describe('<SplitPane>', () => {
  const mount = (over: Partial<Parameters<typeof SplitPane>[0]> = {}) => {
    const onPay = vi.fn(async () => null);
    mountEn(
      <SplitPane
        total={21000}
        rule="none"
        locale="en-GB"
        online
        credit={null}
        onPay={onPay}
        onClose={() => {}}
        {...over}
      />,
    );
    return { onPay };
  };

  it('splits equally between N payers, all cash, and sends the legs that add up', async () => {
    const { onPay } = mount();
    fireEvent.change(screen.getByLabelText('Number of people'), { target: { value: '3' } });
    await userEvent.click(screen.getByRole('button', { name: 'Split equally' }));
    expect((screen.getByLabelText('Payer 1 share (THB)') as HTMLInputElement).value).toBe('70');
    expect(screen.getByText('฿0')).toBeTruthy(); // nothing left to share
    await userEvent.click(screen.getByRole('button', { name: 'Take payment and close the bill' }));
    await waitFor(() => expect(onPay).toHaveBeenCalledTimes(1));
    const legs = (onPay.mock.calls[0] as unknown as [{ tender: string; amount: number }[]])[0];
    expect(legs.map((l) => l.amount)).toEqual([7000, 7000, 7000]);
    expect(legs.every((l) => l.tender === 'cash')).toBe(true);
  });

  it('cannot close while the shares do not add up, and says why', async () => {
    mount();
    await userEvent.click(screen.getByRole('button', { name: 'Split equally' }));
    const a = screen.getByLabelText('Payer 1 share (THB)');
    await userEvent.clear(a);
    await userEvent.type(a, '50');
    expect(
      (screen.getByRole('button', { name: 'Take payment and close the bill' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText('The shares must add up to the bill total.')).toBeTruthy();
  });

  it('offers Credit only with a customer, and refuses more than their balance', async () => {
    mount();
    expect(screen.getByText(/Put a customer on the bill first/)).toBeTruthy();
    cleanup();
    mount({ credit: { name: 'Anna', balance: 5000 } });
    expect(screen.getByText('Anna’s Credit: ฿50')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Add a payer' }));
    await userEvent.selectOptions(screen.getByLabelText('Payer 1 pays with'), 'credit');
    expect(within(screen.getByLabelText('Payer 1 pays with')).getByText('Credit')).toBeTruthy();
    const a = screen.getByLabelText('Payer 1 share (THB)');
    await userEvent.clear(a);
    await userEvent.type(a, '210');
    expect(screen.getByText('Not enough Credit.')).toBeTruthy();
  });

  it('offers PromptPay / card only when the shop switched them on (card also needs a reader)', async () => {
    mount();
    await userEvent.click(screen.getByRole('button', { name: 'Add a payer' }));
    expect(screen.queryByRole('option', { name: 'PromptPay (QR)' })).toBeNull();
    cleanup();
    mount({ pay: online(), methods: { promptpay: true, gateway: true } });
    await userEvent.click(screen.getByRole('button', { name: 'Add a payer' }));
    expect(screen.getByRole('option', { name: 'PromptPay (QR)' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Card (reader)' })).toBeNull(); // no reader on this device
    cleanup();
    mount({ pay: { ...online(), hasReader: true }, methods: { promptpay: true, gateway: true } });
    await userEvent.click(screen.getByRole('button', { name: 'Add a payer' }));
    expect(screen.getByRole('option', { name: 'Card (reader)' })).toBeTruthy();
  });

  it('a split with one PromptPay share goes to the QR step with the cash / Credit shares riding along, and does not close by itself', async () => {
    const start = vi.fn(async () => ({
      charge: { attemptId: 'a1', tender: 'promptpay' as const, amount: 10000, qrImageUrl: null },
    }));
    const { onPay } = mount({
      credit: { name: 'Anna', balance: 90000 },
      pay: { ...online(), start },
      methods: { promptpay: true, gateway: false },
    });
    const add = screen.getByRole('button', { name: 'Add a payer' });
    await userEvent.click(add);
    await userEvent.click(add);
    await userEvent.click(add);
    const set = async (n: number, tender: string, amount: string) => {
      await userEvent.selectOptions(screen.getByLabelText(`Payer ${n} pays with`), tender);
      const a = screen.getByLabelText(`Payer ${n} share (THB)`);
      await userEvent.clear(a);
      await userEvent.type(a, amount);
    };
    await set(1, 'credit', '50');
    await set(2, 'cash', '60');
    await set(3, 'promptpay', '100');
    await userEvent.click(
      screen.getByRole('button', { name: 'Continue to the PromptPay / card payment' }),
    );
    expect(await screen.findByText(/Collect the cash and use the Credit shares now/)).toBeTruthy();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Show QR for the guest to scan' }),
    );
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    const [tender, step] = start.mock.calls[0] as unknown as [
      string,
      { legs: { tender: string; amount: number }[]; step: number; held: number },
    ];
    expect(tender).toBe('promptpay');
    expect(step).toMatchObject({ step: 0, held: 0 });
    expect(step.legs.map((l) => [l.tender, l.amount])).toEqual([
      ['credit', 5000],
      ['cash', 6000],
      ['promptpay', 10000],
    ]);
    expect(onPay).not.toHaveBeenCalled();
  });

  it('several PromptPay / card shares are charged one after the other; each paid one is held and the next starts', async () => {
    let n = 0;
    const start = vi.fn(async (tender: 'promptpay' | 'gateway') => ({
      charge: { attemptId: `a${(n += 1)}`, tender, amount: 7000, qrImageUrl: null },
    }));
    const status = vi.fn(async () => ({ status: 'succeeded' as const, error: null }));
    const finish = vi.fn(async () => {});
    mount({
      pay: { ...online(), hasReader: true, start, status, finish },
      methods: { promptpay: true, gateway: true },
    });
    const add = screen.getByRole('button', { name: 'Add a payer' });
    for (let i = 0; i < 3; i++) await userEvent.click(add);
    const set = async (k: number, tender: string, amount: string) => {
      await userEvent.selectOptions(screen.getByLabelText(`Payer ${k} pays with`), tender);
      const a = screen.getByLabelText(`Payer ${k} share (THB)`);
      await userEvent.clear(a);
      await userEvent.type(a, amount);
    };
    await set(1, 'promptpay', '70');
    await set(2, 'gateway', '70');
    await set(3, 'promptpay', '70');
    await userEvent.click(
      screen.getByRole('button', { name: 'Continue to the PromptPay / card payment' }),
    );
    expect(await screen.findByText('PromptPay / card payment 1 of 3')).toBeTruthy();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Show QR for the guest to scan' }),
    );
    // payment 1 succeeds (held) → payment 2 of 3 appears with the held amount remembered
    expect(
      await screen.findByText('PromptPay / card payment 2 of 3', {}, { timeout: 4000 }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send the amount to the card reader' })).toBeTruthy();
    await userEvent.click(
      screen.getByRole('button', { name: 'Send the amount to the card reader' }),
    );
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    const second = start.mock.calls[1] as unknown as [string, { step: number; held: number }];
    expect(second[0]).toBe('gateway');
    expect(second[1]).toMatchObject({ step: 0, held: 7000 });
    expect(
      (second[1] as unknown as { legs: { tender: string }[] }).legs.map((l) => l.tender),
    ).toEqual(['gateway', 'promptpay']); // the paid one is out
    expect(finish).not.toHaveBeenCalled(); // earlier shares never close the bill
  });

  it('a bill that already holds shares: the rest must add up to what is left, and the held amount is shown', async () => {
    const { onPay } = mount({ held: 7000 });
    expect(screen.getByText(/Already paid by PromptPay \/ card: ฿70/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Split equally' }));
    expect((screen.getByLabelText('Payer 1 share (THB)') as HTMLInputElement).value).toBe('70');
    await userEvent.click(screen.getByRole('button', { name: 'Take payment and close the bill' }));
    await waitFor(() => expect(onPay).toHaveBeenCalledTimes(1));
    const [, heldArg] = onPay.mock.calls[0] as unknown as [unknown, number];
    expect(heldArg).toBe(7000);
  });

  it('money held as a DEPOSIT is described as a deposit (not as a locked QR / card payment) and still counts as paid', async () => {
    const { onPay } = mount({ held: 7000, heldDeposit: true });
    expect(screen.getByText(/Deposit already taken: ฿70/)).toBeTruthy();
    expect(screen.queryByText(/Already paid by PromptPay/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Add a payer' }));
    await userEvent.click(screen.getByRole('button', { name: 'Take payment and close the bill' }));
    await waitFor(() => expect(onPay).toHaveBeenCalledTimes(1));
    const [legs, heldArg] = onPay.mock.calls[0] as unknown as [{ amount: number }[], number];
    expect(legs.map((l) => l.amount)).toEqual([14000]); // 210.00 − 70.00 deposit
    expect(heldArg).toBe(7000);
  });

  it('says it needs a connection offline', () => {
    mount({ online: false });
    expect(screen.getByText('Splitting a payment needs a connection.')).toBeTruthy();
  });

  it('a refused close shows the error and keeps the sheet', async () => {
    const onPay = vi.fn(async () => 'err_pay_failed' as const);
    mount({ onPay });
    await userEvent.click(screen.getByRole('button', { name: 'Split equally' }));
    await userEvent.click(screen.getByRole('button', { name: 'Take payment and close the bill' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});

describe('<PaySheet> split tab', () => {
  it('shows the Split tab only when the screen can split', async () => {
    mountEn(
      <PaySheet
        total={21000}
        rule="none"
        online={online()}
        onPay={async () => null}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByRole('tab', { name: 'Split' })).toBeNull();
    cleanup();
    mountEn(
      <PaySheet
        total={21000}
        rule="none"
        online={online()}
        onPay={async () => null}
        onSplitPay={async () => null}
        onClose={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole('tab', { name: 'Split' }));
    expect(screen.getByRole('button', { name: 'Split equally' })).toBeTruthy();
  });
});
