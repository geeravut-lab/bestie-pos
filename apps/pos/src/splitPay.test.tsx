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
