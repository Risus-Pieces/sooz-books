/**
 * The shape every financial report returns, and the primitives that build it.
 *
 * There is exactly one row model in this product. A P&L, a balance sheet, a
 * trial balance and a general ledger all come back as `{ columns, rows, meta }`,
 * which is what lets one dense table component render all of them, one CSV
 * writer export all of them, and one toolbar drive all of them.
 *
 * Two conventions hold throughout:
 *   - Money is integer cents, as everywhere else in the product.
 *   - Percentages are integer basis points (4250 = 42.50%). A ratio is not
 *     money, but it is still a figure that has to add up the same way twice, so
 *     it gets the same integer treatment rather than a float.
 */

import type { Account } from '@/db/schema';
import { type CalendarDate, dateParts, daysInMonth, monthEnd, monthStart, today } from '@/lib/dates';
import type { AccountingBasis } from '@/lib/ledger/balances';

export type { AccountingBasis };

/** 100% expressed in basis points. */
export const PERCENT_SCALE = 10_000;

/* ------------------------------------------------------------------ columns */

/**
 * What a column holds. `amount` and `variance` are cents; `percent` and
 * `variance_pct` are basis points; `text` and `date` read from `ReportRow.cells`.
 */
export type ColumnKind = 'amount' | 'percent' | 'variance' | 'variance_pct' | 'text' | 'date';

/** How the range is cut into columns. */
export type ColumnMode = 'total' | 'months' | 'quarters' | 'channels';

export const COLUMN_MODES: readonly ColumnMode[] = ['total', 'months', 'quarters', 'channels'];

/** Which block of the header a column belongs to, so the UI can rule between them. */
export type ColumnGroup = 'current' | 'compare' | 'variance' | 'detail';

export interface ColumnDef {
  key: string;
  label: string;
  kind: ColumnKind;
  /** A second, quieter line under the label — usually the window the column covers. */
  sublabel?: string;
  /** The window this column measures, for drill-down. `null` from means "since inception". */
  from?: CalendarDate | null;
  to?: CalendarDate;
  channelId?: string | null;
  /** A total or grand-total column: set in the heavier weight. */
  emphasis?: boolean;
  group?: ColumnGroup;
}

/* --------------------------------------------------------------------- rows */

/**
 * `section` and `group` are headers, `detail` is an account, `subtotal` closes a
 * block, `total` closes the statement, `ratio` is a percentage line, `error` is
 * a failed invariant and must be impossible to miss.
 */
export type RowStyle =
  | 'section'
  | 'group'
  | 'detail'
  | 'subtotal'
  | 'total'
  | 'ratio'
  | 'spacer'
  | 'note'
  | 'error';

export interface Drilldown {
  accountId?: string;
  from: CalendarDate;
  to: CalendarDate;
  channelId?: string | null;
}

export interface ReportRow {
  /** Stable within one report; React keys and CSV round-trips depend on it. */
  id: string;
  accountId?: string;
  code?: string;
  label: string;
  /** Indentation depth. 0 is a section header. */
  level: number;
  isTotal: boolean;
  isSubtotal: boolean;
  style: RowStyle;
  /** Cents, or basis points where the column or the row is a percentage. */
  values: number[];
  /** Text for `text` and `date` columns, aligned to `columns`; null elsewhere. */
  cells?: (string | null)[];
  /** Overrides the column's kind for this row — a margin line inside a money table. */
  format?: 'money' | 'percent';
  /** Column indices that render blank rather than as a figure. */
  blankColumns?: readonly number[];
  drilldown?: Drilldown;
  /** A qualification shown beside the label, e.g. why a balance was flagged. */
  note?: string;
}

/* ------------------------------------------------------------------ request */

export type CompareTo = { from: CalendarDate; to: CalendarDate } | 'prior_year' | 'prior_period';

export interface ReportRequest {
  from: CalendarDate;
  to: CalendarDate;
  columns: ColumnMode;
  basis: AccountingBasis;
  compareTo?: CompareTo;
  /** Restricts every figure to lines tagged with one of these channels. */
  channelIds?: readonly string[];
  includeZeroRows: boolean;
  /** Adds a percent-of-net-sales column. P&L only. */
  percentOfNetSales?: boolean;
}

export interface ReportMeta {
  title: string;
  /** The window, written the way it is printed at the head of a statement. */
  subtitle: string;
  from: CalendarDate;
  to: CalendarDate;
  basis: AccountingBasis;
  columns: ColumnMode;
  generatedAt: CalendarDate;
  /**
   * Anything the reader must know to trust the numbers: a basis approximation, a
   * truncated register, an ignored option. Never silently dropped.
   */
  warnings: string[];
}

export interface Report {
  columns: ColumnDef[];
  rows: ReportRow[];
  meta: ReportMeta;
}

/* ------------------------------------------------------------- value helpers */

export function zeros(count: number): number[] {
  return new Array<number>(count).fill(0);
}

/** `target += source`, in place. Both must be the same width. */
export function addInto(target: number[], source: readonly number[]): number[] {
  for (let i = 0; i < target.length; i += 1) target[i] += source[i] ?? 0;
  return target;
}

export function subtract(a: readonly number[], b: readonly number[]): number[] {
  return a.map((value, i) => value - (b[i] ?? 0));
}

export function add(a: readonly number[], b: readonly number[]): number[] {
  return a.map((value, i) => value + (b[i] ?? 0));
}

export function scale(values: readonly number[], factor: number): number[] {
  // -0 fails every identity comparison a caller makes against 0.
  return values.map((value) => (value === 0 ? 0 : value * factor));
}

export function isAllZero(values: readonly number[]): boolean {
  return values.every((value) => value === 0);
}

/**
 * `numerator / denominator` in basis points, rounded half away from zero.
 *
 * A zero denominator yields 0: a margin on no sales is not a number, and a
 * report is not the place to argue about it. The denominator is taken as a
 * magnitude, so in the rare month where net sales are negative the ratio keeps
 * the sign of the numerator and a loss still reads as a loss.
 */
export function basisPoints(numerator: number, denominator: number): number {
  if (denominator === 0 || numerator === 0) return 0;
  const scaled = (numerator * PERCENT_SCALE) / Math.abs(denominator);
  return Math.sign(scaled) * Math.round(Math.abs(scaled));
}

export function ratioRowValues(
  numerator: readonly number[],
  denominator: readonly number[],
): number[] {
  return numerator.map((value, i) => basisPoints(value, denominator[i] ?? 0));
}

/** Formats basis points for display: `42.50%`, `-8.10%`. */
export function formatBasisPoints(points: number, options: { sign?: boolean } = {}): string {
  const negative = points < 0;
  const abs = Math.abs(points);
  const whole = Math.floor(abs / 100);
  const fraction = String(abs % 100).padStart(2, '0');
  const sign = negative ? '−' : options.sign && points > 0 ? '+' : '';
  return `${sign}${whole}.${fraction}%`;
}

/** Plain text for a spreadsheet: no percent sign, no minus glyph tricks. */
export function formatBasisPointsPlain(points: number): string {
  const negative = points < 0;
  const abs = Math.abs(points);
  return `${negative ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Whether a given cell reads as a percentage rather than as money. */
export function cellIsPercent(column: ColumnDef, row: ReportRow): boolean {
  if (column.kind === 'text' || column.kind === 'date') return false;
  if (column.kind === 'percent' || column.kind === 'variance_pct') return true;
  return row.format === 'percent';
}

export function cellIsBlank(row: ReportRow, index: number): boolean {
  return row.blankColumns !== undefined && row.blankColumns.includes(index);
}

/* --------------------------------------------------------------- row builders */

export interface RowInit extends Omit<Partial<ReportRow>, 'id' | 'label' | 'values'> {
  id: string;
  label: string;
  values: number[];
}

/** Fills in the flags that follow from the style, so callers state one thing. */
export function row(init: RowInit): ReportRow {
  const style = init.style ?? 'detail';
  return {
    level: 0,
    isTotal: style === 'total',
    isSubtotal: style === 'subtotal',
    ...init,
    style,
  };
}

export function sectionRow(id: string, label: string, width: number, level = 0): ReportRow {
  return row({ id, label, level, values: zeros(width), style: 'section' });
}

export function spacerRow(id: string, width: number): ReportRow {
  return row({ id, label: '', values: zeros(width), style: 'spacer' });
}

/* ---------------------------------------------------------------- account tree */

export interface AccountNodeLite {
  account: Account;
  children: AccountNodeLite[];
}

export interface AccountIndex {
  byId: ReadonlyMap<string, Account>;
  byCode: ReadonlyMap<string, Account>;
  childrenOf: ReadonlyMap<string, readonly Account[]>;
  roots: readonly Account[];
  /** The top-most ancestor of an account — how a report decides which statement section it is in. */
  rootOf(accountId: string): Account;
}

/**
 * Indexes the live chart of accounts for report building.
 *
 * Reports classify by root ancestor rather than by code range: the numbering is
 * a convention, the parent link is the contract, and an account added after the
 * seed still lands in the right section as long as it is parented correctly.
 */
export function indexAccounts(rows: readonly Account[]): AccountIndex {
  const byId = new Map<string, Account>();
  const byCode = new Map<string, Account>();
  for (const account of rows) {
    byId.set(account.id, account);
    byCode.set(account.code, account);
  }

  const children = new Map<string, Account[]>();
  const roots: Account[] = [];
  for (const account of rows) {
    const parent = account.parentId === null ? undefined : byId.get(account.parentId);
    if (parent === undefined) {
      roots.push(account);
      continue;
    }
    const siblings = children.get(parent.id);
    if (siblings) siblings.push(account);
    else children.set(parent.id, [account]);
  }

  const byCodeOrder = (a: Account, b: Account): number => a.code.localeCompare(b.code);
  roots.sort(byCodeOrder);
  for (const siblings of children.values()) siblings.sort(byCodeOrder);

  const rootCache = new Map<string, Account>();
  const rootOf = (accountId: string): Account => {
    const cached = rootCache.get(accountId);
    if (cached) return cached;

    let current = byId.get(accountId);
    if (current === undefined) {
      throw new Error(`Report asked for an account that is not in the chart: ${accountId}`);
    }
    // A cycle would hang the walk; the chart is a tree, but a report must not be
    // the thing that discovers otherwise by freezing a request.
    const seen = new Set<string>([current.id]);
    while (current.parentId !== null) {
      const parent = byId.get(current.parentId);
      if (parent === undefined || seen.has(parent.id)) break;
      seen.add(parent.id);
      current = parent;
    }
    rootCache.set(accountId, current);
    return current;
  };

  return { byId, byCode, childrenOf: children, roots, rootOf };
}

export interface EmitTreeOptions {
  index: AccountIndex;
  /** Signed balances per account, one value per column. */
  values: (accountId: string) => readonly number[] | undefined;
  width: number;
  /** +1 leaves the ledger sign alone; -1 shows a contra block as a positive deduction. */
  displaySign: 1 | -1;
  /** Restricts the tree to accounts this returns true for. Ancestors are kept for their children. */
  include?: (account: Account) => boolean;
  includeZeroRows: boolean;
  /** Drill-down window for a detail row. */
  drilldown?: (account: Account) => Drilldown | undefined;
  /** Prefix for generated row ids, so two blocks of the same tree do not collide. */
  idPrefix: string;
  /** Depth the roots are rendered at. */
  baseLevel: number;
  /**
   * Renders each root's children at `baseLevel` without the root's own header
   * and total row. Used where a statement section already names the root — a
   * P&L does not want "Cost of Goods Sold" twice.
   */
  transparentRoots?: boolean;
  out: ReportRow[];
}

/**
 * Renders an account subtree as header / children / "Total x" rows and returns
 * its rolled-up values. A block whose every figure is zero renders nothing
 * unless the reader asked for zero rows — but it still returns its total, so the
 * statement's arithmetic never depends on what was displayed.
 */
function emitNode(
  account: Account,
  level: number,
  options: EmitTreeOptions,
  out: ReportRow[],
): number[] {
  const { index, width, displaySign, include, includeZeroRows } = options;
  const kids = index.childrenOf.get(account.id) ?? [];
  const own = scale(options.values(account.id) ?? zeros(width), displaySign);
  const included = include === undefined || include(account);

  if (kids.length === 0) {
    const values = included ? own : zeros(width);
    if (!included) return values;
    if (isAllZero(values) && !includeZeroRows) return values;
    out.push(
      row({
        id: `${options.idPrefix}:${account.code}`,
        accountId: account.id,
        code: account.code,
        label: account.name,
        level,
        values,
        style: 'detail',
        drilldown: options.drilldown?.(account),
        note: account.active ? undefined : 'inactive',
      }),
    );
    return values;
  }

  const body: ReportRow[] = [];
  const total = zeros(width);

  if (included) addInto(total, emitDirect(account, level + 1, own, options, body));

  for (const child of kids) addInto(total, emitNode(child, level + 1, options, body));

  if (body.length === 0 && !includeZeroRows) return total;

  out.push(
    row({
      id: `${options.idPrefix}:${account.code}:head`,
      accountId: account.id,
      code: account.code,
      label: account.name,
      level,
      values: zeros(width),
      style: 'group',
    }),
  );
  out.push(...body);
  out.push(
    row({
      id: `${options.idPrefix}:${account.code}:total`,
      label: `Total ${account.name}`,
      level,
      values: total,
      style: 'subtotal',
    }),
  );
  return total;
}

/**
 * A rollup is a report header, so it normally carries no postings of its own. If
 * one does — a miscategorised import, a migration — the amount gets its own line
 * rather than disappearing into a subtotal nobody can reconcile.
 */
function emitDirect(
  account: Account,
  level: number,
  own: readonly number[],
  options: EmitTreeOptions,
  out: ReportRow[],
): readonly number[] {
  if (isAllZero(own)) return own;
  out.push(
    row({
      id: `${options.idPrefix}:${account.code}:direct`,
      accountId: account.id,
      code: account.code,
      label: `${account.name} — posted directly`,
      level,
      values: [...own],
      style: 'detail',
      drilldown: options.drilldown?.(account),
      note: 'posted to a rollup account',
    }),
  );
  return own;
}

/** Renders several roots as one block and returns the block's rolled-up total. */
export function emitTree(roots: readonly Account[], options: EmitTreeOptions): number[] {
  const total = zeros(options.width);

  for (const root of roots) {
    const kids = options.index.childrenOf.get(root.id) ?? [];
    if (options.transparentRoots === true && kids.length > 0) {
      const included = options.include === undefined || options.include(root);
      if (included) {
        const own = scale(options.values(root.id) ?? zeros(options.width), options.displaySign);
        addInto(total, emitDirect(root, options.baseLevel, own, options, options.out));
      }
      for (const child of kids) {
        addInto(total, emitNode(child, options.baseLevel, options, options.out));
      }
      continue;
    }
    addInto(total, emitNode(root, options.baseLevel, options, options.out));
  }

  return total;
}

/* ------------------------------------------------------------- date windows */

export interface DateWindow {
  from: CalendarDate;
  to: CalendarDate;
}

function iso(year: number, month: number, day: number): CalendarDate {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Shifts by whole years, clamping 29 February onto 28 February in a common year. */
export function shiftYears(date: CalendarDate, years: number): CalendarDate {
  const { year, month, day } = dateParts(date);
  const target = year + years;
  return iso(target, month, Math.min(day, daysInMonth(target, month)));
}

export function addMonths(date: CalendarDate, months: number): CalendarDate {
  const { year, month, day } = dateParts(date);
  const index = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(index / 12);
  const targetMonth = (index % 12) + 1;
  return iso(targetYear, targetMonth, Math.min(day, daysInMonth(targetYear, targetMonth)));
}

export function quarterOf(date: CalendarDate): number {
  return Math.floor((dateParts(date).month - 1) / 3) + 1;
}

export function quarterStart(date: CalendarDate): CalendarDate {
  const { year, month } = dateParts(date);
  return iso(year, month - ((month - 1) % 3), 1);
}

export function quarterEnd(date: CalendarDate): CalendarDate {
  return monthEnd(addMonths(quarterStart(date), 2));
}

export function yearStart(date: CalendarDate): CalendarDate {
  return iso(dateParts(date).year, 1, 1);
}

/** The day before `date`, for "everything up to the period start". */
export function dayBefore(date: CalendarDate): CalendarDate {
  const { year, month, day } = dateParts(date);
  if (day > 1) return iso(year, month, day - 1);
  if (month > 1) return iso(year, month - 1, daysInMonth(year, month - 1));
  return iso(year - 1, 12, 31);
}

/** Calendar months covering `[from, to]`, each clipped to the range's own edges. */
export function monthsBetween(from: CalendarDate, to: CalendarDate): DateWindow[] {
  const windows: DateWindow[] = [];
  let cursor = monthStart(from);
  // A misordered range yields nothing rather than looping; callers order first.
  for (let guard = 0; guard < 600 && cursor <= to; guard += 1) {
    const end = monthEnd(cursor);
    windows.push({ from: cursor > from ? cursor : from, to: end < to ? end : to });
    cursor = addMonths(cursor, 1);
  }
  return windows;
}

export function quartersBetween(from: CalendarDate, to: CalendarDate): DateWindow[] {
  const windows: DateWindow[] = [];
  let cursor = quarterStart(from);
  for (let guard = 0; guard < 200 && cursor <= to; guard += 1) {
    const end = quarterEnd(cursor);
    windows.push({ from: cursor > from ? cursor : from, to: end < to ? end : to });
    cursor = addMonths(cursor, 3);
  }
  return windows;
}

const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

export function monthLabel(date: CalendarDate): string {
  const { year, month } = dateParts(date);
  return `${MONTH_LABELS[month - 1]} ${year}`;
}

export function quarterLabel(date: CalendarDate): string {
  return `Q${quarterOf(date)} ${dateParts(date).year}`;
}

export function formatWindow(from: CalendarDate, to: CalendarDate): string {
  return `${formatLongDate(from)} – ${formatLongDate(to)}`;
}

const LONG_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function formatLongDate(date: CalendarDate): string {
  const { year, month, day } = dateParts(date);
  return `${LONG_MONTHS[month - 1]} ${day}, ${year}`;
}

/** The window a comparison asks for, resolved against the report's own range. */
export function resolveCompareWindow(request: ReportRequest): DateWindow | null {
  const { compareTo, from, to } = request;
  if (compareTo === undefined) return null;
  if (compareTo === 'prior_year') return { from: shiftYears(from, -1), to: shiftYears(to, -1) };
  if (compareTo === 'prior_period') {
    // Same number of months back, so a monthly or quarterly report compares
    // against the matching calendar window rather than a ragged day count.
    const months = monthsBetween(from, to).length;
    return { from: addMonths(from, -months), to: dayBefore(from) };
  }
  return compareTo;
}

/* --------------------------------------------------------------- presets */

export interface DatePreset {
  key: string;
  label: string;
  from: CalendarDate;
  to: CalendarDate;
}

/**
 * The ranges a bookkeeper actually asks for, anchored on a date the server
 * decides so the links do not change under the reader at midnight.
 */
export function datePresets(anchor: CalendarDate = today()): DatePreset[] {
  const thisMonth = monthStart(anchor);
  const lastMonth = addMonths(thisMonth, -1);
  return [
    { key: 'this-month', label: 'This month', from: thisMonth, to: monthEnd(anchor) },
    { key: 'last-month', label: 'Last month', from: lastMonth, to: monthEnd(lastMonth) },
    { key: 'qtd', label: 'QTD', from: quarterStart(anchor), to: anchor },
    { key: 'ytd', label: 'YTD', from: yearStart(anchor), to: anchor },
    { key: 'last-12', label: 'Last 12 months', from: addMonths(thisMonth, -11), to: monthEnd(anchor) },
    { key: 'last-year', label: 'Last year', from: yearStart(shiftYears(anchor, -1)), to: `${dateParts(anchor).year - 1}-12-31` },
  ];
}

/* ------------------------------------------------------ search-param parsing */

export type SearchParams = Record<string, string | string[] | undefined>;

function one(params: SearchParams, key: string): string | undefined {
  const value = params[key];
  if (Array.isArray(value)) return value[0];
  return value;
}

function many(params: SearchParams, key: string): string[] {
  const value = params[key];
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap((item) => item.split(',')).filter(Boolean);
  return value.split(',').filter(Boolean);
}

function readDate(params: SearchParams, key: string, fallback: CalendarDate): CalendarDate {
  const value = one(params, key);
  if (value === undefined) return fallback;
  try {
    dateParts(value);
    return value;
  } catch {
    return fallback;
  }
}

function readCompare(params: SearchParams): CompareTo | undefined {
  const value = one(params, 'compare');
  if (value === undefined || value === 'none' || value === '') return undefined;
  if (value === 'prior_year' || value === 'prior_period') return value;
  const from = one(params, 'compare_from');
  const to = one(params, 'compare_to');
  if (from === undefined || to === undefined) return undefined;
  try {
    dateParts(from);
    dateParts(to);
    return { from, to };
  } catch {
    return undefined;
  }
}

export interface ParseOptions {
  /** Default window when the URL carries none. Defaults to the current month to date. */
  defaultWindow?: DateWindow;
  defaultColumns?: ColumnMode;
  anchor?: CalendarDate;
}

/**
 * Reads a report request out of a URL. Every field falls back to something
 * sensible rather than throwing: a report page reached from a stale bookmark
 * shows this month rather than an error boundary.
 */
export function parseReportRequest(
  params: SearchParams,
  options: ParseOptions = {},
): ReportRequest {
  const anchor = options.anchor ?? today();
  const window = options.defaultWindow ?? { from: monthStart(anchor), to: anchor };

  const from = readDate(params, 'from', window.from);
  const to = readDate(params, 'to', window.to);
  const columnsRaw = one(params, 'columns');
  const columns = COLUMN_MODES.includes(columnsRaw as ColumnMode)
    ? (columnsRaw as ColumnMode)
    : (options.defaultColumns ?? 'total');
  const basis: AccountingBasis = one(params, 'basis') === 'cash' ? 'cash' : 'accrual';
  const channelIds = many(params, 'channel');

  return {
    // A reversed range is the commonest typo in a date pair; sorting it beats
    // rendering an empty statement that looks like a ledger with no activity.
    from: from <= to ? from : to,
    to: from <= to ? to : from,
    columns,
    basis,
    compareTo: readCompare(params),
    channelIds: channelIds.length > 0 ? channelIds : undefined,
    includeZeroRows: one(params, 'zeros') === '1',
    percentOfNetSales: one(params, 'pct') === '1',
  };
}

/** A link to the same report with some of the request changed. */
export function reportHref(
  path: string,
  request: ReportRequest,
  overrides: Partial<ReportRequest> = {},
): string {
  return `${path}?${reportRequestToParams({ ...request, ...overrides }).toString()}`;
}

/** Turns a request back into query-string pairs, for links and the export URL. */
export function reportRequestToParams(request: ReportRequest): URLSearchParams {
  const params = new URLSearchParams();
  params.set('from', request.from);
  params.set('to', request.to);
  params.set('basis', request.basis);
  params.set('columns', request.columns);
  if (request.compareTo !== undefined) {
    if (typeof request.compareTo === 'string') {
      params.set('compare', request.compareTo);
    } else {
      params.set('compare', 'custom');
      params.set('compare_from', request.compareTo.from);
      params.set('compare_to', request.compareTo.to);
    }
  }
  for (const id of request.channelIds ?? []) params.append('channel', id);
  if (request.includeZeroRows) params.set('zeros', '1');
  if (request.percentOfNetSales) params.set('pct', '1');
  return params;
}
