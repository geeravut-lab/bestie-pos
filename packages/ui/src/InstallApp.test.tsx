import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@bestie/i18n';
import { InstallAppButton, InstallAppCard } from './InstallApp';
import { isIosDevice, isPhoneDevice, resetInstallForTests } from './useInstallApp';

afterEach(() => {
  cleanup();
  resetInstallForTests();
});

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

  it('says so when the person closes the browser dialog', async () => {
    mount(<InstallAppCard />);
    const { prompt } = offerInstall('dismissed');
    await userEvent.click(
      await screen.findByRole('button', { name: 'Install the app on this device' }),
    );
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Not installed yet/)).toBeTruthy();
  });

  it('shows the top-bar button on a computer once the browser offers installation, and it opens the browser dialog', async () => {
    mount(<InstallAppButton onShowSteps={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Install app' })).toBeNull();
    const { prompt } = offerInstall('accepted');
    await userEvent.click(await screen.findByRole('button', { name: 'Install app' }));
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
  });

  it('knows a smartphone from a tablet and a desktop', () => {
    expect(isPhoneDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe(true);
    expect(isPhoneDevice('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36')).toBe(
      true,
    );
    expect(isPhoneDevice('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')).toBe(false);
    expect(isPhoneDevice('Mozilla/5.0 (Linux; Android 14; SM-X900) Safari/537.36')).toBe(false); // an Android tablet has no "Mobile"
    expect(isPhoneDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120')).toBe(false);
    expect(isPhoneDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15')).toBe(
      false,
    );
  });

  it('keeps the top-bar button off a phone, and the account card still works there', async () => {
    const ua = vi
      .spyOn(navigator, 'userAgent', 'get')
      .mockReturnValue('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36');
    mount(
      <>
        <InstallAppButton onShowSteps={() => {}} />
        <InstallAppCard />
      </>,
    );
    offerInstall('accepted'); // the browser offers installation
    expect(
      await screen.findByRole('button', { name: 'Install the app on this device' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Install app' })).toBeNull();
    ua.mockRestore();
  });
});
