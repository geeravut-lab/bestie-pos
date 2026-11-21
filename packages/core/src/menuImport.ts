// Menu import: read a CSV (or a table pasted from a spreadsheet) from another POS and turn it into rows for `import_menu`. Nothing here talks to the database.
// Headers are recognised in English and Thai (Loyverse, FoodStory and plain spreadsheets); prices are baht with or without decimals and become satang.
export type ImportRow = {
  category: string;
  name_th: string;
  name_en?: string;
  price: number;
  barcode?: string;
  sku?: string;
  station?: 'kitchen' | 'bar';
};
export type ImportIssue = { line: number; reason: 'no_name' | 'bad_price' | 'too_long' };
export type ImportParse = {
  rows: ImportRow[];
  issues: ImportIssue[];
  columns: Record<string, number>;
  truncated: boolean;
};

export const MAX_IMPORT_ROWS = 500;

/** Split CSV text into records: quotes, doubled quotes, commas / semicolons / tabs, CRLF, a BOM. */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // a byte-order mark from Excel
  const first = src.split(/\r?\n/, 1)[0] ?? '';
  const delim = [',', ';', '\t']
    .map((d) => ({ d, n: first.split(d).length }))
    .sort((a, b) => b.n - a.n)[0]!.d;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (q) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

const ALIASES: Record<string, readonly string[]> = {
  category: ['category', 'categories', 'group', 'หมวด', 'หมวดหมู่', 'หมวดสินค้า'],
  name_th: [
    'name_th',
    'name th',
    'thai name',
    'ชื่อไทย',
    'ชื่อ',
    'ชื่อสินค้า',
    'ชื่อเมนู',
    'name',
    'item name',
    'item',
    'product',
    'product name',
  ],
  name_en: ['name_en', 'name en', 'english name', 'ชื่ออังกฤษ'],
  price: ['price', 'unit price', 'selling price', 'default price', 'ราคา', 'ราคาขาย'],
  barcode: ['barcode', 'บาร์โค้ด', 'upc', 'ean'],
  sku: ['sku', 'ref', 'reference', 'รหัส', 'รหัสสินค้า', 'handle'],
  station: ['station', 'สถานี'],
};
const norm = (h: string) => h.trim().toLowerCase().replace(/\s+/g, ' ');

/** Which column is which (by header); the first alias that matches wins, so `name_th` beats a bare `name`. */
export function mapColumns(header: readonly string[]): Record<string, number> {
  const h = header.map(norm);
  const out: Record<string, number> = {};
  for (const [field, names] of Object.entries(ALIASES))
    for (const nm of names) {
      const i = h.indexOf(nm);
      if (i >= 0 && !Object.values(out).includes(i)) {
        out[field] = i;
        break;
      }
    }
  return out;
}

/** "120", "120.50", "฿1,200", "1 200" → satang; null when it is not a price. */
export function bahtToSatang(v: string): number | null {
  const x = v.replace(/[฿,\s]|บาท/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(x)) return null;
  return Math.round(Number(x) * 100);
}

export function parseMenuCsv(text: string): ImportParse {
  const table = parseCsv(text);
  const columns = table[0] ? mapColumns(table[0]) : {};
  const rows: ImportRow[] = [];
  const issues: ImportIssue[] = [];
  if (columns.name_th === undefined || columns.price === undefined)
    return { rows, issues, columns, truncated: false };
  let truncated = false;
  for (let i = 1; i < table.length; i++) {
    const r = table[i]!;
    const get = (f: string): string =>
      columns[f] === undefined ? '' : (r[columns[f]!] ?? '').trim();
    const name = get('name_th');
    if (!name) {
      issues.push({ line: i + 1, reason: 'no_name' });
      continue;
    }
    if (name.length > 80) {
      issues.push({ line: i + 1, reason: 'too_long' });
      continue;
    }
    const price = bahtToSatang(get('price'));
    if (price === null) {
      issues.push({ line: i + 1, reason: 'bad_price' });
      continue;
    }
    if (rows.length >= MAX_IMPORT_ROWS) {
      truncated = true;
      break;
    }
    const station = get('station').toLowerCase();
    rows.push({
      category: get('category') || 'Imported',
      name_th: name,
      ...(get('name_en') ? { name_en: get('name_en') } : {}),
      price,
      ...(/^[0-9A-Za-z-]{4,40}$/.test(get('barcode')) ? { barcode: get('barcode') } : {}),
      ...(/^[0-9A-Za-z-]{1,40}$/.test(get('sku')) ? { sku: get('sku') } : {}),
      ...(station === 'kitchen' || station === 'bar' ? { station } : {}),
    });
  }
  return { rows, issues, columns, truncated };
}
