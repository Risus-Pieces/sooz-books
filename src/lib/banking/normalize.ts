/**
 * Description normalisation and payee cleaning.
 *
 * `normalizeDescription` is the one function in this file that is not allowed to
 * have an opinion: it must produce, character for character, what the Postgres
 * function `normalize_description(text)` produces, because the database computes
 * `bank_transactions.description_normalized`, `vendor_aliases.alias_normalized`
 * and `bank_txn_fingerprint()` with it. If the two ever disagree, every rule and
 * every deduplication key silently stops matching. `normalize.test.ts` round-trips
 * a table of real payees through psql and asserts equality.
 *
 * `cleanPayee` is the opposite — it is purely a display and vendor-matching aid,
 * it is free to evolve, and it hands back everything it removed so the audit trail
 * keeps the bank's own words.
 */

// ---------------------------------------------------------------------------
// normalize_description
// ---------------------------------------------------------------------------

/**
 * The Postgres definition, transliterated:
 *
 * ```sql
 * regexp_replace(
 *   regexp_replace(
 *     regexp_replace(upper(coalesce(d, '')), '[^A-Z0-9 ]', ' ', 'g'),
 *     '\s+', ' ', 'g'),
 *   '^\s+|\s+$', '', 'g')
 * ```
 *
 * Three details make this match rather than merely resemble the original:
 *
 *  - `upper()` on this cluster performs full Unicode uppercasing, exactly like
 *    JavaScript's `toUpperCase()` — `ß` becomes `SS`, `ﬁ` becomes `FI`, the
 *    dotless `ı` becomes `I`. Verified case by case against the live database.
 *  - the class `[^A-Z0-9 ]` is applied *after* uppercasing, so every accented or
 *    non-Latin character has already collapsed to a space by the time whitespace
 *    is squeezed. `\s+` and ` +` are therefore the same collapse here.
 *  - `coalesce(d, '')` means null normalises to the empty string, not to `'NULL'`.
 */
export function normalizeDescription(text: string | null | undefined): string {
  return (text ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/ +/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// cleanPayee
// ---------------------------------------------------------------------------

export interface CleanedPayee {
  /** The payee with processor noise, reference digits and Relay suffixes removed. */
  name: string;
  /** Exactly what the bank wrote, trimmed. */
  original: string;
  /** The payment processor whose prefix was stripped: `SP`, `SP+AFF`, `TST`, `SQ`. */
  processor: string | null;
  /** A trailing reference or store number that was removed (`533300619`). */
  trailingDigits: string | null;
  /** The name from Relay's ` - Sent By <name>` suffix. */
  sentBy: string | null;
  /** The name from Relay's ` - Initiated By <name>` suffix. */
  initiatedBy: string | null;
  /** Every removed fragment, in the order removed, for the audit trail. */
  stripped: string[];
}

/**
 * Processor prefixes seen on card-network descriptors. The capture group is the
 * processor's name as it is reported back on `CleanedPayee.processor`.
 *
 * `SP+AFF * META STORE -` and `SP NATURES FLAVORS` are both Stripe-affiliated
 * card descriptors; `TST* ` is Toast; `SQ *` is Square. None of them is part of
 * the merchant's name, and leaving them in splits one vendor into several.
 */
const PROCESSOR_PREFIXES: ReadonlyArray<{ pattern: RegExp; processor: string }> = [
  { pattern: /^(SP\s*\+\s*AFF)\s*\*\s*/i, processor: 'SP+AFF' },
  { pattern: /^(TST)\s*\*\s*/i, processor: 'TST' },
  { pattern: /^(SQ)\s*\*\s*/i, processor: 'SQ' },
  { pattern: /^(SP)\s*\*\s*/i, processor: 'SP' },
  // Bare `SP ` with no star, as in `SP NATURES FLAVORS`. Requires the rest of the
  // string to carry a real name so a payee literally called "SP" survives.
  { pattern: /^(SP)\s+(?=\S{2,})/i, processor: 'SP' },
];

/** ` - Sent By Boxuan Zhao` / ` - Initiated By Unknown Payee`, Relay's own metadata. */
const SENT_BY = /\s*-\s*Sent\s+By\s+(.+?)\s*$/i;
const INITIATED_BY = /\s*-\s*Initiated\s+By\s+(.+?)\s*$/i;

/**
 * Punctuation that carries no meaning at the edge of a name.
 *
 * A trailing full stop is deliberately kept: `Jedwards International Inc.` is how
 * the vendor is spelled, and trimming it changes the company's name for a
 * cosmetic gain of nothing. It makes no difference to matching, because
 * `normalizeDescription` drops it on both sides of every comparison anyway.
 */
const LEADING_NOISE = /^[\s\-–—*|,.;:#/\\]+/;
const TRAILING_NOISE = /[\s\-–—*|,;:#/\\]+$/;

/** A token glued to a trailing reference number: `FEDEX533300619` -> `FEDEX`. */
const GLUED_DIGITS = /^(.*?[A-Za-z])(\d{4,})$/;

function trimEdges(text: string): string {
  return text.replace(LEADING_NOISE, '').replace(TRAILING_NOISE, '');
}

/**
 * True for a whole token that is a reference rather than a word: at least four
 * digits, and digits are at least half of its alphanumerics. `O*22-14335-69339`
 * qualifies (one letter, twelve digits); `LLC` and `S` do not.
 */
function isReferenceToken(token: string): boolean {
  const alnum = token.replace(/[^A-Za-z0-9]/g, '');
  if (alnum.length < 4) return false;
  const digits = alnum.replace(/\D/g, '').length;
  return digits >= 4 && digits * 2 >= alnum.length;
}

/**
 * Removes trailing reference noise from a payee.
 *
 * Runs at most three passes, because `FEDEX 533300619 0012` is a real shape and
 * one pass would leave half of it behind. Each pass either un-glues a digit run
 * from the end of the last token or drops the last token outright; anything else
 * stops the loop, so a name that genuinely ends in a word is never eaten.
 */
function stripTrailingDigits(name: string): { name: string; removed: string | null } {
  let current = name;
  const removed: string[] = [];

  for (let pass = 0; pass < 3; pass += 1) {
    const tokens = current.split(/\s+/).filter((token) => token !== '');
    if (tokens.length === 0) break;

    const last = tokens[tokens.length - 1];
    const glued = GLUED_DIGITS.exec(last);

    if (glued) {
      removed.push(glued[2]);
      tokens[tokens.length - 1] = glued[1];
      current = trimEdges(tokens.join(' '));
      continue;
    }

    // Never strip the only token away — `9726` on its own is all the payee there is.
    if (tokens.length > 1 && isReferenceToken(last)) {
      removed.push(last);
      tokens.pop();
      current = trimEdges(tokens.join(' '));
      continue;
    }

    break;
  }

  return { name: current, removed: removed.length > 0 ? removed.join(' ') : null };
}

/**
 * Cleans a bank payee for display and vendor matching, returning both the cleaned
 * name and everything that was taken off it.
 *
 * ```
 * SP+AFF * META STORE -                      -> META STORE          (processor SP+AFF)
 * FEDEX533300619                             -> FEDEX               (trailing 533300619)
 * eBay O*22-14335-69339                      -> eBay                (trailing O*22-14335-69339)
 * Blue Pacific - Sent By Boxuan Zhao         -> Blue Pacific        (sentBy Boxuan Zhao)
 * ```
 *
 * The cleaned name is never empty for a non-empty input: if every rule fires and
 * nothing is left, the trimmed original is returned and the fact is recorded in
 * `stripped`. Losing a payee entirely would be worse than leaving noise on it.
 */
export function cleanPayee(raw: string | null | undefined): CleanedPayee {
  const original = (raw ?? '').trim();
  const stripped: string[] = [];

  let name = original;
  let processor: string | null = null;
  let sentBy: string | null = null;
  let initiatedBy: string | null = null;

  const sent = SENT_BY.exec(name);
  if (sent) {
    sentBy = sent[1].trim();
    stripped.push(sent[0].trim());
    name = name.slice(0, sent.index);
  }

  const initiated = INITIATED_BY.exec(name);
  if (initiated) {
    initiatedBy = initiated[1].trim();
    stripped.push(initiated[0].trim());
    name = name.slice(0, initiated.index);
  }

  name = trimEdges(name);

  for (const { pattern, processor: label } of PROCESSOR_PREFIXES) {
    const match = pattern.exec(name);
    if (!match) continue;
    processor = label;
    stripped.push(match[0].trim());
    name = trimEdges(name.slice(match[0].length));
    break;
  }

  const digits = stripTrailingDigits(name);
  if (digits.removed !== null) stripped.push(digits.removed);
  name = trimEdges(digits.name).replace(/\s+/g, ' ');

  if (name === '' && original !== '') {
    name = trimEdges(original).replace(/\s+/g, ' ') || original;
    stripped.push('(restored: cleaning left nothing)');
  }

  return {
    name,
    original,
    processor,
    trailingDigits: digits.removed,
    sentBy,
    initiatedBy,
    stripped,
  };
}
