import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StockItem } from '@bestie/core';
import { I18nProvider } from '@bestie/i18n';
import { CountSheet } from './CountSheet';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const items: StockItem[] = [
  {
    id: '1',
    name: { th: 'ข้าวสาร', en: 'Rice' },
    barcode: null,
    unit: 'g',
    quantity: 12500,
    costPer1000: 3200,
    lowAt: 5000,
    active: true,
  },
  {
    id: '2',
    name: { th: 'น้ำมัน', en: 'Oil' },
    barcode: 'OIL-0001',
    unit: 'ml',
    quantity: 800,
    costPer1000: 5000,
    lowAt: 1000,
    active: true,
  },
];
const mount = (list = items) =>
  render(
    <I18nProvider initialLang="en">
      <CountSheet items={list} shop="Acme Shop" />
    </I18nProvider>,
  );

describe('<CountSheet>', () => {
  it('builds a paper sheet with every item, what the system holds and empty boxes to write in', () => {
    mount();
    const paper = document.getElementById('print-root')!;
    const rows = [...paper.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('Oil'); // sorted by name
    expect(rows[0]!.textContent).toContain('OIL-0001');
    expect(rows[0]!.textContent).toContain('800 ml');
    expect(rows[1]!.textContent).toContain('12.5 kg');
    expect(paper.textContent).toContain('Acme Shop');
    expect(paper.querySelectorAll('thead th')).toHaveLength(6);
    expect(paper.querySelectorAll('td.write')).toHaveLength(4);
    expect(paper.querySelector('style')?.textContent).toContain('size: A4');
  });

  it('a blind count leaves the system quantity and the difference out', async () => {
    mount();
    await userEvent.click(screen.getByLabelText(/Hide the quantity in the system/));
    const paper = document.getElementById('print-root')!;
    expect(paper.querySelectorAll('thead th')).toHaveLength(4);
    expect(paper.textContent).not.toContain('12.5 kg');
    expect(paper.textContent).not.toContain('800 ml');
  });

  it('the button prints; with no items there is nothing to print', async () => {
    const print = vi.fn();
    vi.stubGlobal('print', print);
    mount();
    await userEvent.click(screen.getByRole('button', { name: 'Print the count sheet' }));
    expect(print).toHaveBeenCalledTimes(1);
    cleanup();
    mount([]);
    expect(screen.getByText('There are no stock items yet.')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Print the count sheet' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
