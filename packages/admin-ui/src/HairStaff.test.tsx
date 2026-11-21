import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { PageContext } from '@bestie/auth';
import { I18nProvider } from '@bestie/i18n';
import { fakeDb } from './fakeDb';
import { HairRequestPanel } from './HairRequestPanel';
import { HairStylesPage } from './HairStylesPage';

afterEach(cleanup);
const ctx = (client: unknown, over: Partial<PageContext> = {}): PageContext => ({
  path: '/hair-styles',
  navigate: () => {},
  client: client as never,
  orgId: 'o1',
  storeId: 's1',
  permissions: ['menu.edit', 'order.create'],
  isOwner: false,
  isPlatformAdmin: false,
  ...over,
});
const wrap = (ui: React.ReactNode) => render(<I18nProvider initialLang="en">{ui}</I18nProvider>);
const styleRow = {
  id: 'h1',
  name: { th: 'บ๊อบ', en: 'Bob' },
  about: null,
  lengths: ['short'],
  textures: [],
  faces: ['oval'],
  upkeep: 'low',
};

describe('<HairStylesPage>', () => {
  it('lists the styles and saves a new one through the database function', async () => {
    const db = fakeDb({ hair_styles: [styleRow] });
    wrap(<HairStylesPage ctx={ctx(db.client)} />);
    expect(await screen.findByText('Bob')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Add a style' }));
    await userEvent.type(screen.getByLabelText('Name (Thai)'), 'เลเยอร์');
    await userEvent.click(screen.getByLabelText('Long'));
    await userEvent.click(screen.getByRole('button', { name: 'Save the style' }));
    await waitFor(() => expect(db.rpcs.some((r) => r.fn === 'save_hair_style')).toBe(true));
    const p = (
      db.rpcs.find((r) => r.fn === 'save_hair_style')!.args as { p: Record<string, unknown> }
    ).p;
    expect(p).toMatchObject({ store_id: 's1', name: { th: 'เลเยอร์' }, lengths: ['long'] });
  });

  it('asks for a Thai name; a person without menu.edit can only look', async () => {
    const db = fakeDb({ hair_styles: [styleRow] });
    wrap(<HairStylesPage ctx={ctx(db.client)} />);
    await screen.findByText('Bob');
    await userEvent.click(screen.getByRole('button', { name: 'Add a style' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save the style' }));
    expect(await screen.findByText(/Enter the Thai name/)).toBeTruthy();
    expect(db.rpcs.length).toBe(0);
    cleanup();
    wrap(
      <HairStylesPage
        ctx={ctx(fakeDb({ hair_styles: [styleRow] }).client, { permissions: ['order.create'] })}
      />,
    );
    await screen.findByText('Bob');
    expect(screen.queryByRole('button', { name: 'Add a style' })).toBeNull();
  });
});

describe('<HairRequestPanel>', () => {
  const future = new Date(Date.now() + 3_600_000).toISOString();
  it('shows the chosen style and answers, and loads the photo only when asked', async () => {
    const db = fakeDb(
      {
        hair_requests: [
          {
            style_id: 'h1',
            answers: { length: 'short', face: 'unknown' },
            photo_expires_at: future,
          },
        ],
        hair_styles: [styleRow],
      },
      { rpc: { get_hair_photo: { data: { mime: 'image/jpeg', data: 'QUJD' } } } },
    );
    wrap(<HairRequestPanel ctx={ctx(db.client)} appointmentId="a1" />);
    expect(await screen.findByText('Bob')).toBeTruthy();
    expect(screen.getByText(/Your hair length now: Short/)).toBeTruthy();
    expect(screen.queryByText(/Face shape/)).toBeNull(); // "not sure" is not shown
    expect(db.rpcs.length).toBe(0); // no photo fetched yet
    await userEvent.click(screen.getByRole('button', { name: 'Show the photo the guest sent' }));
    const img = (await screen.findByRole('img', {
      name: "The guest's hair photo",
    })) as HTMLImageElement;
    expect(img.src).toContain('data:image/jpeg;base64,QUJD');
    expect(db.rpcs[0]).toEqual({ fn: 'get_hair_photo', args: { p_appointment: 'a1' } });
  });

  it('says when there is no photo, and renders nothing when the guest made no request', async () => {
    const none = fakeDb({
      hair_requests: [{ style_id: null, answers: {}, photo_expires_at: null }],
    });
    wrap(<HairRequestPanel ctx={ctx(none.client)} appointmentId="a1" />);
    expect(await screen.findByText('The guest did not send a photo.')).toBeTruthy();
    cleanup();
    const { container } = wrap(
      <HairRequestPanel ctx={ctx(fakeDb({}).client)} appointmentId="a1" />,
    );
    await waitFor(() => expect(container.textContent).toBe(''));
  });
});
