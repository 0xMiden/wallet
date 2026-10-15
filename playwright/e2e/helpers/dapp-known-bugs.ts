import type { AxisLabel, FailureEvidence } from './dapp-cells';
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

export interface KnownBug {
  readonly id: string;
  readonly title: string;
  /** Where the fix lives; the entry goes when it lands. */
  readonly tracking: string;
  /** Each affected cell id and the axes it is red on. */
  readonly cells: Readonly<Record<string, readonly AxisLabel[]>>;
  /** True only for this bug's failure, so the same cell failing any other way stays new. */
  signature(facts: FailureFacts): boolean;
}

export interface KnownBugRegistry {
  bugsFor(cellId: string, axis: AxisLabel): readonly KnownBug[];
}

const BOTH: readonly AxisLabel[] = ['offchain', 'guardian'];
const GUARDIAN: readonly AxisLabel[] = ['guardian'];
const on = (ids: readonly string[], axes: readonly AxisLabel[]): Record<string, readonly AxisLabel[]> =>
  Object.fromEntries(ids.map(id => [id, axes]));

export const KNOWN_BUGS: readonly KnownBug[] = [
  {
    id: 'K1',
    title: 'MidenWalletAdapter never follows the provider accountChange',
    tracking: '0xMiden/web-sdk#469 (open)',
    cells: on(['S7', 'M1'], BOTH),
    signature: ({ source, evidence }) =>
      source === 'hard' &&
      // With no address from before the switch there is nothing the adapter could have kept.
      evidence.previousAddress !== undefined &&
      evidence.providerAddress !== evidence.previousAddress &&
      evidence.adapterAddress === evidence.previousAddress
  },
  {
    id: 'K5',
    title: 'Send, consume, custom and note or asset reads while locked are refused before any prompt as INVALID_PARAMS',
    tracking: '0xMiden/wallet#1414 (open)',
    cells: on(['S9'], BOTH),
    signature: ({ source, evidence }) =>
      source === 'hard' &&
      evidence.popupOpened === false &&
      (evidence.dappError?.message ?? '').includes('INVALID_PARAMS') &&
      (evidence.dappError?.message ?? '').includes('Wallet is locked')
  },
  {
    id: 'K8',
    title:
      'Guardian signBytes(signingInputs) fails after approval with an opaque keystore miss instead of signing with the hot key',
    tracking: '0xMiden/wallet#1417 (open)',
    cells: on(['G2a', 'G2b', 'G2c'], GUARDIAN),
    // Only a `word` reaches the hot key (src/lib/miden/back/vault.ts:2227); signingInputs reads the keystore under the
    // connect commitment (:2250), which the hot key is not stored under, and the dApp gets the miss as INVALID_PARAMS.
    signature: ({ source, evidence }) =>
      source === 'hard' &&
      evidence.popupOpened === true &&
      evidence.dappError?.causeName === 'InvalidParamsMidenWalletError' &&
      (evidence.dappError?.message ?? '').includes(pinned.texts.G2.guardian.error)
  },
  {
    id: 'K10',
    title: 'A note imported details-only or bare cannot be consumed or listed by the id its import returned',
    tracking: '0xMiden/wallet#1389 (open)',
    cells: on(['W5b', 'W5c', 'N4'], BOTH),
    // The consume preview and the private-note list both look the returned details commitment up as a note id
    // (`src/lib/miden/back/dapp.ts:2732-2739` and `:909, 953`), so a consume is refused before any popup.
    signature: ({ cellId, source, evidence }) =>
      source === 'hard' &&
      (cellId === 'N4'
        ? evidence.returnedIdUnlisted === true
        : evidence.popupOpened === false &&
          (evidence.dappError?.message ?? '').includes('INVALID_PARAMS') &&
          (evidence.dappError?.message ?? '').includes('could not be resolved'))
  },
  {
    id: 'K11',
    title: 'A custom request whose transactionRequest cannot be deserialized opens a popup instead of being refused',
    tracking: '0xMiden/wallet#1418 (open)',
    cells: on(['R3-customUndecodable'], BOTH),
    // The preview swallows the deserialize failure (src/lib/miden/back/dapp.ts:2920-2931) and the popup says it could
    // not decode the request, so the refusal check sees a confirm page open.
    signature: ({ source, evidence }) => source === 'hard' && evidence.popupOpened === true
  }
];

export const knownBugRegistry: KnownBugRegistry = {
  bugsFor: (cellId, axis) => KNOWN_BUGS.filter(bug => bug.cells[cellId]?.includes(axis))
};
