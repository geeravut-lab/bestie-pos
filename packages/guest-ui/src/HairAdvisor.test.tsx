import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@bestie/i18n';
import { HairAdvisor } from './HairAdvisor';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const STYLES = [
  {
    id: 'bob',
    name: { th: 'บ๊อบ', en: 'Bob' },
    lengths: ['short', 'medium'],
    textures: ['straight'],
    faces: ['oval'],
    upkeep: 'low',
    about: { en: 'Chin length' },
  },
  {
    id: 'layers',
    name: { th: 'เลเยอร์', en: 'Long layers' },
    lengths: ['long'],
    textures: [],
    faces: [],
    upkeep: 'high',
    about: null,
  },
];
let posts: { body: Record<string, unknown> }[];
const route = (o: { styles?: unknown[]; hair?: unknown } = {}) =>
  vi.fn(async (url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push({ body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(o.hair ?? { ok: true, photo: false }));
    }
    return new Response(JSON.stringify({ styles: o.styles ?? STYLES }));
  });
const mount = () =>
  render(
    <I18nProvider initialLang="en">
      <HairAdvisor token={'a'.repeat(32)} id="b1" code="ABCD1234" />
    </I18nProvider>,
  );

describe('<HairAdvisor>', () => {
  it('shows nothing when the shop has no styles', async () => {
    posts = [];
    vi.stubGlobal('fetch', route({ styles: [] }));
    const { container } = mount();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('suggests styles that suit the answers and sends the choice with the booking code', async () => {
    posts = [];
    vi.stubGlobal('fetch', route());
    mount();
    expect(await screen.findByText('Bob')).toBeTruthy();
    expect(screen.getByText('Long layers')).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText('Your hair length now'), 'long');
    expect(screen.queryByText('Bob')).toBeNull(); // a short style is not offered for long hair
    await userEvent.click(screen.getByLabelText('Long layers'));
    await userEvent.click(screen.getByRole('button', { name: 'Send to the stylist' }));
    expect(await screen.findByText('Sent to your stylist.')).toBeTruthy();
    expect(posts[0]!.body).toMatchObject({
      op: 'hair',
      id: 'b1',
      code: 'ABCD1234',
      request: { style_id: 'layers', answers: { length: 'long' } },
    });
    expect((posts[0]!.body.request as { photo?: unknown }).photo).toBeUndefined();
  });

  it('a photo cannot be chosen until the consent box is ticked, and is never sent without it', async () => {
    posts = [];
    vi.stubGlobal('fetch', route());
    mount();
    await screen.findByText('Bob');
    const file = screen.getByLabelText('Choose a photo (JPG / PNG / WebP)') as HTMLInputElement;
    expect(file.disabled).toBe(true);
    await userEvent.click(
      screen.getByLabelText('I agree that the shop keeps my hair photo for this booking only.'),
    );
    expect(file.disabled).toBe(false);
  });

  it('says so when the booking is too far away for a photo, and lets the guest remove one', async () => {
    posts = [];
    vi.stubGlobal('fetch', route({ hair: { ok: false, error: 'photo_too_early' } }));
    mount();
    await screen.findByText('Bob');
    await userEvent.click(screen.getByRole('button', { name: 'Remove my photo' }));
    expect(await screen.findByText(/within 2 days/)).toBeTruthy();
    expect((posts[0]!.body.request as { remove_photo?: boolean }).remove_photo).toBe(true);
  });
});
