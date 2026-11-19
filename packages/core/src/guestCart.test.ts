import { describe, expect, it } from 'vitest';
import {
  addToGuestCart,
  cartCount,
  cartTotal,
  groupsOf,
  orderPayload,
  parseGuestBill,
  parseGuestMenu,
  guestSelectionProblem,
  packCart,
  restoreCart,
  CART_KEEP_MS,
  setCartQuantity,
  statusStep,
  unitPrice,
} from './guestCart';

const menu = parseGuestMenu({
  categories: [{ id: 'c1', name: { th: 'จาน', en: 'Mains' } }],
  items: [
    {
      id: 'i1',
      category_id: 'c1',
      name: { th: 'ผัดไทย', en: 'Pad Thai' },
      price: 18000,
      group_ids: ['g1', 'gx'],
    },
    { id: 'i2', category_id: 'c1', name: { th: 'น้ำ' }, price: 2000, group_ids: [] },
  ],
  groups: [
    {
      id: 'g1',
      name: { th: 'เผ็ด', en: 'Spice' },
      min: 1,
      max: 1,
      options: [
        { id: 'o1', name: { th: 'น้อย', en: 'Mild' }, delta: 0 },
        { id: 'o2', name: { th: 'มาก', en: 'Hot' }, delta: 500 },
      ],
    },
  ],
});

describe('parseGuestMenu / parseGuestBill', () => {
  it('reads the server answer and survives junk', () => {
    expect(menu.items).toHaveLength(2);
    expect(menu.items[0]!.groupIds).toEqual(['g1', 'gx']);
    expect(parseGuestMenu(null).items).toEqual([]);
    expect(
      parseGuestBill({
        order_id: 'x',
        lines: [{ name: { th: 'ก' }, quantity: 2, status: 'sent', amount: 100 }],
      }).lines[0]!.quantity,
    ).toBe(2);
    expect(parseGuestBill('nope').orderId).toBeNull();
  });
});

describe('option rules and price', () => {
  const item = menu.items[0]!;
  const groups = groupsOf(menu, item);
  it('drops unknown group ids', () => expect(groups.map((g) => g.id)).toEqual(['g1']));
  it('requires the minimum and refuses too many', () => {
    expect(guestSelectionProblem(groups, [])).toEqual({ groupId: 'g1', kind: 'min' });
    expect(guestSelectionProblem(groups, ['o1'])).toBeNull();
    expect(guestSelectionProblem(groups, ['o1', 'o2'])).toEqual({ groupId: 'g1', kind: 'max' });
  });
  it('adds option deltas to the dish price', () => {
    expect(unitPrice(item, groups, ['o2'])).toBe(18500);
    expect(unitPrice(item, groups, [])).toBe(18000);
  });
});

describe('cart', () => {
  it('merges the same dish with the same options, keeps different ones apart', () => {
    let cart = addToGuestCart([], { itemId: 'i1', quantity: 1, optionIds: ['o2'], note: '' }, 'a');
    cart = addToGuestCart(cart, { itemId: 'i1', quantity: 2, optionIds: ['o2'], note: '' }, 'b');
    expect(cart).toHaveLength(1);
    expect(cart[0]!.quantity).toBe(3);
    cart = addToGuestCart(cart, { itemId: 'i1', quantity: 1, optionIds: ['o1'], note: '' }, 'c');
    cart = addToGuestCart(
      cart,
      { itemId: 'i1', quantity: 1, optionIds: ['o2'], note: 'no nuts' },
      'd',
    );
    expect(cart).toHaveLength(3);
  });
  it('caps the quantity and the number of lines', () => {
    let cart = addToGuestCart([], { itemId: 'i2', quantity: 98, optionIds: [], note: '' }, 'a');
    cart = addToGuestCart(cart, { itemId: 'i2', quantity: 5, optionIds: [], note: '' }, 'b');
    expect(cart[0]!.quantity).toBe(99);
    let big = [] as ReturnType<typeof addToGuestCart>;
    for (let i = 0; i < 40; i++)
      big = addToGuestCart(
        big,
        { itemId: 'i2', quantity: 1, optionIds: [], note: `n${i}` },
        `k${i}`,
      );
    expect(big).toHaveLength(30);
  });
  it('changes and removes quantities', () => {
    const cart = addToGuestCart([], { itemId: 'i2', quantity: 1, optionIds: [], note: '' }, 'a');
    expect(setCartQuantity(cart, 'a', 4)[0]!.quantity).toBe(4);
    expect(setCartQuantity(cart, 'a', 0)).toEqual([]);
  });
  it('totals the cart for display', () => {
    let cart = addToGuestCart([], { itemId: 'i1', quantity: 2, optionIds: ['o2'], note: '' }, 'a');
    cart = addToGuestCart(cart, { itemId: 'i2', quantity: 1, optionIds: [], note: '' }, 'b');
    expect(cartTotal(menu, cart)).toBe(2 * 18500 + 2000);
    expect(cartCount(cart)).toBe(3);
  });
  it('sends ids, quantities and options only — never a price', () => {
    const cart = addToGuestCart(
      [],
      { itemId: 'i1', quantity: 1, optionIds: ['o1'], note: '  less oil  ' },
      'a',
    );
    const body = orderPayload('tok', 'cid', cart);
    expect(body.lines[0]).toEqual({
      item_id: 'i1',
      quantity: 1,
      option_ids: ['o1'],
      note: 'less oil',
    });
    expect(JSON.stringify(body)).not.toMatch(/price|amount|total/i);
  });
});

describe('statusStep', () => {
  it("speaks the guest's language", () => {
    expect(['new', 'sent', 'ready', 'served'].map(statusStep)).toEqual([
      'received',
      'cooking',
      'ready',
      'served',
    ]);
  });
});

describe('the basket kept on the guest’s phone', () => {
  const now = Date.parse('2026-11-19T06:00:00Z');
  const line = {
    key: 'k1',
    itemId: 'i1',
    quantity: 2,
    optionIds: [] as string[],
    note: 'no chilli',
  };
  it('round-trips a basket and drops what the menu no longer allows', () => {
    const lines = menu.items[0] ? [line] : [];
    expect(restoreCart(packCart(lines, now), menu, now + 1000)).toEqual(
      lines.filter((l) => !guestSelectionProblem(groupsOf(menu, menu.items[0]!), l.optionIds)),
    );
    expect(restoreCart(packCart([{ ...line, itemId: 'gone' }], now), menu, now)).toEqual([]);
    expect(restoreCart(packCart([{ ...line, optionIds: ['nope'] }], now), menu, now)).toEqual([]);
    expect(restoreCart(packCart([{ ...line, quantity: 500 }], now), menu, now)).toEqual([]);
    expect(restoreCart(packCart([{ ...line, quantity: 0 }], now), menu, now)).toEqual([]);
  });
  it('forgets a basket after 12 hours, and anything damaged', () => {
    expect(restoreCart(packCart([line], now), menu, now + CART_KEEP_MS + 1)).toEqual([]);
    expect(restoreCart('not json', menu, now)).toEqual([]);
    expect(restoreCart(null, menu, now)).toEqual([]);
    expect(restoreCart('{"at":"x","lines":[]}', menu, now)).toEqual([]);
    expect(restoreCart(JSON.stringify({ at: now + 3_600_000, lines: [line] }), menu, now)).toEqual(
      [],
    ); // from the future
  });
});

describe('the picture of a dish', () => {
  const m = parseGuestMenu({
    items: [
      { id: 'a', name: { th: 'ก' }, price: 100, image_v: 3 },
      { id: 'b', name: { th: 'ข' }, price: 100 },
      { id: 'c', name: { th: 'ค' }, price: 100, image_v: 0 },
      { id: 'd', name: { th: 'ง' }, price: 100, image_v: 'x' },
    ],
  });
  it('is its version, or null when there is none or the value is not a positive number', () => {
    expect(m.items.map((i) => i.imageV)).toEqual([3, null, null, null]);
  });
});
