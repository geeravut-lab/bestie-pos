/**
 * Food information on menu items and the filter a guest applies (docs/AI-CUSTOMER-ASSISTANT.md §3A).
 *
 * Rules that must never bend:
 *  - the SHOP sets the tags (an AI may draft them, a person confirms); the model never decides what is in a dish;
 *  - "unknown" is not "safe": a dish the shop has not marked as verified is NEVER shown as an answer to a dietary request,
 *    it goes to the "ask the staff" group;
 *  - a dish that carries a tag the guest excluded is never shown at all, verified or not (recall must be 100 %);
 *  - the model only turns the guest's words into a `DietFilter`; the filtering is plain code (and is unit-tested).
 */

export const DIET_TAGS = [
  'contains_pork',
  'contains_beef',
  'contains_chicken',
  'contains_seafood',
  'contains_shellfish',
  'contains_egg',
  'contains_dairy',
  'contains_gluten',
  'contains_peanut',
  'contains_tree_nut',
  'contains_soy',
  'contains_alcohol',
  'vegetarian',
  'vegan',
  'halal',
] as const;
export type DietTag = (typeof DIET_TAGS)[number];

export const isDietTag = (v: unknown): v is DietTag =>
  typeof v === 'string' && (DIET_TAGS as readonly string[]).includes(v);

export const SPICE_LEVELS = [0, 1, 2, 3] as const;
export type SpiceLevel = (typeof SPICE_LEVELS)[number];

/** What the shop tells us about one dish. `verified` = the shop has gone through this dish and the tags are complete. */
export type ItemFood = {
  tags: readonly DietTag[];
  spice: SpiceLevel | null; // null = not stated
  verified: boolean;
  highlight: boolean;
};

export const EMPTY_FOOD: ItemFood = { tags: [], spice: null, verified: false, highlight: false };

const MEAT: readonly DietTag[] = [
  'contains_pork',
  'contains_beef',
  'contains_chicken',
  'contains_seafood',
  'contains_shellfish',
];
const ANIMAL_PRODUCTS: readonly DietTag[] = ['contains_egg', 'contains_dairy'];

/** Reads the columns of a `menu_items` row; anything unknown is dropped, a damaged row becomes "no information". */
export function parseFood(row: {
  tags?: unknown;
  spice_level?: unknown;
  spice?: unknown;
  dietary_verified?: unknown;
  verified?: unknown;
  highlight?: unknown;
}): ItemFood {
  const rawTags = Array.isArray(row.tags) ? row.tags : [];
  const tags = [...new Set(rawTags.filter(isDietTag))];
  const sp = row.spice_level ?? row.spice;
  const spice = sp === 0 || sp === 1 || sp === 2 || sp === 3 ? sp : null;
  return {
    tags,
    spice,
    verified: (row.dietary_verified ?? row.verified) === true,
    highlight: row.highlight === true,
  };
}

/** Problems the owner must fix before the dish can be marked verified (same rule is a CHECK in the database). */
export type FoodProblem =
  'vegetarian_with_meat' | 'vegan_with_animal_product' | 'verified_without_spice';

export function foodProblems(f: ItemFood): FoodProblem[] {
  const out: FoodProblem[] = [];
  const has = (t: DietTag) => f.tags.includes(t);
  if (has('vegetarian') && MEAT.some(has)) out.push('vegetarian_with_meat');
  if (has('vegan') && (MEAT.some(has) || ANIMAL_PRODUCTS.some(has)))
    out.push('vegan_with_animal_product');
  return out;
}

export type DietFilter = {
  exclude: DietTag[]; // "no pork" → ['contains_pork']
  require: DietTag[]; // "vegetarian" → ['vegetarian']
  maxSpice: SpiceLevel | null; // "not spicy" → 0
  maxPrice: number | null; // satang
  keywords: string[]; // matched against dish names, at most 3
};

export const EMPTY_FILTER: DietFilter = {
  exclude: [],
  require: [],
  maxSpice: null,
  maxPrice: null,
  keywords: [],
};

export const hasDietConstraint = (f: DietFilter): boolean =>
  f.exclude.length > 0 || f.require.length > 0 || f.maxSpice !== null;

/** Turns whatever a model (or a URL) produced into a safe filter: unknown tags dropped, numbers range-checked. */
export function parseFilter(raw: unknown): DietFilter | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const tags = (v: unknown): DietTag[] =>
    Array.isArray(v) ? [...new Set(v.filter(isDietTag))] : [];
  const sp = r.max_spice ?? r.maxSpice;
  const pr = r.max_price ?? r.maxPrice;
  const kw = Array.isArray(r.keywords)
    ? r.keywords
        .filter((k): k is string => typeof k === 'string')
        .map((k) => k.trim().slice(0, 30))
        .filter((k) => k.length >= 2)
        .slice(0, 3)
    : [];
  return {
    exclude: tags(r.exclude),
    require: tags(r.require),
    maxSpice: sp === 0 || sp === 1 || sp === 2 || sp === 3 ? sp : null,
    maxPrice:
      typeof pr === 'number' && Number.isInteger(pr) && pr > 0 && pr <= 100_000_000 ? pr : null,
    keywords: kw,
  };
}

export type FilterItem = {
  id: string;
  name: { th?: string; en?: string };
  price: number;
  food: ItemFood;
};

export type FilterResult = {
  /** The shop has confirmed this dish fits. */
  ok: string[];
  /** Nothing in the shop's data says it does NOT fit, but the shop has not confirmed the dish: ask the staff. */
  unverified: string[];
  /** How many dishes were left out because they carry something the guest excluded, or are over budget. */
  hidden: number;
};

const nameMatches = (name: FilterItem['name'], kw: string[]): boolean => {
  if (kw.length === 0) return true;
  const hay = `${name.th ?? ''} ${name.en ?? ''}`.toLowerCase();
  return kw.some((k) => hay.includes(k.toLowerCase()));
};

/** Anything that cannot be on a vegetarian / vegan plate. */
const impliedExcludes = (f: DietFilter): DietTag[] => {
  const out = new Set<DietTag>(f.exclude);
  if (f.require.includes('vegetarian') || f.require.includes('vegan'))
    for (const m of MEAT) out.add(m);
  if (f.require.includes('vegan')) for (const a of ANIMAL_PRODUCTS) out.add(a);
  return [...out];
};

export function applyFilter(items: readonly FilterItem[], filter: DietFilter): FilterResult {
  const exclude = impliedExcludes(filter);
  const constrained = hasDietConstraint(filter);
  const ok: FilterItem[] = [];
  const unverified: FilterItem[] = [];
  let hidden = 0;

  for (const it of items) {
    if (filter.maxPrice !== null && it.price > filter.maxPrice) {
      hidden++;
      continue;
    }
    if (!nameMatches(it.name, filter.keywords)) {
      hidden++;
      continue;
    }
    if (!constrained) {
      ok.push(it);
      continue;
    }
    const f = it.food;
    // a tag the guest wants to avoid is a fact even if the shop has not finished checking the dish
    if (exclude.some((t) => f.tags.includes(t))) {
      hidden++;
      continue;
    }
    if (filter.maxSpice !== null && f.spice !== null && f.spice > filter.maxSpice) {
      hidden++;
      continue;
    }
    if (!f.verified) {
      unverified.push(it);
      continue;
    }
    const lacksRequired = filter.require.some((t) => !f.tags.includes(t));
    const spiceUnknown = filter.maxSpice !== null && f.spice === null;
    if (lacksRequired || spiceUnknown) {
      // verified, but the shop did not say it is vegetarian / halal / how spicy it is: that is "unknown", not "no"
      if (lacksRequired && !spiceUnknown) {
        hidden++;
        continue;
      }
      unverified.push(it);
      continue;
    }
    ok.push(it);
  }
  const rank = (a: FilterItem, b: FilterItem) =>
    Number(b.food.highlight) - Number(a.food.highlight);
  ok.sort(rank); // stable: the shop's own order is kept inside each group
  unverified.sort(rank);
  return { ok: ok.map((i) => i.id), unverified: unverified.map((i) => i.id), hidden };
}

/** The sentence under the results, built from the filter by code (never written by a model). Keys are dictionary ids. */
export function describeFilter(f: DietFilter): {
  exclude: DietTag[];
  require: DietTag[];
  maxSpice: SpiceLevel | null;
  maxPrice: number | null;
} {
  return { exclude: f.exclude, require: f.require, maxSpice: f.maxSpice, maxPrice: f.maxPrice };
}
