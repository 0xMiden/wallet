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

// Shared with the cell assertions so K15 cannot hide a different adapter wrapper class.
// Keeping runtime imports JSON-only lets the mobile cells share these names without loading their journey here.
export const REFUSAL_WRAPPERS = { connect: 'WalletConnectionError', transaction: 'WalletTransactionError' };

const MOBILE_CREATE_ACCOUNT_ISSUE = 1543;
const MOBILE_CREATE_ACCOUNT_RUN = '39090853726';
// K15: each candidate cell's refusal text as the extension cell expects it (dapp-mobile-cells.ts), which the mobile
// provider keeps word for word; under the adapter the wallet's class is the cause's, on a raw call the error's own.
const PLAIN_ERROR_TEXT: Readonly<Record<string, string | RegExp>> = {
  S3: 'NOT_GRANTED',
  S6: 'NOT_GRANTED',
  'R1-send': 'NOT_GRANTED',
  'R1-custom': 'NOT_GRANTED',
  'R3-noteType': 'INVALID_PARAMS: Error: noteType is required',
  'R3-customPayload': 'INVALID_PARAMS: Error: INVALID_PARAMS: Invalid CustomTransaction payload',
  'R3-customUndecodable': /^INVALID_PARAMS: /,
  'R7-connect': 'NOT_GRANTED',
  'R7-send': 'NOT_GRANTED',
  'R7-consume': 'NOT_GRANTED',
  'R7-custom': 'NOT_GRANTED'
};
const ADAPTER_WRAPPED: Readonly<Record<string, string>> = {
  S3: REFUSAL_WRAPPERS.connect,
  'R1-send': REFUSAL_WRAPPERS.transaction,
  'R1-custom': REFUSAL_WRAPPERS.transaction,
  'R7-connect': REFUSAL_WRAPPERS.connect,
  'R7-send': REFUSAL_WRAPPERS.transaction,
  'R7-consume': REFUSAL_WRAPPERS.transaction,
  'R7-custom': REFUSAL_WRAPPERS.transaction
};
const MOBILE_PLAIN_ERROR_ISSUE = 1542;
const MOBILE_PLAIN_ERROR_RUN = '39090853726';

export const KNOWN_BUGS: readonly KnownBug[] = [
  {
    id: 'K1',
    title: 'MidenWalletAdapter never follows the provider accountChange',
    tracking: '0xMiden/web-sdk#469 (open)',
    mobileEvidenceRun: '39090853726',
    cells: { ...on(['S7', 'WP7-switch', 'WP7-revoke'], BOTH), ...on(['M1'], BOTH, ['extension', 'ios', 'android']) },
    signature: ({ cellId, source, evidence }) =>
      source === 'hard' &&
      // With no address from before the switch there is nothing the adapter could have kept.
      evidence.previousAddress !== undefined &&
      evidence.providerAddress !== evidence.previousAddress &&
      // React copies the adapter's fields on its connect event only (WalletProvider.tsx:154-170), so after a switch or
      // a revoke the context keeps the old account, still connected, as the adapter does.
      (cellId.startsWith('WP7-')
        ? evidence.reactAddress === evidence.previousAddress && evidence.reactConnected === true
        : evidence.adapterAddress === evidence.previousAddress)
  },
  {
    id: 'K11',
    title: 'A custom request whose transactionRequest cannot be deserialized opens a popup instead of being refused',
    tracking: '0xMiden/wallet#1418 (open)',
    mobileEvidenceRun: '39090853726',
    cells: on(['R3-customUndecodable'], BOTH, ['extension', 'ios', 'android']),
    // The preview swallows the deserialize failure (src/lib/miden/back/dapp.ts:2920-2931) and the popup says it could
    // not decode the request, so the refusal check sees a confirm page open.
    signature: ({ source, evidence }) => source === 'hard' && evidence.popupOpened === true
  },
  {
    id: 'K12',
    title: "adapter-react exports MidenFi's own WalletContext, so it reads no state under WalletProvider",
    tracking: '0xMiden/web-sdk#484 (open)',
    cells: on(['WP9'], BOTH),
    // index.ts:7-16 exports MidenFiSignerProvider's local context under the name useWallet.ts exports too, and only
    // the latter is the one WalletProvider fills (WalletProvider.tsx:449): useWallet() sees the connect, the export {}.
    signature: ({ source, evidence }) =>
      source === 'hard' && evidence.reactConnected === true && evidence.reactExportedConnected === null
  },
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
  },
  {
    id: 'K14',
    title:
      "The in-app browser's provider has no createAccount, so a dApp gets a TypeError, not the extension's WalletError",
    tracking: `0xMiden/wallet#${MOBILE_CREATE_ACCOUNT_ISSUE} (open)`,
    mobileEvidenceRun: MOBILE_CREATE_ACCOUNT_RUN,
    cells: on(['S11'], BOTH, ['ios', 'android']),
    // injection-script.ts defines no createAccount; the extension throws a named WalletError (midenWindowObject.ts).
    // Exactly the pinned conformance gap: one more failing case is a new bug, not this one.
    signature: ({ source, evidence }) =>
      source === 'hard' &&
      JSON.stringify(evidence.conformanceFailed ?? []) === JSON.stringify(pinned.mobileConformanceGap)
  },
  {
    id: 'K15',
    title: "The in-app browser's provider rejects every refusal as a plain Error, so a dApp cannot tell its class",
    tracking: `0xMiden/wallet#${MOBILE_PLAIN_ERROR_ISSUE} (open)`,
    mobileEvidenceRun: MOBILE_PLAIN_ERROR_RUN,
    // R3-customUndecodable opened a sheet and returned NOT_GRANTED; that is K11, not the candidate's INVALID_PARAMS.
    cells: on(
      Object.keys(PLAIN_ERROR_TEXT).filter(id => id !== 'R3-customUndecodable'),
      BOTH,
      ['ios', 'android']
    ),
    // injection-script.ts:128 rejects with `new Error(text)`: the text survives, the class the extension maps it to
    // (src/lib/adapter/client.ts createError) does not.
    signature: ({ cellId, source, evidence }) => {
      const error = evidence.dappError;
      const text = PLAIN_ERROR_TEXT[cellId];
      // C-P15 keeps class parity soft so a later row, session or decline-timing failure stays unexplained.
      if (source !== 'soft' || error === undefined || text === undefined) return false;
      const said = typeof text === 'string' ? error.message === text : text.test(error.message);
      const wrappedName = ADAPTER_WRAPPED[cellId];
      const name = wrappedName ?? 'Error';
      // Raw provider errors have no cause; an unexpected wrapper or cause is a separate regression.
      const causeName = wrappedName === undefined ? undefined : 'Error';
      return said && error.name === name && error.causeName === causeName;
    }
  }
];

/** A registry over `bugs`: an entry explains a cell only on the surface and the axis it names. */
export const registryOf = (bugs: readonly KnownBug[]): KnownBugRegistry => ({
  bugsFor: (cellId, surface, axis) =>
    bugs.filter(bug => (bug.cells[cellId] ?? []).some(at => at.surface === surface && at.axis === axis))
});

export const knownBugRegistry: KnownBugRegistry = registryOf(KNOWN_BUGS);
