import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addLine, newOrder, parsePromotions, parseUpsellRules } from '@bestie/core';
import type { OrderDoc } from '@bestie/core';
import { I18nProvider } from '@bestie/i18n';
import { OrderPromo } from './OrderPromo';

afterEach(cleanup);

const item = (id: string, name: string, price: number, available = true) => ({
  id,
  category_id: 'c',
  name: { th: name, en: name },
  prices: { base: price },
  station: null,
  duration_min: null,
  modifier_group_ids: [],
  available,
  food: {},
  sort: 0,
});
const menu = {
  cats: [],
  items: [
    item('pad', 'Pad Thai', 10000),
    item('tea', 'Tea', 3000),
    item('beer', 'Beer', 6000, false),
  ],
  groups: [],
  options: [],
} as never;
const order = (): OrderDoc => {
  const o = newOrder({
    id: 'o',
    orgId: 'org',
    storeId: 's',
    number: 'A001',
    channel: 'takeaway',
    now: Date.now(),
  });
  return addLine(o, {
    lineId: 'l1',
    item: { id: 'pad', name: { th: 'Pad Thai' }, prices: { base: 10000 }, station: null },
    groups: [],
    selected: [],
    quantity: 2,
  });
};
const everyDay = { id: 'p1', name: 'Ten off', kind: 'percent', value: 1000, scope: 'bill' };
const coded = { id: 'p2', name: 'VIP', code: 'VIP', kind: 'percent', value: 5000, scope: 'bill' };

describe('<OrderPromo>', () => {
  it('applies a running promotion to the unsent lines and says what the customer saves', async () => {
    const apply = vi.fn(async () => {});
    render(
      <I18nProvider initialLang="en">
        <OrderPromo
          order={order()}
          menu={menu}
          extras={{ promos: parsePromotions([everyDay]), rules: [] }}
          apply={apply}
          onAdd={() => {}}
        />
      </I18nProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Use this promotion: Ten off' }));
    expect(apply).toHaveBeenCalledTimes(1);
    const fn = (apply.mock.calls as unknown as [(o: OrderDoc) => OrderDoc][])[0]![0];
    const out = fn(order());
    expect(out.lines[0]).toMatchObject({ unitPrice: 9000, listPrice: 10000, promoId: 'p1' });
    expect(await screen.findByText('Saves the customer ฿20')).toBeTruthy();
  });

  it('a code promotion appears only after its code is typed', async () => {
    render(
      <I18nProvider initialLang="en">
        <OrderPromo
          order={order()}
          menu={menu}
          extras={{ promos: parsePromotions([coded]), rules: [] }}
          apply={async () => {}}
          onAdd={() => {}}
        />
      </I18nProvider>,
    );
    expect(screen.queryByRole('button', { name: /VIP/ })).toBeNull();
    await userEvent.type(screen.getByLabelText('Type a promotion code'), 'vip');
    expect(screen.getByRole('button', { name: 'Use this promotion: VIP' })).toBeTruthy();
  });

  it('offers the suggested dishes that are on sale and adds one with a tap', async () => {
    const onAdd = vi.fn();
    const rules = parseUpsellRules([
      { id: 'r1', item_id: 'pad', suggest_id: 'tea', sort: 0 },
      { id: 'r2', item_id: 'pad', suggest_id: 'beer', sort: 1 },
    ]);
    render(
      <I18nProvider initialLang="en">
        <OrderPromo
          order={order()}
          menu={menu}
          extras={{ promos: [], rules }}
          apply={async () => {}}
          onAdd={onAdd}
        />
      </I18nProvider>,
    );
    expect(screen.queryByText('+ Beer')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '+ Tea' }));
    await waitFor(() => expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ id: 'tea' })));
  });

  it('shows nothing when there is nothing to offer', () => {
    const { container } = render(
      <I18nProvider initialLang="en">
        <OrderPromo
          order={order()}
          menu={menu}
          extras={{ promos: [], rules: [] }}
          apply={async () => {}}
          onAdd={() => {}}
        />
      </I18nProvider>,
    );
    expect(container.textContent).toBe('');
  });
});
