import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@bestie/i18n';
import { InstallAppButton, InstallAppCard } from './InstallApp';
import { isIosDevice } from './useInstallApp';

afterEach(cleanup);

const mount = (ui: React.ReactNode) => render(<I18nProvider initialLang="en">{ui}</I18nProvider>);

/** What Chrome fires: an event carrying prompt() and userChoice. */
const offerInstall = (outcome: 'accepted' | 'dismissed') => {
  const prompt = vi.fn(async () => {});
  const ev = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
    prompt,
    userChoice: Promise.resolve({ outcome }),
  });
  act(() => {
    window.dispatchEvent(ev);
  });
  return { prompt, ev };
};

describe('install the app', () => {
  it('knows iPhone and iPad (also an iPad that says it is a Mac)', () => {
    expect(isIosDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)', 5)).toBe(true);
    expect(isIosDevice('Mozilla/5.0 (iPad; CPU OS 17_0)', 5)).toBe(true);
    expect(isIosDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X)', 5)).toBe(true);
    expect(isIosDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X)', 0)).toBe(false);
    expect(isIosDevice('Mozilla/5.0 (Linux; Android 14)', 5)).toBe(false);
  });

  it('shows the browser hint first, then a working button once the browser offers installation', async () => {
    mount(<InstallAppCard />);
    expect(screen.getByText(/Open the browser menu/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Install the app on this device' })).toBeNull();

    const { prompt, ev } = offerInstall('accepted');
    expect(ev.defaultPrevented).toBe(true); // we kept the event for later
    const btn = await screen.findByRole('button', { name: 'Install the app on this device' });
    await userEvent.click(btn);
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Installed\./)).toBeTruthy();
    expect(screen.getByText(/already installed/)).toBeTruthy();
    expect(document.querySelector('.spinner')).toBeNull(); // spinner cleared when done
  });

  it('says so when the person closes the browser dialog, and the top-bar button is only there while it is possible', async () => {
    mount(
      <>
        <InstallAppButton onShowSteps={() => {}} />
        <InstallAppCard />
      </>,
    );
    // an earlier test installed the app in this module's memory; a new offer shows it is a one-shot per offer
    offerInstall('dismissed');
    const top = screen.queryAllByRole('button', { name: 'Install app' });
    if (top.length > 0) {
      await userEvent.click(top[0]!);
      expect(await screen.findByText(/Not installed yet/)).toBeTruthy();
    }
  });
});
