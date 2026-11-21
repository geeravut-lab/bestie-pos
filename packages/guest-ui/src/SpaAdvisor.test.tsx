import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@bestie/i18n';
import { SpaAdvisor } from './SpaAdvisor';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const services = [
  { id: 'thai', name: { th: 'นวดไทย', en: 'Thai massage' } },
  { id: 'oil', name: { th: 'นวดน้ำมัน', en: 'Oil massage' } },
  { id: 'yoga', name: { th: 'โยคะ', en: 'Flow yoga' } },
];
const spa = {
  enabled: true,
  services: [
    { id: 'thai', tags: ['thai_massage'] },
    { id: 'oil', tags: ['oil_massage'] },
    { id: 'yoga', tags: ['yoga_flow'] },
  ],
};
const mount = (info: unknown, onPick = vi.fn()) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ spa: info }))),
  );
  render(
    <I18nProvider guest initialLang="en">
      <SpaAdvisor token={'a'.repeat(32)} services={services} onPick={onPick} />
    </I18nProvider>,
  );
  return onPick;
};

describe('<SpaAdvisor>', () => {
  it('shows nothing when the shop has not switched it on (or no therapist has signed)', async () => {
    mount({ enabled: false, services: [] });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('Not sure what to book? Answer a few questions')).toBeNull();
  });
  it('suggests services, leaves out what is unsafe, and tells the therapist what to check', async () => {
    const onPick = mount(spa);
    await userEvent.click(await screen.findByRole('button', { name: 'Relax and unwind' }));
    await userEvent.click(screen.getByLabelText('Pregnant'));
    await userEvent.click(screen.getByRole('button', { name: 'Show suggestions' }));
    expect(await screen.findByText('Oil massage')).toBeTruthy();
    expect(screen.queryByText('Thai massage')).toBeNull(); // avoided in pregnancy
    expect(screen.queryByText('Flow yoga')).toBeNull();
    expect(screen.getByText('Ask your therapist first: Pregnant')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Choose this service' }));
    expect(onPick).toHaveBeenCalledWith('oil', 'Spa advisor: please check pregnant');
    expect(screen.getByText(/We will tell the therapist what to check/)).toBeTruthy();
  });
  it('a fever stops the suggestions altogether', async () => {
    mount(spa);
    await userEvent.click(await screen.findByLabelText('Fever or infection today'));
    await userEvent.click(screen.getByRole('button', { name: 'Show suggestions' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('Oil massage')).toBeNull();
  });
  it('speaks German', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ spa }))),
    );
    render(
      <I18nProvider guest initialLang="de">
        <SpaAdvisor token={'a'.repeat(32)} services={services} onPick={() => {}} />
      </I18nProvider>,
    );
    expect(
      await screen.findByText('Unsicher, was Sie buchen sollen? Beantworten Sie ein paar Fragen'),
    ).toBeTruthy();
  });
});
