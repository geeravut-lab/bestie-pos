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
    const [tender, legs] = start.mock.calls[0] as unknown as [
      string,
      { tender: string; amount: number }[],
    ];
    expect(tender).toBe('promptpay');
    expect(legs.map((l) => [l.tender, l.amount])).toEqual([
      ['credit', 5000],
      ['cash', 6000],
      ['promptpay', 10000],
    ]);
    expect(onPay).not.toHaveBeenCalled();
  });

  it('two PromptPay / card shares are refused', async () => {
    mount({ pay: online(), methods: { promptpay: true, gateway: false } });
    const add = screen.getByRole('button', { name: 'Add a payer' });
    await userEvent.click(add);
    await userEvent.click(add);
    await userEvent.selectOptions(screen.getByLabelText('Payer 1 pays with'), 'promptpay');
    await userEvent.selectOptions(screen.getByLabelText('Payer 2 pays with'), 'promptpay');
    expect(screen.getByText('Only one person can pay by PromptPay / card on a bill.')).toBeTruthy();
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
