import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '@bestie/i18n';
import type { PageContext } from '@bestie/auth';
import { FeedbackPage } from './FeedbackPage';
import { ShopInfoPage } from './ShopInfoPage';
import { fakeDb } from './fakeDb';

afterEach(cleanup);
const ctx = (client: unknown, over: Partial<PageContext> = {}): PageContext => ({
  path: '/x',
  navigate: () => {},
  client: client as never,
  orgId: 'o1',
  storeId: 's1',
  permissions: ['menu.edit', 'report.view'],
  isOwner: false,
  isPlatformAdmin: false,
  ...over,
});
const mount = (ui: React.ReactNode) => render(<I18nProvider initialLang="en">{ui}</I18nProvider>);

describe('<ShopInfoPage>', () => {
  it('lists the cards and saves a new one through the database function (Thai required, English optional)', async () => {
    const db = fakeDb({
      shop_info: [
        { id: 'a', title: { th: 'ไวไฟ' }, body: { th: 'รหัส 1234' }, sort: 10, active: true },
      ],
    });
    mount(<ShopInfoPage ctx={ctx(db.client)} />);
    expect(await screen.findByText('ไวไฟ')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Add a card' }));
    const save = screen.getByRole('button', { name: 'Save card' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText('Title (Thai)'), 'เช็กเอาต์');
    await userEvent.type(screen.getByLabelText('Text (Thai)'), 'ก่อน 11:00');
    await userEvent.type(screen.getByLabelText('Text (English, optional)'), 'Before 11:00');
    await userEvent.click(save);
    await waitFor(() => expect(db.rpcs).toHaveLength(1));
    expect(db.rpcs[0]).toEqual({
      fn: 'save_shop_info',
      args: {
        p: {
          id: null,
          store_id: 's1',
          title: { th: 'เช็กเอาต์' },
          body: { th: 'ก่อน 11:00', en: 'Before 11:00' },
          sort: 100,
          active: true,
        },
      },
    });
  });
  it('deletes through the database function and is closed without menu.edit', async () => {
    const db = fakeDb({
      shop_info: [{ id: 'a', title: { th: 'ไวไฟ' }, body: { th: 'x' }, sort: 10, active: true }],
    });
    mount(<ShopInfoPage ctx={ctx(db.client)} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(db.rpcs[0]).toEqual({ fn: 'delete_shop_info', args: { p_id: 'a' } }),
    );
    cleanup();
    mount(<ShopInfoPage ctx={ctx(db.client, { permissions: [] })} />);
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});

describe('<FeedbackPage>', () => {
  const rows = [
    {
      id: '1',
      rating: 1,
      topic: 'service',
      comment: 'slow',
      handled: false,
      created_at: '2026-11-19T05:00:00Z',
      dining_tables: { name: 'T3' },
    },
    {
      id: '2',
      rating: 5,
      topic: 'food',
      comment: 'yum',
      handled: true,
      created_at: '2026-11-19T04:00:00Z',
      dining_tables: null,
    },
  ];
  it('shows the summary, filters to the open ones and marks one handled', async () => {
    const db = fakeDb({ guest_feedback: rows });
    mount(<FeedbackPage ctx={ctx(db.client)} />);
    expect(await screen.findByText('slow')).toBeTruthy();
    expect(screen.getByText(/2 items · average 3 · low ratings still open 1/)).toBeTruthy();
    expect(screen.getByText(/Table T3/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Only the ones not handled'));
    expect(screen.queryByText('yum')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Mark handled' }));
    await waitFor(() =>
      expect(db.rpcs[0]).toEqual({ fn: 'handle_feedback', args: { p_id: '1', p_handled: true } }),
    );
  });
  it('is closed without report.view', () => {
    mount(<FeedbackPage ctx={ctx(fakeDb({}).client, { permissions: [] })} />);
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});
