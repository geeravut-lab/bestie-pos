import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QrSvg, TableQr, tableLink } from './TableQr';
import { mountEn, pageCtx } from './testKit';

afterEach(cleanup);

const TABLE = { id: 't1', name: 'T1', zone: 'Indoor', seats: 2, sort: 1 };
const TOKEN = 'a'.repeat(32);

function client(
  opts: { rotate?: { data?: unknown; error?: { code: string } | null }; token?: unknown } = {},
) {
  const rpc = vi.fn(async () => opts.rotate ?? { data: 'b'.repeat(32), error: null });
  const from = vi.fn(() => {
    const c: Record<string, unknown> = {};
    c.select = () => c;
    c.eq = () => c;
    c.maybeSingle = async () => ({ data: { qr_token: opts.token ?? TOKEN }, error: null });
    return c;
  });
  return { client: { from, rpc } as never, rpc };
}

describe('tableLink / QrSvg', () => {
  it('links to /t/<token> and nothing else', () => {
    expect(tableLink('https://bestie-pos.vercel.app', TOKEN)).toBe(
      `https://bestie-pos.vercel.app/t/${TOKEN}`,
    );
  });
  it('draws a QR with an accessible name and no raw colours', () => {
    mountEn(<QrSvg value="https://x.test/t/abc" label="QR for T1" />);
    const svg = screen.getByRole('img', { name: 'QR for T1' });
    expect(svg.querySelector('path')?.getAttribute('d')?.length ?? 0).toBeGreaterThan(50);
    expect(svg.outerHTML).not.toMatch(/#[0-9a-f]{3,6}|rgb\(/i);
  });
});

describe('<TableQr>', () => {
  it('shows the table’s own QR link after the code is fetched', async () => {
    const { client: c } = client();
    mountEn(<TableQr ctx={pageCtx(c)} table={TABLE} />);
    await userEvent.click(screen.getByRole('button', { name: 'Ordering QR' }));
    expect(await screen.findByText(`${window.location.origin}/t/${TOKEN}`)).toBeTruthy();
    expect(screen.getByRole('img', { name: 'QR for table T1' })).toBeTruthy();
  });

  it('creating a new code replaces the link and says the old one is dead', async () => {
    const { client: c, rpc } = client();
    mountEn(<TableQr ctx={pageCtx(c)} table={TABLE} />);
    await userEvent.click(screen.getByRole('button', { name: 'Ordering QR' }));
    await screen.findByText(`${window.location.origin}/t/${TOKEN}`);
    await userEvent.click(screen.getByRole('button', { name: 'Create a new code' }));
    expect(await screen.findByText(`${window.location.origin}/t/${'b'.repeat(32)}`)).toBeTruthy();
    expect(screen.getByText(/old one no longer works/)).toBeTruthy();
    expect(rpc).toHaveBeenCalledWith('rotate_table_qr', { p_table: 't1' });
  });

  it('a refused rotation shows an error and keeps the old link', async () => {
    const { client: c } = client({ rotate: { data: null, error: { code: '42501' } } });
    mountEn(<TableQr ctx={pageCtx(c)} table={TABLE} />);
    await userEvent.click(screen.getByRole('button', { name: 'Ordering QR' }));
    await screen.findByText(`${window.location.origin}/t/${TOKEN}`);
    await userEvent.click(screen.getByRole('button', { name: 'Create a new code' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByText(`${window.location.origin}/t/${TOKEN}`)).toBeTruthy();
  });
});
