import type { SupabaseClient } from '@supabase/supabase-js';
import { parseChannelPrices, parseFood, parseLocalizedText, bySort } from '@bestie/core';
import type { ChannelPrices, ItemFood, LocalizedText } from '@bestie/core';
import type { ErrorKey } from '@bestie/i18n';

export type Cat = {
  id: string;
  name: LocalizedText;
  sort: number;
  active: boolean;
  created_at: string;
};
export type Item = {
  id: string;
  category_id: string;
  name: LocalizedText;
  prices: ChannelPrices;
  station: 'kitchen' | 'bar' | null;
  /** Length of a service in minutes (salon / spa menus); null = not a timed service. */
  duration_min: number | null;
  /** What a scanner reads / the shop's own stock code (retail); null = none. */
  barcode?: string | null;
  sku?: string | null;
  /** Version of the item's picture (null = none); part of the picture's address. */
  image_v?: number | null;
  modifier_group_ids: string[];
  available: boolean;
  food: ItemFood;
  sort: number;
  created_at: string;
};
export type Group = {
  id: string;
  name: LocalizedText;
  min_select: number;
  max_select: number;
  sort: number;
  created_at: string;
};
export type Opt = {
  id: string;
  group_id: string;
  name: LocalizedText;
  price_delta: number;
  channel_delta: Record<string, number>;
  /** A variant (size, colour…) may have its own barcode and SKU. */
  barcode?: string | null;
  sku?: string | null;
  active: boolean;
  sort: number;
  created_at: string;
};
export type Menu = { cats: Cat[]; items: Item[]; groups: Group[]; opts: Opt[] };

type Row = Record<string, unknown>;
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Reads one shop's live (not deleted) menu. A bad row is skipped, never allowed to break the screen. */
export async function loadMenu(client: SupabaseClient, storeId: string): Promise<Menu> {
  const q = (table: string, cols: string) =>
    client
      .from(table)
      .select(cols)
      .eq('store_id', storeId)
      .is('deleted_at', null)
      .order('created_at');
  const [cats, items, groups, opts] = await Promise.all([
    q('menu_categories', 'id, name, sort, active, created_at'),
    q(
      'menu_items',
      'id, category_id, name, prices, station, duration_min, barcode, sku, image_v, modifier_group_ids, available, tags, spice_level, dietary_verified, highlight, sort, created_at',
    ),
    q('modifier_groups', 'id, name, min_select, max_select, sort, created_at'),
    q(
      'modifier_options',
      'id, group_id, name, price_delta, channel_delta, barcode, sku, active, sort, created_at',
    ),
  ]);
  if (cats.error || items.error || groups.error || opts.error) throw new Error('load');
  const rows = (r: { data: unknown }) => (r.data ?? []) as unknown as Row[];
  const out: Menu = {
    cats: rows(cats).map((r) => ({
      id: str(r.id),
      name: parseLocalizedText(r.name),
      sort: num(r.sort),
      active: r.active !== false,
      created_at: str(r.created_at),
    })),
    items: rows(items).flatMap((r) => {
      const prices = parseChannelPrices(r.prices);
      if (!prices) return [];
      return [
        {
          id: str(r.id),
          category_id: str(r.category_id),
          name: parseLocalizedText(r.name),
          prices,
          station: r.station === 'kitchen' || r.station === 'bar' ? r.station : null,
          duration_min: typeof r.duration_min === 'number' ? r.duration_min : null,
          barcode: typeof r.barcode === 'string' ? r.barcode : null,
          sku: typeof r.sku === 'string' ? r.sku : null,
          image_v: typeof r.image_v === 'number' ? r.image_v : null,
          modifier_group_ids: Array.isArray(r.modifier_group_ids)
            ? r.modifier_group_ids.filter((x): x is string => typeof x === 'string')
            : [],
          available: r.available !== false,
          food: parseFood(r),
          sort: num(r.sort),
          created_at: str(r.created_at),
        },
      ];
    }),
    groups: rows(groups).map((r) => ({
      id: str(r.id),
      name: parseLocalizedText(r.name),
      min_select: num(r.min_select),
      max_select: num(r.max_select, 1),
      sort: num(r.sort),
      created_at: str(r.created_at),
    })),
    opts: rows(opts).map((r) => ({
      id: str(r.id),
      group_id: str(r.group_id),
      name: parseLocalizedText(r.name),
      price_delta: num(r.price_delta),
      barcode: typeof r.barcode === 'string' ? r.barcode : null,
      sku: typeof r.sku === 'string' ? r.sku : null,
      channel_delta:
        r.channel_delta && typeof r.channel_delta === 'object' && !Array.isArray(r.channel_delta)
          ? Object.fromEntries(
              Object.entries(r.channel_delta as Record<string, unknown>).filter(
                (e): e is [string, number] => typeof e[1] === 'number',
              ),
            )
          : {},
      active: r.active !== false,
      sort: num(r.sort),
      created_at: str(r.created_at),
    })),
  };
  out.cats.sort(bySort);
  out.items.sort(bySort);
  out.groups.sort(bySort);
  out.opts.sort(bySort);
  return out;
}

export type MenuTable = 'menu_categories' | 'menu_items' | 'modifier_groups' | 'modifier_options';

/** A database refusal → the sentence key the person sees. */
export const menuError = (code: string | undefined): ErrorKey =>
  code === '42501'
    ? 'err_forbidden'
    : code === '23514'
      ? 'err_menu_invalid'
      : code === '23505'
        ? 'err_menu_barcode'
        : 'err_save_failed';

/** Create (client-generated uuid, offline-first) or change a row; an update that touched 0 rows is a failure. */
export async function saveRow(
  client: SupabaseClient,
  table: MenuTable,
  id: string | null,
  values: Record<string, unknown>,
): Promise<ErrorKey | null> {
  if (id === null) {
    const { error } = await client.from(table).insert({ id: crypto.randomUUID(), ...values });
    return error ? menuError(error.code) : null;
  }
  const { data, error } = await client.from(table).update(values).eq('id', id).select('id');
  return error || data?.length !== 1 ? menuError(error?.code) : null;
}

/** Soft delete: history and offline replays keep working. */
export const deleteRow = (client: SupabaseClient, table: MenuTable, id: string) =>
  saveRow(client, table, id, { deleted_at: new Date().toISOString() });

export const nextSort = (rows: readonly { sort: number }[]): number =>
  rows.reduce((m, r) => Math.max(m, r.sort), 0) + 10;
