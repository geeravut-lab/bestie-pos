import { MoneyError } from './money';
import type { Satang } from './money';
import type { Channel, MenuItem, Modifier, ModifierGroup } from './types';

/** Unit price of an item for a channel (falls back to the base price). */
export const itemPrice = (item: Pick<MenuItem, 'prices'>, channel: Channel): Satang =>
  item.prices[channel] ?? item.prices.base;

export const modifierPrice = (m: Modifier, channel: Channel): Satang =>
  m.channelDelta?.[channel] ?? m.priceDelta;

export type SelectionProblem = {
  groupId: string;
  problem: 'too_few' | 'too_many' | 'unknown_option';
};

/** Min/max rules per modifier group (PRODUCT_SPEC §6). `selected` = option ids chosen for the line. */
export function validateSelection(
  groups: readonly ModifierGroup[],
  selected: readonly string[],
): SelectionProblem[] {
  const problems: SelectionProblem[] = [];
  const known = new Set(groups.flatMap((g) => g.options.map((o) => o.id)));
  for (const id of selected) {
    if (!known.has(id)) problems.push({ groupId: '', problem: 'unknown_option' });
  }
  for (const g of groups) {
    const n = g.options.filter((o) => selected.includes(o.id)).length;
    if (n < g.min) problems.push({ groupId: g.id, problem: 'too_few' });
    if (n > g.max) problems.push({ groupId: g.id, problem: 'too_many' });
  }
  return problems;
}

/** Unit price including chosen modifiers for a channel. Throws if the result would be negative. */
export function lineUnitPrice(
  item: MenuItem,
  groups: readonly ModifierGroup[],
  selected: readonly string[],
  channel: Channel,
): Satang {
  const deltas = groups
    .flatMap((g) => g.options)
    .filter((o) => selected.includes(o.id))
    .map((o) => modifierPrice(o, channel));
  const price = itemPrice(item, channel) + deltas.reduce((a, b) => a + b, 0);
  if (price < 0) throw new MoneyError('line price cannot be negative');
  return price;
}
