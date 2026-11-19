import type { AxisLabel, FailureEvidence, Surface } from './dapp-cells';
import pinned from './dapp-pinned.json';

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

const BOTH: readonly AxisLabel[] = ['offchain', 'guardian'];
const EXTENSION: readonly Surface[] = ['extension'];
const on = (
  ids: readonly string[],
  axes: readonly AxisLabel[],
  surfaces: readonly Surface[] = EXTENSION
): Record<string, readonly CellPlacement[]> =>
  Object.fromEntries(ids.map(id => [id, surfaces.flatMap(surface => axes.map(axis => ({ axis, surface })))]));

// The adapter's wrapper class for each refusal kind, shared with the cell assertions.
// Keeping runtime imports JSON-only lets the mobile cells share these names without loading their journey here.
export const REFUSAL_WRAPPERS = { connect: 'WalletConnectionError', transaction: 'WalletTransactionError' };

export const KNOWN_BUGS: readonly KnownBug[] = [
  {
    id: 'K13',
    title:
      'MidenFiSignerProvider cannot set up its signer account for a private wallet account, so MidenProvider never readies',
    tracking: '0xMiden/web-sdk#400 (open)',
    cells: on(['MF3'], BOTH),
    // importAccountId is the wallet's raw address (MidenFiSignerProvider.tsx:712) and initializeSignerAccount tolerates
    // only two import errors (@miden-sdk/react index.mjs:435-451). The settled error names the account id between its
    // pinned parts, so each part is matched on its own.
    signature: ({ source, evidence }) =>
      source === 'hard' &&
      Object.values(pinned.texts.MF3).some(({ error, reason }) =>
        [error, reason].every(part => part.length > 0 && (evidence.signerInitError ?? '').includes(part))
      )
  }
];

/** A registry over `bugs`: an entry explains a cell only on the surface and the axis it names. */
export const registryOf = (bugs: readonly KnownBug[]): KnownBugRegistry => ({
  bugsFor: (cellId, surface, axis) =>
    bugs.filter(bug => (bug.cells[cellId] ?? []).some(at => at.surface === surface && at.axis === axis))
});

export const knownBugRegistry: KnownBugRegistry = registryOf(KNOWN_BUGS);
