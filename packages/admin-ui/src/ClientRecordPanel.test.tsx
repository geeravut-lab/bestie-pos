import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { PageContext } from '@bestie/auth';
import { I18nProvider } from '@bestie/i18n';
import { ClientRecordPanel } from './ClientRecordPanel';
import { fakeDb } from './fakeDb';

afterEach(cleanup);

const tables = (extra: Record<string, unknown[]> = {}) => ({
  client_notes: [
    {
      id: 'n1',
      kind: 'formula',
      title: 'Colour',
      body: '6.1 + 7.0, 20 vol',
      created_at: '2026-11-01T05:00:00Z',
    },
  ],
  health_intakes: [
    {
      id: 'h1',
      answers: { pregnant: true, allergies: 'nuts', secret: 'x' },
      signed_name: 'Mali Sue',
      signed_at: '2026-11-02T05:00:00Z',
    },
  ],
  ...extra,
});
const ctx = (client: unknown, over: Partial<PageContext> = {}): PageContext => ({
  path: '/customers',
  navigate: () => {},
  client: client as never,
  orgId: 'o1',
  storeId: 's1',
  permissions: ['order.create', 'customer.view'],
  isOwner: false,
  isPlatformAdmin: false,
  isModuleOn: () => true,
  ...over,
});
const mount = (c: PageContext) =>
  render(
    <I18nProvider initialLang="en">
      <ClientRecordPanel ctx={c} customerId="c1" />
    </I18nProvider>,
  );

describe('<ClientRecordPanel>', () => {
  it('shows the notes and the latest signed health form, highlighting the "yes" answers', async () => {
    mount(ctx(fakeDb(tables()).client));
    expect(await screen.findByText('6.1 + 7.0, 20 vol')).toBeTruthy();
    expect(screen.getByText(/Signed by Mali Sue/)).toBeTruthy();
    expect(screen.getByText('Pregnant:')).toBeTruthy();
    expect(screen.getByText('nuts')).toBeTruthy();
    expect(screen.queryByText('x')).toBeNull(); // an answer outside the closed set is never shown
  });

  it('is hidden where the appointments module is off', () => {
    const { container } = mount(ctx(fakeDb(tables()).client, { isModuleOn: () => false }));
    expect(container.textContent).toBe('');
  });

  it('adds a note through the database function', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client));
    await screen.findByText('Colour');
    await userEvent.type(screen.getByLabelText('Title'), 'Balayage');
    await userEvent.type(screen.getByLabelText('Details'), 'lightener 30 min');
    await userEvent.click(screen.getByRole('button', { name: 'Add the note' }));
    await waitFor(() => expect(db.rpcs.some((r) => r.fn === 'add_client_note')).toBe(true));
    expect(
      (db.rpcs.find((r) => r.fn === 'add_client_note')!.args as { p: Record<string, string> }).p,
    ).toMatchObject({
      store_id: 's1',
      customer_id: 'c1',
      kind: 'formula',
      title: 'Balayage',
    });
  });

  it('will not save the health form without the consent tick and a typed name', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client));
    await screen.findByText('Colour');
    await userEvent.click(screen.getByRole('button', { name: 'Fill in a new form' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save the form with the signature' }));
    expect(await screen.findByText(/must agree/)).toBeTruthy();
    expect(db.rpcs.length).toBe(0);
    await userEvent.click(screen.getByLabelText('High blood pressure'));
    await userEvent.click(screen.getByLabelText(/give explicit consent for the shop to keep/));
    await userEvent.type(screen.getByLabelText('Signature (type the full name)'), 'Mali Sue');
    await userEvent.click(screen.getByRole('button', { name: 'Save the form with the signature' }));
    await waitFor(() => expect(db.rpcs.some((r) => r.fn === 'save_health_intake')).toBe(true));
    const p = (
      db.rpcs.find((r) => r.fn === 'save_health_intake')!.args as { p: Record<string, unknown> }
    ).p;
    expect(p).toMatchObject({ consent: true, signed_name: 'Mali Sue', answers: { high_bp: true } });
  });

  it('only a manager sees the erase buttons', async () => {
    mount(ctx(fakeDb(tables()).client));
    await screen.findByText('Colour');
    expect(screen.queryByRole('button', { name: 'Erase' })).toBeNull();
    cleanup();
    mount(ctx(fakeDb(tables()).client, { permissions: ['order.create', 'staff.manage'] }));
    await screen.findByText('Colour');
    expect(screen.getAllByRole('button', { name: 'Erase' }).length).toBe(2);
  });
});

describe('<ClientRecordPanel> photos', () => {
  const photoTables = () =>
    tables({
      client_photos: [
        {
          id: 'p1',
          kind: 'before',
          note: 'roots',
          created_at: '2026-11-01T05:00:00Z',
          expires_at: '2027-11-01T05:00:00Z',
        },
        {
          id: 'p2',
          kind: 'after',
          note: null,
          created_at: '2026-11-01T07:00:00Z',
          expires_at: '2027-11-01T07:00:00Z',
        },
      ],
    });

  it('lists before / after photos and loads a picture only when asked', async () => {
    const db = fakeDb(photoTables(), {
      rpc: { get_client_photo: { data: { mime: 'image/jpeg', data: 'QUJD' } } },
    });
    mount(ctx(db.client));
    await screen.findByText('roots');
    expect(db.rpcs.length).toBe(0);
    await userEvent.click(screen.getByRole('button', { name: 'Compare before / after' }));
    await waitFor(() => expect(db.rpcs.filter((r) => r.fn === 'get_client_photo').length).toBe(2));
    expect((await screen.findAllByRole('img', { name: 'Client photo' })).length).toBe(2);
  });

  it('a photo cannot be added without the consent tick and a file', async () => {
    const db = fakeDb(photoTables());
    mount(ctx(db.client));
    await screen.findByText('roots');
    expect(
      (screen.getByLabelText('Choose a photo (JPG / PNG / WebP)') as HTMLInputElement).disabled,
    ).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Add the photo' }));
    expect(await screen.findByText(/Tick the consent box/)).toBeTruthy();
    expect(db.rpcs.length).toBe(0);
  });

  it('only a manager can erase a photo', async () => {
    const db = fakeDb(photoTables());
    mount(ctx(db.client, { permissions: ['order.create', 'staff.manage'] }));
    await screen.findByText('roots');
    await userEvent.click(screen.getAllByRole('button', { name: 'Erase' }).at(-1)!);
    await waitFor(() => expect(db.rpcs.some((r) => r.fn === 'delete_client_photo')).toBe(true));
  });
});
