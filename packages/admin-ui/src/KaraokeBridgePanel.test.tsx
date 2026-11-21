import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { PageContext } from '@bestie/auth';
import { I18nProvider } from '@bestie/i18n';
import { fakeDb } from './fakeDb';
import { KaraokeBridgePanel } from './KaraokeBridgePanel';

afterEach(cleanup);
const ctx = (client: unknown): PageContext => ({
  path: '/karaoke',
  navigate: () => {},
  client: client as never,
  orgId: 'o1',
  storeId: 's1',
  permissions: ['menu.edit'],
  isOwner: true,
  isPlatformAdmin: false,
});
const wrap = (ui: React.ReactNode) => render(<I18nProvider initialLang="en">{ui}</I18nProvider>);

describe('<KaraokeBridgePanel>', () => {
  it('makes a key and shows it once', async () => {
    const key = 'b'.repeat(64);
    const db = fakeDb(
      {},
      {
        rpc: {
          karaoke_bridge_status: {
            data: [{ room_id: 'r1', on: false, hint: null, seen_at: null }],
          },
          rotate_karaoke_bridge: { data: key },
        },
      },
    );
    wrap(<KaraokeBridgePanel ctx={ctx(db.client)} storeId="s1" roomId="r1" />);
    expect(
      await screen.findByText('The song bridge of this room is not switched on.'),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Make a song bridge key' }));
    expect(await screen.findByText(key)).toBeTruthy();
    expect(
      db.rpcs.some(
        (c) => c.fn === 'rotate_karaoke_bridge' && (c.args as { p_room: string }).p_room === 'r1',
      ),
    ).toBe(true);
  });
  it('shows when it was last seen and switches it off', async () => {
    const db = fakeDb(
      {},
      {
        rpc: {
          karaoke_bridge_status: {
            data: [{ room_id: 'r1', on: true, hint: 'ab12', seen_at: '2026-11-21T10:00:00Z' }],
          },
        },
      },
    );
    wrap(<KaraokeBridgePanel ctx={ctx(db.client)} storeId="s1" roomId="r1" />);
    expect(await screen.findByText(/key ends …ab12/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Switch the song bridge off' }));
    await waitFor(() => expect(db.rpcs.some((c) => c.fn === 'revoke_karaoke_bridge')).toBe(true));
  });
});
