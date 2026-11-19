import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageContext } from '@bestie/auth';
import { I18nProvider } from '@bestie/i18n';
import { fakeDb } from './fakeDb';
import { LabelsPage } from './LabelsPage';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const item = (id: string, en: string, base: number, barcode: string | null) => ({
  id,
  category_id: 'c1',
  name: { th: en, en },
  prices: { base },
  station: null,
  modifier_group_ids: [],
  available: true,
  barcode,
  sku: null,
  sort: 10,
  created_at: '1',
});
const tables = () => ({
  stores: [{ id: 's1', name: 'Acme Shop' }],
  menu_categories: [{ id: 'c1', name: { th: 'x' }, sort: 1, active: true, created_at: '1' }],
  menu_items: [
    item('i1', 'Herbal shampoo', 45000, 'SHAM-0250'),
    item('i2', 'Hair serum', 69000, 'SERUM-0050'),
    item('i3', 'Gift voucher', 100000, null),
  ],
  modifier_groups: [],
  modifier_options: [],
});
const ctx = (client: unknown, over: Partial<PageContext> = {}): PageContext => ({
  path: '/labels',
  navigate: () => {},
  client: client as never,
  orgId: 'o1',
  storeId: 's1',
  permissions: ['menu.edit'],
  isOwner: false,
  isPlatformAdmin: false,
  ...over,
});
const mount = (c: PageContext) =>
  render(
    <I18nProvider initialLang="en">
      <LabelsPage ctx={c} />
    </I18nProvider>,
  );
const copies = (name: string) =>
  screen.getByLabelText(`Number of labels for ${name}`) as HTMLInputElement;

describe('<LabelsPage>', () => {
  it('lists the items with price and barcode, and prints nothing until a number is entered', async () => {
    mount(ctx(fakeDb(tables()).client));
    expect(await screen.findByText('Herbal shampoo')).toBeTruthy();
    expect(screen.getByText('SHAM-0250')).toBeTruthy();
    expect(screen.getByText('no barcode')).toBeTruthy();
    expect(screen.getByText(/Enter a number of labels/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Print 0 labels' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(document.getElementById('print-root')).toBeNull(); // no paper content yet
  });

  it('copies make labels: the preview, the count, and a print-only sheet with the barcode drawn', async () => {
    mount(ctx(fakeDb(tables()).client));
    await screen.findByText('Herbal shampoo');
    fireEvent.change(copies('Herbal shampoo'), { target: { value: '3' } });
    fireEvent.change(copies('Gift voucher'), { target: { value: '1' } });
    expect(await screen.findByText(/4 labels in all/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Print 4 labels' })).toBeTruthy();
    const paper = document.getElementById('print-root')!;
    expect(paper.querySelectorAll('.price-label')).toHaveLength(4);
    expect(paper.querySelectorAll('svg.barcode-svg')).toHaveLength(3); // the voucher has no barcode: name and price only
    expect(paper.textContent).toContain('฿450');
    expect(paper.textContent).toContain('SHAM-0250');
    expect(paper.querySelector('style')?.textContent).toContain('size: A4');
  });

  it('a roll size sets the page to one label', async () => {
    mount(ctx(fakeDb(tables()).client));
    await screen.findByText('Herbal shampoo');
    fireEvent.change(copies('Hair serum'), { target: { value: '2' } });
    await userEvent.selectOptions(screen.getByLabelText('Label size'), 'roll-50x30');
    await waitFor(() =>
      expect(document.getElementById('print-root')!.querySelector('style')?.textContent).toContain(
        'size: 50mm 30mm',
      ),
    );
  });

  it('"only items with a barcode" and "clear" set the copies', async () => {
    mount(ctx(fakeDb(tables()).client));
    await screen.findByText('Herbal shampoo');
    await userEvent.click(screen.getByRole('button', { name: 'Select only items with a barcode' }));
    expect(copies('Herbal shampoo').value).toBe('1');
    expect(copies('Gift voucher').value).toBe('0');
    await userEvent.click(screen.getByRole('button', { name: 'Select every item (1 label)' }));
    expect(copies('Gift voucher').value).toBe('1');
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(copies('Herbal shampoo').value).toBe('0');
  });

  it('the print button opens the browser print dialog', async () => {
    const print = vi.fn();
    vi.stubGlobal('print', print);
    mount(ctx(fakeDb(tables()).client));
    await screen.findByText('Herbal shampoo');
    fireEvent.change(copies('Hair serum'), { target: { value: '1' } });
    await userEvent.click(await screen.findByRole('button', { name: 'Print 1 labels' }));
    expect(print).toHaveBeenCalledTimes(1);
  });

  it('is only for people who can edit the menu', () => {
    mount(ctx(fakeDb(tables()).client, { permissions: [] }));
    expect(screen.getByText(/permission/i)).toBeTruthy();
    expect(screen.queryByText('Herbal shampoo')).toBeNull();
  });
});
