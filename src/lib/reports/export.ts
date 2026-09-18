/**
 * Report export: one matrix, two delimiters.
 *
 * CSV is the file someone downloads and opens in Excel; TSV is what the clipboard
 * wants, because pasting tab-separated text into a spreadsheet lands one value
 * per cell without an import dialog. Both come off the same matrix, so a column
 * can never appear in one and not the other.
 *
 * Numbers go out plain: no currency symbol, no thousands separator, a leading
 * minus for negatives. A spreadsheet that receives `$1,234.56` stores a string,
 * and a column of strings is not a column anyone can add up.
 */

import { formatMoneyPlain } from '@/lib/money';

import {
  type ColumnDef,
  type Report,
  type ReportRow,
  cellIsBlank,
  cellIsPercent,
  formatBasisPointsPlain,
} from './types';

export interface ExportOptions {
  /** The title block above the data. On by default: an exported statement has to say what it is. */
  includeHeader?: boolean;
  /** The report's warnings, written under the data. On by default. */
  includeWarnings?: boolean;
  /** Indents the label by depth. Off for CSV, on for a clipboard paste. */
  indent?: boolean;
}

const LEADING_COLUMNS = ['Code', 'Account', 'Level', 'Row'] as const;

/** Row styles that carry no figures of their own. */
const HEADER_STYLES: ReadonlySet<string> = new Set(['section', 'group', 'spacer']);

function cellText(row: ReportRow, column: ColumnDef, index: number): string {
  if (column.kind === 'text' || column.kind === 'date') return row.cells?.[index] ?? '';
  if (HEADER_STYLES.has(row.style)) return '';
  if (cellIsBlank(row, index)) return '';
  const value = row.values[index] ?? 0;
  return cellIsPercent(column, row) ? formatBasisPointsPlain(value) : formatMoneyPlain(value);
}

/**
 * The report as a rectangular string matrix: a header row, then one row per
 * report row. Both writers below format from this, and so can any caller that
 * wants to build a workbook.
 */
export function toMatrix(report: Report, options: ExportOptions = {}): string[][] {
  const indent = options.indent === true;
  const matrix: string[][] = [];

  matrix.push([...LEADING_COLUMNS, ...report.columns.map((column) => column.label)]);

  for (const row of report.rows) {
    if (row.style === 'spacer') continue;
    const label = indent ? `${'  '.repeat(row.level)}${row.label}` : row.label;
    matrix.push([
      row.code ?? '',
      label,
      String(row.level),
      row.style,
      ...report.columns.map((column, index) => cellText(row, column, index)),
    ]);
  }

  return matrix;
}

function headerLines(report: Report): string[][] {
  return [
    ['Sooz Books'],
    [report.meta.title],
    [report.meta.subtitle],
    ['Basis', report.meta.basis === 'cash' ? 'Cash' : 'Accrual'],
    ['Generated', report.meta.generatedAt],
    [],
  ];
}

function warningLines(report: Report): string[][] {
  if (report.meta.warnings.length === 0) return [];
  return [[], ...report.meta.warnings.map((warning) => ['Note', warning])];
}

/**
 * Escapes one CSV field.
 *
 * A field that begins with `=`, `+` or `@` is prefixed with an apostrophe:
 * spreadsheets treat those as the start of a formula, and an account name is not
 * something a downloaded file should be able to execute. Numbers are written by
 * this module's own formatters, so the leading minus of a negative is left alone.
 */
function escapeCsv(field: string): string {
  const guarded = /^[=+@\t\r]/.test(field) ? `'${field}` : field;
  if (/[",\n\r]/.test(guarded) || guarded !== guarded.trim()) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
}

export function toCsv(report: Report, options: ExportOptions = {}): string {
  const { includeHeader = true, includeWarnings = true } = options;
  const rows: string[][] = [
    ...(includeHeader ? headerLines(report) : []),
    ...toMatrix(report, options),
    ...(includeWarnings ? warningLines(report) : []),
  ];
  // CRLF: Excel on Windows still reads a bare LF as one long row in some locales.
  return rows.map((row) => row.map(escapeCsv).join(',')).join('\r\n');
}

/**
 * Tab-separated, for the clipboard. Tabs and newlines inside a value would break
 * the paste, so they are replaced with spaces rather than quoted — a quoted field
 * is not something a clipboard paste understands.
 */
export function toTsv(report: Report, options: ExportOptions = {}): string {
  const rows = [
    ...toMatrix(report, { ...options, indent: options.indent ?? true }),
    ...(options.includeWarnings === true ? warningLines(report) : []),
  ];
  return rows
    .map((row) => row.map((field) => field.replace(/[\t\r\n]+/g, ' ')).join('\t'))
    .join('\n');
}

/** `sooz-profit-loss-2026-03-01-2026-03-31.csv` */
export function reportFilename(report: Report, extension: 'csv' | 'tsv'): string {
  const slug = report.meta.title
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `sooz-${slug}-${report.meta.from}-${report.meta.to}.${extension}`;
}
