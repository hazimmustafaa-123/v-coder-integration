import { coerce, type ColumnMap, type FieldSpec } from './columns.js';
import { csvSafe, toCsv } from './text.js';
import { buildXlsx } from './xlsx-write.js';

/**
 * The shared language of an import: a row becomes a RowPlan (what will happen to it and why), a file becomes a list of them with counts. The preview screen, the error file and the
 * final report all read this one shape, in every product. Nothing here writes anywhere.
 */
export type Severity = 'error' | 'warning' | 'info';
export type Action = 'create' | 'update' | 'skip' | 'error';
export interface Issue { code: string; severity: Severity; field?: string; /** a short value to show next to the message (the existing item's name, the other line) */ hint?: string }
export interface RowPlan {
  /** the row's line in the owner's file (1 = the header) */
  line: number;
  action: Action;
  /** the cleaned values by field key */
  values: Record<string, string | boolean | null>;
  /** for an update: what is stored now, for the fields that will change */
  before?: Record<string, string | null>;
  /** the id of the stored row it matches (a product decides what an id is) */
  matchId?: string;
  /** the fields whose value came from AI instead of the file: the owner must confirm them (decision ق-ب4) */
  fromAi?: string[];
  issues: Issue[];
}

export interface RawRow { line: number; cells: Record<string, string> }

/** the data rows of a table by field key, using the column map; fully empty rows are dropped */
export function extractRows(table: string[][], map: ColumnMap, startLine = 2): RawRow[] {
  const keyAt = map.columns.map((c) => c.key);
  const out: RawRow[] = [];
  for (let i = 1; i < table.length; i++) {
    const cells: Record<string, string> = {};
    let any = false;
    keyAt.forEach((k, ci) => { const v = String(table[i]![ci] ?? '').trim(); if (v !== '') any = true; if (k) cells[k] = v; });
    if (any) out.push({ line: i - 1 + startLine, cells });
  }
  return out;
}

/** the first pass over a row: every mapped cell cleaned to its type, required fields present; what a product adds (matching, business rules) comes after */
export function cleanRow(raw: RawRow, fields: FieldSpec[]): RowPlan {
  const values: RowPlan['values'] = {}, issues: Issue[] = [];
  for (const f of fields) {
    const cell = raw.cells[f.key];
    if (cell === undefined) { values[f.key] = null; continue; }
    const c = coerce(f, cell);
    if (!c.ok) { issues.push({ code: c.code, severity: 'error', field: f.key, hint: cell.slice(0, 40) }); values[f.key] = null; continue; }
    values[f.key] = c.value;
    if (f.required && c.value === null) issues.push({ code: 'required_missing', severity: 'error', field: f.key });
  }
  return { line: raw.line, action: issues.some((i) => i.severity === 'error') ? 'error' : 'create', values, issues };
}

export interface PlanCounts { rows: number; create: number; update: number; skip: number; error: number; warnings: number }
export function countPlan(plans: RowPlan[]): PlanCounts {
  const c: PlanCounts = { rows: plans.length, create: 0, update: 0, skip: 0, error: 0, warnings: 0 };
  for (const p of plans) { c[p.action] += 1; c.warnings += p.issues.filter((i) => i.severity === 'warning').length; }
  return c;
}

/** a row is final when the owner can import it without looking: no errors; a row with warnings still imports (the preview showed them) */
export const importable = (p: RowPlan): boolean => p.action === 'create' || p.action === 'update';

/** the file of rows that did not import, in the owner's own columns plus the reason, ready to fix and upload again */
export function errorFile(fields: FieldSpec[], plans: RowPlan[], reasons: (code: string) => string, format: 'csv' | 'xlsx'): { filename: string; content: string; base64: boolean } {
  const bad = plans.filter((p) => p.action === 'error' || p.issues.some((i) => i.severity === 'error'));
  const head = ['السطر', ...fields.map((f) => f.label), 'سبب الرفض'];
  const rows = bad.map((p) => [p.line, ...fields.map((f) => { const v = p.values[f.key]; return v === null || v === undefined ? '' : String(v); }), p.issues.filter((i) => i.severity === 'error').map((i) => reasons(i.code) + (i.field ? ` (${fields.find((f) => f.key === i.field)?.label ?? i.field})` : '')).join('؛ ')]);
  if (format === 'xlsx') return { filename: 'rejected-rows.xlsx', content: buildXlsx([{ name: 'مرفوض', rows: [head, ...rows.map((r) => r.map((v) => (typeof v === 'string' ? csvSafe(v) : v)))], widths: [8, ...fields.map(() => 20), 40] }]).toString('base64'), base64: true };
  return { filename: 'rejected-rows.csv', content: toCsv([head, ...rows]), base64: false };
}

/** the downloadable template: one sheet with the field labels as the header and an example row, one sheet explaining each column */
export function templateXlsx(title: string, fields: FieldSpec[], typeNames: Record<string, string>): Buffer {
  return buildXlsx([
    { name: title, rows: [fields.map((f) => f.label), fields.map((f) => f.example ?? '')], widths: fields.map(() => 22) },
    { name: 'شرح الأعمدة', rows: [['العمود', 'مطلوب؟', 'النوع', 'يمكن أن يُكتب أيضًا باسم'], ...fields.map((f) => [f.label, f.required ? 'نعم' : 'لا', typeNames[f.type] ?? f.type, f.aliases.slice(0, 4).join('، ')])], widths: [24, 10, 14, 50] },
  ]);
}
