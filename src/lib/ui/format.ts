/**
 * Short labels for charts and captions. Money here is still integer cents and is formatted with
 * integer arithmetic only; full amounts on screen go through <Money/>. These are for places a
 * component cannot go: SVG axis ticks, aria labels, legend captions.
 *
 * Dates are 'YYYY-MM-DD' strings, split as text — never parsed into a Date.
 */

const MINUS = "−";

export const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

function group(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** "$1,234.56" / "−$1,234.56" from cents. */
export function dollars(cents: number): string {
  const v = Math.round(cents);
  const abs = Math.abs(v);
  const body = `$${group(Math.floor(abs / 100))}.${String(abs % 100).padStart(2, "0")}`;
  return v < 0 ? `${MINUS}${body}` : body;
}

/** "$1,235" / "−$1,235": whole dollars, rounded half away from zero. */
export function wholeDollars(cents: number): string {
  const v = Math.round(cents);
  const abs = Math.abs(v);
  const whole = Math.floor((abs + 50) / 100);
  const body = `$${group(whole)}`;
  return v < 0 && whole !== 0 ? `${MINUS}${body}` : body;
}

/**
 * An axis tick: "$0", "$400", "$1,200", or "$3K" / "−$1.5K" once the step is a thousand dollars or
 * more. `stepCents` is the tick spacing, which decides the unit for every tick on the axis alike.
 */
export function axisMoney(cents: number, stepCents: number): string {
  const v = Math.round(cents);
  if (v === 0) return "$0";
  const sign = v < 0 ? MINUS : "";
  const abs = Math.abs(v);
  if (Math.abs(stepCents) >= 100_000) {
    // Thousands of dollars, to one decimal only when needed: 150000 cents → 1.5K.
    const tenths = Math.round(abs / 10_000);
    const whole = Math.floor(tenths / 10);
    const frac = tenths % 10;
    return `${sign}$${group(whole)}${frac === 0 ? "" : `.${frac}`}K`;
  }
  return `${sign}${wholeDollars(abs)}`;
}

function parts(date: string): { year: number; month: number; day: number } {
  const [y, m, d] = date.split("-");
  return { year: Number(y), month: Number(m), day: Number(d) };
}

/** '2026-09-29' → "Sep 29". */
export function shortDate(date: string): string {
  const { month, day } = parts(date);
  return `${MONTHS_SHORT[month - 1] ?? "—"} ${day}`;
}

/** '2026-09-29' → "Sep 29, 2026". */
export function mediumDate(date: string): string {
  const { year } = parts(date);
  return `${shortDate(date)}, ${year}`;
}

/** 9 → "Sep". */
export function monthShort(month: number): string {
  return MONTHS_SHORT[month - 1] ?? "—";
}

/** 9 → "September". */
export function monthLong(month: number): string {
  return MONTHS_LONG[month - 1] ?? "—";
}

/** 9 → "S": the phone axis. */
export function monthInitial(month: number): string {
  return monthShort(month).slice(0, 1);
}

/** Whole days from `from` to `to`, both 'YYYY-MM-DD'. Pure calendar arithmetic, no time zone. */
export function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

/** Days since 1970-01-01 for a calendar date (proleptic Gregorian), without a Date object. */
export function dayNumber(date: string): number {
  const { year, month, day } = parts(date);
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Up to two initials for a monogram: "Dave's Hot Chicken" → "DH", "FedEx" → "F". */
export function initials(name: string): string {
  const words = name
    .replace(/'s\b/gi, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  return words
    .slice(0, 2)
    .map((w) => w[0] ?? "")
    .join("")
    .toUpperCase();
}
