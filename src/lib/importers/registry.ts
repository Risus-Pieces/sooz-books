/**
 * Which importer reads this file?
 *
 * Every registered importer is asked, cheaply and in isolation, and the answers
 * are ranked. The rules are `docs/formats/README.md` §1.2, and the one that
 * matters most is the tie: **two importers must never auto-select at the same
 * confidence.** Chase checking and Chase card look almost identical and posting
 * one as the other inverts every sign in the file, so where the evidence does not
 * separate them the caller is made to ask rather than allowed to guess.
 *
 * Two tiers. The dedicated importers — Relay today; Shopify, Amazon and Faire as
 * they arrive — know their format to the byte and are ranked against each other.
 * Behind them sits one fallback, the generic bank importer, which reads any CSV or
 * XLSX statement through a column mapping. It is consulted only when no dedicated
 * importer recognised the file, so it can never outvote one; and it never writes a
 * row until a person has confirmed the mapping (see `./generic`).
 */

import type { ParsedFile } from '@/lib/banking/types';

import { genericBankImporter } from './generic';
import { plaidImporter } from './plaid';
import { relayImporter } from './relay';
import {
  AUTO_SELECT_CONFIDENCE,
  OFFER_CONFIDENCE,
  type DetectionResult,
  type ImportableRow,
  type Importer,
  type SourceFile,
} from './types';

/**
 * An importer with its row type erased.
 *
 * A registry is heterogeneous by nature and `Importer<TRow>` is invariant in
 * `TRow`, so the stored form widens the rows to the minimum the pipeline needs —
 * which is exactly `ImportableRow`, everything `bank_transactions` requires.
 * Callers that need the precise row type reach for the concrete importer
 * (`relayImporter`) and keep it.
 */
export type AnyImporter = Importer<ImportableRow>;

const REGISTRY: readonly AnyImporter[] = Object.freeze([
  relayImporter as unknown as AnyImporter,
  plaidImporter as unknown as AnyImporter,
]);

/** Asked only when no dedicated importer recognised the file. */
const FALLBACK: AnyImporter = genericBankImporter as unknown as AnyImporter;

/** Every registered importer, dedicated ones first, the fallback last. */
export function importers(): readonly AnyImporter[] {
  return [...REGISTRY, FALLBACK];
}

/** The importer with this id, or null. Never throws — an unknown id is a user error, not a crash. */
export function importerById(id: string): AnyImporter | null {
  return importers().find((importer) => importer.id === id) ?? null;
}

export type DetectionOutcome =
  /** One importer cleared the auto-select bar and no other came close. */
  | { readonly kind: 'selected'; readonly importer: AnyImporter; readonly detection: DetectionResult }
  /** Candidates worth offering, best first. The caller shows the reasons and asks. */
  | { readonly kind: 'ambiguous'; readonly candidates: readonly DetectionCandidate[] }
  /** The file was recognised and refused. `rejection` says why and what to do. */
  | { readonly kind: 'rejected'; readonly detection: DetectionResult }
  /** Nothing recognised it. */
  | { readonly kind: 'unknown'; readonly attempts: readonly DetectionResult[] };

export interface DetectionCandidate {
  readonly importer: AnyImporter;
  readonly detection: DetectionResult;
}

/** How much clear air an auto-selected importer needs over the runner-up. */
const TIE_MARGIN = 0.05;

/**
 * Runs detection across the registry and decides what the caller may do.
 *
 * A rejection outranks everything: an importer that recognised the file and
 * refused it knows something no confidence score expresses, and offering a
 * second-best parse of a file that has been through Excel is how a statement
 * gets imported with its balance column read as its amount column.
 */
export function detectImporter(file: ParsedFile, source?: SourceFile): DetectionOutcome {
  const attempts = REGISTRY.map((importer) => ({
    importer,
    detection: importer.detect(file, source),
  }));

  const rejected = attempts.find((attempt) => attempt.detection.rejection !== undefined);
  if (rejected !== undefined) return { kind: 'rejected', detection: rejected.detection };

  const ranked = attempts
    .filter((attempt) => attempt.detection.confidence >= OFFER_CONFIDENCE)
    .sort((a, b) => b.detection.confidence - a.detection.confidence);

  if (ranked.length === 0) {
    // No dedicated importer knows this file. Fall back to reading it through a
    // column mapping, if its columns can be worked out at all. Selecting it here
    // commits to nothing: the mapping is shown for confirmation and the commit is
    // refused until it has been saved.
    const fallback = FALLBACK.detect(file, source);
    if (fallback.confidence >= OFFER_CONFIDENCE) {
      return { kind: 'selected', importer: FALLBACK, detection: fallback };
    }
    return {
      kind: 'unknown',
      attempts: [...attempts.map((attempt) => attempt.detection), fallback],
    };
  }

  const best = ranked[0];
  const runnerUp = ranked[1];
  const clear =
    runnerUp === undefined ||
    best.detection.confidence - runnerUp.detection.confidence >= TIE_MARGIN;

  if (best.detection.confidence >= AUTO_SELECT_CONFIDENCE && clear) {
    return { kind: 'selected', importer: best.importer, detection: best.detection };
  }

  return {
    kind: 'ambiguous',
    candidates: ranked.map(({ importer, detection }) => ({ importer, detection })),
  };
}
