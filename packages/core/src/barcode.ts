// Barcodes and SKUs on the menu: a menu item may carry a barcode and a SKU, and so may an option (a variant such as size or colour).
// Scanning a barcode at the till finds the item (and the option, when the code is a variant's). Pure functions: the till runs this
// from the cached menu, so scanning works offline; the database only guarantees that a code is used once per shop.

/** Letters, digits and dashes, 4–40 characters (same rule as stock barcodes and the database check). */
export const BARCODE_RE = /^[0-9A-Za-z-]{4,40}$/;

/** What a scanner typed, cleaned: control characters (the Enter key, prefix / suffix bytes) and surrounding spaces removed. */
export function cleanScan(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const c = ch.charCodeAt(0);
    if (c >= 0x20 && c !== 0x7f) out += ch;
  }
  return out.trim();
}

/** A SKU: the same characters, but it may be short (1–40) and may repeat. */
export const SKU_RE = /^[0-9A-Za-z-]{1,40}$/;

/** A SKU as the owner typed it, or null when empty; `'bad'` when it breaks the rule. */
export function parseSku(raw: string): string | null | 'bad' {
  const v = cleanScan(raw);
  if (v === '') return null;
  return SKU_RE.test(v) ? v : 'bad';
}

/** A barcode as the owner typed it, or null when empty; `'bad'` when it breaks the rule. */
export function parseCode(raw: string): string | null | 'bad' {
  const v = cleanScan(raw);
  if (v === '') return null;
  return BARCODE_RE.test(v) ? v : 'bad';
}

export type ScanItem = {
  id: string;
  barcode?: string | null;
  available: boolean;
  modifier_group_ids: readonly string[];
};
export type ScanOption = {
  id: string;
  group_id: string;
  barcode?: string | null;
  active: boolean;
};
export type ScanMenu = { items: readonly ScanItem[]; opts: readonly ScanOption[] };

export type ScanResult =
  | { kind: 'found'; itemId: string; optionId: string | null }
  | { kind: 'ambiguous' } // one variant code used by several dishes: the person picks on the screen
  | { kind: 'sold_out'; itemId: string }
  | { kind: 'not_found' };

const same = (a: string | null | undefined, b: string) =>
  typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

/** Find what a scanned code sells. Item barcodes win; a variant's code finds the one item that offers that variant. */
export function resolveScan(menu: ScanMenu, scanned: string): ScanResult {
  const code = cleanScan(scanned);
  if (!BARCODE_RE.test(code)) return { kind: 'not_found' };
  const item = menu.items.find((i) => same(i.barcode, code));
  if (item)
    return item.available
      ? { kind: 'found', itemId: item.id, optionId: null }
      : { kind: 'sold_out', itemId: item.id };
  const opt = menu.opts.find((o) => o.active && same(o.barcode, code));
  if (!opt) return { kind: 'not_found' };
  const owners = menu.items.filter((i) => i.modifier_group_ids.includes(opt.group_id));
  if (owners.length === 0) return { kind: 'not_found' };
  if (owners.length > 1) return { kind: 'ambiguous' };
  const owner = owners[0]!;
  return owner.available
    ? { kind: 'found', itemId: owner.id, optionId: opt.id }
    : { kind: 'sold_out', itemId: owner.id };
}

/** Codes used more than once among items and options (ignoring case): the editor warns about them before the database refuses. */
export function duplicateCodes(rows: readonly { barcode?: string | null }[]): Set<string> {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const r of rows) {
    if (!r.barcode) continue;
    const k = r.barcode.toLowerCase();
    if (seen.has(k)) dup.add(k);
    seen.add(k);
  }
  return dup;
}
