import { describe, expect, it } from 'vitest';
import {
  DIET_TAGS,
  EMPTY_FILTER,
  applyFilter,
  foodProblems,
  parseFilter,
  parseFood,
} from './dietary';
import type { DietFilter, DietTag, FilterItem, ItemFood, SpiceLevel } from './dietary';

const food = (tags: DietTag[], o: Partial<ItemFood> = {}): ItemFood => ({
  tags,
  spice: null,
  verified: true,
  highlight: false,
  ...o,
});
const item = (id: string, f: ItemFood, price = 10000, name = id): FilterItem => ({
  id,
  name: { th: name },
  price,
  food: f,
});
const f = (o: Partial<DietFilter>): DietFilter => ({ ...EMPTY_FILTER, ...o });

describe('applyFilter — "unknown is not safe"', () => {
  const menu = [
    item('padthai', food(['contains_egg', 'contains_peanut', 'contains_shellfish'], { spice: 1 })),
    item('moo', food(['contains_pork'], { spice: 2 })),
    item('salad', food([], { spice: 0 })),
    item('newdish', food([], { verified: false })),
    item('pork-unchecked', food(['contains_pork'], { verified: false })),
  ];
  it('no pork: shows verified pork-free dishes, parks unchecked ones, hides every dish that carries pork', () => {
    const r = applyFilter(menu, f({ exclude: ['contains_pork'] }));
    expect(r.ok).toEqual(['padthai', 'salad']);
    expect(r.unverified).toEqual(['newdish']);
    expect(r.hidden).toBe(2);
  });
  it('a dish tagged with an excluded ingredient is hidden even when the shop has not verified it', () => {
    const r = applyFilter(menu, f({ exclude: ['contains_pork'] }));
    expect([...r.ok, ...r.unverified]).not.toContain('pork-unchecked');
  });
  it('no filter at all: everything is listed, highlights first', () => {
    const m = [item('a', food([])), item('b', food([], { highlight: true })), item('c', food([]))];
    expect(applyFilter(m, EMPTY_FILTER).ok).toEqual(['b', 'a', 'c']);
  });
  it('not spicy: spice 0 is fine, unknown spice is NOT, higher is hidden', () => {
    const m = [
      item('mild', food([], { spice: 0 })),
      item('hot', food([], { spice: 3 })),
      item('unknown', food([], { spice: null })),
    ];
    const r = applyFilter(m, f({ maxSpice: 0 }));
    expect(r.ok).toEqual(['mild']);
    expect(r.unverified).toEqual(['unknown']);
    expect(r.hidden).toBe(1);
  });
  it('vegetarian requires the tag; vegan also hides egg and dairy; meat tags are hidden whatever the shop ticked', () => {
    const m = [
      item('tofu', food(['vegetarian', 'vegan', 'contains_soy'])),
      item('omelette', food(['vegetarian', 'contains_egg'])),
      item('plain', food([])),
      item('liar', food(['vegetarian', 'contains_pork'])),
    ];
    expect(applyFilter(m, f({ require: ['vegetarian'] })).ok).toEqual(['tofu', 'omelette']);
    expect(applyFilter(m, f({ require: ['vegan'] })).ok).toEqual(['tofu']);
    expect(applyFilter(m, f({ require: ['vegetarian'] })).ok).not.toContain('liar');
  });
  it('budget and keywords narrow the list; a budget never rescues a forbidden dish', () => {
    const m = [
      item('cheap-pork', food(['contains_pork']), 5000, 'หมูทอด'),
      item('dear', food([]), 40000, 'steak'),
      item('ok', food([]), 9000, 'Green curry'),
    ];
    expect(applyFilter(m, f({ maxPrice: 25000 })).ok).toEqual(['cheap-pork', 'ok']);
    expect(applyFilter(m, f({ maxPrice: 25000, exclude: ['contains_pork'] })).ok).toEqual(['ok']);
    expect(applyFilter(m, f({ keywords: ['curry'] })).ok).toEqual(['ok']);
  });

  it('GOLDEN: over thousands of random menus no excluded ingredient ever reaches the guest (recall = 100 %)', () => {
    let seed = 42;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    for (let round = 0; round < 400; round++) {
      const items: FilterItem[] = Array.from({ length: 25 }, (_, i) =>
        item(
          `i${i}`,
          food(
            DIET_TAGS.filter(() => rnd() < 0.2),
            {
              verified: rnd() < 0.6,
              spice: ([0, 1, 2, 3, null] as (SpiceLevel | null)[])[Math.floor(rnd() * 5)] ?? null,
            },
          ),
          Math.floor(rnd() * 50000) + 1000,
        ),
      );
      const exclude = DIET_TAGS.filter((t) => t.startsWith('contains_') && rnd() < 0.3);
      const maxSpice = rnd() < 0.5 ? 0 : null;
      const r = applyFilter(items, f({ exclude, maxSpice }));
      for (const id of [...r.ok, ...r.unverified]) {
        const it = items.find((x) => x.id === id)!;
        expect(it.food.tags.filter((t) => exclude.includes(t))).toEqual([]);
      }
      if (exclude.length > 0 || maxSpice !== null)
        for (const id of r.ok) expect(items.find((x) => x.id === id)!.food.verified).toBe(true);
    }
  });
});

describe('parseFilter (what a model returned)', () => {
  it('keeps known tags only and range-checks numbers', () => {
    expect(
      parseFilter({
        exclude: ['contains_pork', 'contains_unicorn', 7],
        require: ['halal'],
        max_spice: 0,
        max_price: 25000,
        keywords: [
          ' curry ',
          'x',
          'a very long keyword that is cut at thirty characters!!',
          'b1',
          'c2',
        ],
      }),
    ).toEqual({
      exclude: ['contains_pork'],
      require: ['halal'],
      maxSpice: 0,
      maxPrice: 25000,
      keywords: ['curry', 'a very long keyword that is cu', 'b1'],
    });
  });
  it('refuses nonsense and neutralises bad numbers', () => {
    expect(parseFilter(null)).toBeNull();
    expect(parseFilter([])).toBeNull();
    expect(parseFilter('x')).toBeNull();
    expect(parseFilter({ max_spice: 9, max_price: -5 })).toEqual(EMPTY_FILTER);
    expect(parseFilter({ max_price: 1.5 })!.maxPrice).toBeNull();
  });
});

describe('parseFood / foodProblems', () => {
  it('reads database columns defensively', () => {
    expect(
      parseFood({
        tags: ['vegan', 'nope'],
        spice_level: 2,
        dietary_verified: true,
        highlight: true,
      }),
    ).toEqual({
      tags: ['vegan'],
      spice: 2,
      verified: true,
      highlight: true,
    });
    expect(parseFood({})).toEqual({ tags: [], spice: null, verified: false, highlight: false });
    expect(parseFood({ spice_level: 7, dietary_verified: 'yes' })).toMatchObject({
      spice: null,
      verified: false,
    });
  });
  it('vegetarian with meat, vegan with egg are contradictions the owner must fix', () => {
    expect(foodProblems(food(['vegetarian', 'contains_pork']))).toEqual(['vegetarian_with_meat']);
    expect(foodProblems(food(['vegan', 'contains_egg']))).toEqual(['vegan_with_animal_product']);
    expect(foodProblems(food(['vegetarian', 'contains_egg']))).toEqual([]);
  });
});
