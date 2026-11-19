import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mountEn, pageCtx } from '../testKit';
import { PrintersPage } from './PrintersPage';

beforeEach(() => globalThis.localStorage?.clear());
afterEach(cleanup);

function client(row: { printers: unknown; default_printer: string | null }) {
  const updates: Record<string, unknown>[] = [];
  const from = () => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.maybeSingle = async () => ({ data: row, error: null });
    chain.update = (v: Record<string, unknown>) => {
      updates.push(v);
      return { eq: () => ({ select: async () => ({ data: [{ id: 'x' }], error: null }) }) };
    };
    return chain;
  };
  return { updates, client: { from } };
}

describe('<PrintersPage>', () => {
  it('with no printer set up the PDF is the shop default and this tablet uses it', async () => {
    const c = client({ printers: [], default_printer: null });
    mountEn(<PrintersPage ctx={pageCtx(c.client, { isOwner: true })} />);
    expect(await screen.findByText('Save as a PDF file')).toBeTruthy();
    expect(screen.getByText('Shop default')).toBeTruthy();
    expect(screen.getByText('This tablet uses it')).toBeTruthy();
  });

  it('the owner adds a network printer and it is saved as data', async () => {
    const c = client({ printers: [], default_printer: null });
    mountEn(<PrintersPage ctx={pageCtx(c.client, { isOwner: true })} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Add a printer' }));
    await userEvent.type(screen.getByLabelText('Printer name'), 'Kitchen');
    await userEvent.selectOptions(screen.getByLabelText('How it connects'), 'network');
    await userEvent.type(screen.getByLabelText(/Bridge address/), 'http://192.168.1.20:9101');
    await userEvent.click(screen.getByRole('button', { name: 'Save printer' }));
    await waitFor(() => expect(c.updates.length).toBe(1));
    expect(c.updates[0]!.printers).toEqual([
      expect.objectContaining({
        name: 'Kitchen',
        kind: 'network',
        bridge_url: 'http://192.168.1.20:9101',
      }),
    ]);
  });

  it('an invalid printer (network without an address) is refused before saving', async () => {
    const c = client({ printers: [], default_printer: null });
    mountEn(<PrintersPage ctx={pageCtx(c.client, { isOwner: true })} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Add a printer' }));
    await userEvent.type(screen.getByLabelText('Printer name'), 'Kitchen');
    await userEvent.selectOptions(screen.getByLabelText('How it connects'), 'network');
    await userEvent.click(screen.getByRole('button', { name: 'Save printer' }));
    expect(
      await screen.findByText(/./, { selector: '[role="alert"], .notice-error' }),
    ).toBeTruthy();
    expect(c.updates.length).toBe(0);
  });

  it('a cashier cannot add printers or change the shop default, but can pick one for this tablet', async () => {
    const c = client({
      printers: [{ id: 'bar', name: 'Bar', kind: 'usb', paperMm: 80, cutter: true, drawer: false }],
      default_printer: null,
    });
    mountEn(<PrintersPage ctx={pageCtx(c.client, { permissions: ['payment.take'] })} />);
    expect(await screen.findByText('Bar')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add a printer' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Make it the shop default' })).toBeNull();
    await userEvent.click(
      screen.getAllByRole('button', { name: 'Use this one on this tablet' })[0]!,
    );
    await waitFor(() =>
      expect(globalThis.localStorage.getItem('bestie-printer-choice:store-1')).not.toBeNull(),
    );
  });
});
