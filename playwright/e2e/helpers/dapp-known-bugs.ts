import type { AxisLabel, FailureEvidence, Surface } from './dapp-cells';

/**
 * Known bugs the suite exposes (spec section 7). The assertions encode correct behaviour; a failure counts as a
 * known bug only when it matches that bug's signature for that cell, so a known-bug cell failing any other way is
 * new. An entry whose cell passes fails the judge until it is removed here.
 */
export interface FailureFacts {
  readonly cellId: string;
  /** `hard` is the error that stopped the cell; `soft` is a check it recorded with `softFail` and went on. */
  readonly source: 'hard' | 'soft';
  readonly text: string;
  readonly evidence: FailureEvidence;
}

/** One place a known bug is red: an axis on a surface. */
export interface CellPlacement {
  readonly axis: AxisLabel;
  readonly surface: Surface;
}

export interface KnownBug {
  readonly id: string;
  readonly title: string;
  /** Where the fix lives; the entry goes when it lands. */
  readonly tracking: string;
  /** Each affected cell and where it is red; a phase-1 entry covers a mobile cell only once a mobile run showed it. */
  readonly cells: Readonly<Record<string, readonly CellPlacement[]>>;
  /** The e2e-dapp.yml run id whose records showed this signature on iOS or Android; set once any placement is mobile. */
  readonly mobileEvidenceRun?: string;
  /** True only for this bug's failure, so the same cell failing any other way stays new. */
  signature(facts: FailureFacts): boolean;
}

export interface KnownBugRegistry {
  bugsFor(cellId: string, surface: Surface, axis: AxisLabel): readonly KnownBug[];
}

// The adapter's wrapper class for each refusal kind, shared with the cell assertions.
// Keeping runtime imports JSON-only lets the mobile cells share these names without loading their journey here.
export const REFUSAL_WRAPPERS = { connect: 'WalletConnectionError', transaction: 'WalletTransactionError' };

export const KNOWN_BUGS: readonly KnownBug[] = [];

/** A registry over `bugs`: an entry explains a cell only on the surface and the axis it names. */
export const registryOf = (bugs: readonly KnownBug[]): KnownBugRegistry => ({
  bugsFor: (cellId, surface, axis) =>
    bugs.filter(bug => (bug.cells[cellId] ?? []).some(at => at.surface === surface && at.axis === axis))
});

export const knownBugRegistry: KnownBugRegistry = registryOf(KNOWN_BUGS);
