import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError, I18nProvider } from '@bestie/i18n';
import { AsyncButton } from './AsyncButton';

afterEach(cleanup);

const wrap = (ui: React.ReactNode) => render(<I18nProvider initialLang="en">{ui}</I18nProvider>);

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('<AsyncButton>', () => {
  it('shows a spinner while the action runs and removes it when it finishes', async () => {
    const d = deferred();
    wrap(<AsyncButton onClick={() => d.promise}>Pay</AsyncButton>);
    const button = screen.getByRole('button', { name: /pay/i });
    expect(button.querySelector('.spinner')).toBeNull();

    await userEvent.click(button);
    expect(button.querySelector('.spinner')).not.toBeNull();
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('status').textContent).toBe('Working on it');

    d.resolve();
    await waitFor(() => expect(button.querySelector('.spinner')).toBeNull());
    expect(button.getAttribute('aria-busy')).toBeNull();
  });

  it('ignores extra clicks while busy (no double submit)', async () => {
    const d = deferred();
    const action = vi.fn(() => d.promise);
    wrap(<AsyncButton onClick={action}>Pay</AsyncButton>);
    const button = screen.getByRole('button', { name: /pay/i });

    await userEvent.click(button);
    await userEvent.click(button);
    await userEvent.click(button);
    expect(action).toHaveBeenCalledTimes(1);

    d.resolve();
    await waitFor(() => expect(button.getAttribute('aria-busy')).toBeNull());
    await userEvent.click(button);
    expect(action).toHaveBeenCalledTimes(2);
  });

  it('ignores two synchronous clicks in the same tick', async () => {
    const d = deferred();
    const action = vi.fn(() => d.promise);
    wrap(<AsyncButton onClick={action}>Pay</AsyncButton>);
    const button = screen.getByRole('button', { name: /pay/i });
    button.click();
    button.click();
    expect(action).toHaveBeenCalledTimes(1);
    d.resolve();
    await waitFor(() => expect(button.getAttribute('aria-busy')).toBeNull());
  });

  it('stops the spinner and reports an err_* code when the action fails', async () => {
    const onActionError = vi.fn();
    wrap(
      <AsyncButton
        onClick={async () => {
          throw new AppError('err_forbidden');
        }}
        onActionError={onActionError}
      >
        Void bill
      </AsyncButton>,
    );
    const button = screen.getByRole('button', { name: /void bill/i });
    await userEvent.click(button);
    await waitFor(() => expect(onActionError).toHaveBeenCalledWith('err_forbidden'));
    expect(button.querySelector('.spinner')).toBeNull();
  });

  it('works for synchronous handlers too', async () => {
    const action = vi.fn();
    wrap(<AsyncButton onClick={action}>Go</AsyncButton>);
    await userEvent.click(screen.getByRole('button', { name: /go/i }));
    expect(action).toHaveBeenCalledTimes(1);
  });
});
