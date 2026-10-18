// Menu spreadsheet import (CSV or XLSX). One row per item; categories are created on the fly.
// Rows are matched to existing items by category + name, so re-importing a sheet updates prices.

import ExcelJS from 'exceljs';
import { rupeesToPaise } from '@mezmitra/shared/money';
import type { Tx } from '../../context';
import { json } from '../../db';
import { badRequest } from '../../lib/errors';

export const IMPORT_COLUMNS = [
  'category',
  'name',
  'price',
  'veg',
  'description',
  'tax_rate',
  'hsn_sac',
  'station',
  'tags',
  'in_stock',
  'name_hi',
] as const;

export const IMPORT_TEMPLATE_CSV = [
  IMPORT_COLUMNS.join(','),
  'Starters,Paneer Tikka,320,yes,Cottage cheese grilled in tandoor,5,996331,kitchen,bestseller|spicy,yes,पनीर टिक्का',
  'Beverages,Masala Chai,60,yes,,5,996331,bar,,yes,मसाला चाय',
  'Mains,Butter Chicken,450,no,Creamy tomato gravy,5,996331,kitchen,chef special,yes,बटर चिकन',
].join('\n');

const MAX_ROWS = 2000;

/** Minimal RFC 4180 CSV parser: quoted fields, doubled quotes, CRLF, BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

function toRecords(grid: string[][]): Record<string, string>[] {
  const [header, ...body] = grid;
  if (!header) throw badRequest('empty_file', 'The file has no rows');
  const keys = header.map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  if (!keys.includes('name') || !keys.includes('price') || !keys.includes('category')) {
    throw badRequest('missing_columns', 'The first row must include category, name and price columns');
  }
  if (body.length > MAX_ROWS) throw badRequest('too_many_rows', `At most ${MAX_ROWS} rows per import`);
  return body.map((cells) => Object.fromEntries(keys.map((k, i) => [k, (cells[i] ?? '').trim()])));
}

/** First sheet of an .xlsx, or a .csv, as rows of text cells. Dates become YYYY-MM-DD (with HH:MM when a time is set). */
export async function readGrid(filename: string, buffer: Buffer): Promise<string[][]> {
  if (/\.xlsx$/i.test(filename)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = wb.worksheets[0];
    if (!sheet) throw badRequest('empty_file', 'The workbook has no sheets');
    const grid: string[][] = [];
    const cell = (v: unknown): string => {
      if (v == null) return '';
      // Excel keeps the wall-clock time as UTC; a time of day is kept for sales exports.
      if (v instanceof Date) {
        const iso = v.toISOString();
        return iso.slice(11, 16) === '00:00' ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
      }
      if (typeof v === 'object' && 'text' in v) return String((v as { text: unknown }).text);
      if (typeof v === 'object' && 'result' in v) return cell((v as { result: unknown }).result);
      return String(v);
    };
    sheet.eachRow({ includeEmpty: false }, (r) => {
      grid.push((r.values as unknown[]).slice(1).map(cell));
    });
    return grid;
  }
  if (/\.csv$/i.test(filename) || !/\.\w+$/.test(filename)) return parseCsv(buffer.toString('utf8'));
  throw badRequest('invalid_file_type', 'Upload a .csv or .xlsx file');
}

export async function readSpreadsheet(filename: string, buffer: Buffer): Promise<Record<string, string>[]> {
  return toRecords(await readGrid(filename, buffer));
}

function parseBool(value: string, fallback: boolean): boolean | null {
  const v = value.trim().toLowerCase();
  if (v === '') return fallback;
  if (['yes', 'y', 'true', '1', 'veg'].includes(v)) return true;
  if (['no', 'n', 'false', '0', 'non-veg', 'nonveg', 'non veg'].includes(v)) return false;
  return null;
}

export interface ImportResult {
  dry_run: boolean;
  categories_created: number;
  items_created: number;
  items_updated: number;
  errors: { row: number; message: string }[];
}

interface ParsedRow {
  line: number;
  category: string;
  name: string;
  price_paise: number;
  is_veg: boolean;
  description: string | null;
  tax_rate_bp: number;
  hsn_sac: string | null;
  station: string;
  tags: string[];
  in_stock: boolean;
  name_hi: string | null;
}

export async function importMenu(
  tx: Tx,
  outlet: { id: string; kitchen_stations: string[]; default_tax_rate_bp: number },
  records: Record<string, string>[],
  opts: { dryRun: boolean },
): Promise<ImportResult> {
  const errors: ImportResult['errors'] = [];
  const parsed: ParsedRow[] = [];
  const seen = new Set<string>();

  records.forEach((r, i) => {
    const line = i + 2; // header is row 1
    const fail = (message: string) => errors.push({ row: line, message });
    const category = r.category ?? '';
    const name = r.name ?? '';
    if (!category) return fail('category is required');
    if (!name) return fail('name is required');
    if (name.length > 120) return fail('name is longer than 120 characters');
    let price: number;
    try {
      price = rupeesToPaise((r.price ?? '').replace(/[₹,\s]/g, ''));
    } catch {
      return fail(`price "${r.price}" is not a rupee amount`);
    }
    if (price < 0) return fail('price cannot be negative');
    const veg = parseBool(r.veg ?? '', true);
    if (veg === null) return fail(`veg must be yes or no, got "${r.veg}"`);
    const inStock = parseBool(r.in_stock ?? '', true);
    if (inStock === null) return fail(`in_stock must be yes or no, got "${r.in_stock}"`);
    let taxBp = outlet.default_tax_rate_bp;
    if (r.tax_rate) {
      const pct = Number(r.tax_rate.replace('%', ''));
      if (!Number.isFinite(pct) || pct < 0 || pct > 28) return fail(`tax_rate "${r.tax_rate}" must be a percentage from 0 to 28`);
      taxBp = Math.round(pct * 100);
    }
    const station = r.station || outlet.kitchen_stations[0] || 'kitchen';
    if (!outlet.kitchen_stations.includes(station)) {
      return fail(`station "${station}" is not one of ${outlet.kitchen_stations.join(', ')}`);
    }
    const key = `${category.toLowerCase()}::${name.toLowerCase()}`;
    if (seen.has(key)) return fail(`"${name}" appears twice in "${category}"`);
    seen.add(key);
    parsed.push({
      line,
      category,
      name,
      price_paise: price,
      is_veg: veg,
      description: r.description || null,
      tax_rate_bp: taxBp,
      hsn_sac: r.hsn_sac || null,
      station,
      tags: (r.tags ?? '')
        .split(/[|;]/)
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 10),
      in_stock: inStock,
      name_hi: r.name_hi || null,
    });
  });

  const result: ImportResult = { dry_run: opts.dryRun, categories_created: 0, items_created: 0, items_updated: 0, errors };
  if (errors.length) return result;

  const categories = await tx.db
    .selectFrom('menu_categories')
    .select(['id', 'name'])
    .where('outlet_id', '=', outlet.id)
    .where('deleted_at', 'is', null)
    .execute();
  const catByName = new Map(categories.map((c) => [c.name.toLowerCase(), c.id]));
  const items = await tx.db
    .selectFrom('menu_items')
    .select(['id', 'name', 'category_id'])
    .where('outlet_id', '=', outlet.id)
    .where('deleted_at', 'is', null)
    .execute();
  const itemByKey = new Map(items.map((i) => [`${i.category_id}::${i.name.toLowerCase()}`, i.id]));

  let nextSort = categories.length;
  for (const row of parsed) {
    let categoryId = catByName.get(row.category.toLowerCase());
    if (!categoryId) {
      result.categories_created++;
      if (opts.dryRun) {
        categoryId = `new:${row.category.toLowerCase()}`;
      } else {
        const c = await tx.db
          .insertInto('menu_categories')
          .values({ tenant_id: tx.tenantId, outlet_id: outlet.id, name: row.category, sort: nextSort++ })
          .returning('id')
          .executeTakeFirstOrThrow();
        categoryId = c.id;
      }
      catByName.set(row.category.toLowerCase(), categoryId);
    }
    const existing = itemByKey.get(`${categoryId}::${row.name.toLowerCase()}`);
    const values = {
      name: row.name,
      price_paise: row.price_paise,
      is_veg: row.is_veg,
      description: row.description,
      tax_rate_bp: row.tax_rate_bp,
      hsn_sac: row.hsn_sac,
      station: row.station,
      tags: row.tags,
      in_stock: row.in_stock,
      ...(row.name_hi ? { translations: json({ hi: { name: row.name_hi } }) } : {}),
    };
    if (existing) {
      result.items_updated++;
      if (!opts.dryRun) await tx.db.updateTable('menu_items').set(values).where('id', '=', existing).execute();
    } else {
      result.items_created++;
      if (!opts.dryRun) {
        await tx.db
          .insertInto('menu_items')
          .values({ ...values, tenant_id: tx.tenantId, outlet_id: outlet.id, category_id: categoryId, sort: row.line })
          .execute();
      }
    }
  }
  return result;
}
