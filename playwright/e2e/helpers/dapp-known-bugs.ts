import type { AxisLabel, FailureEvidence } from './dapp-cells';

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
// `SummaryAnchorMismatchError` by class name or by its message (`@openzeppelin/miden-multisig-client` 0.18.0,
// `dist/transaction/summary.js:19-25`).
const ANCHOR_MISMATCH = /SummaryAnchorMismatchError|the transaction summary binds block commitment/;
// Every Guardian cell that sends a dApp-built custom request.
const GUARDIAN_CUSTOM_CELLS = ['X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'X11', 'M8-guardian'] as const;
// The consume rows of M3 and M9: consume skips the post-approval re-check that send and custom run.
const STALE_CONSUME_CELLS = [
  'M3-consume-switch',
  'M3-consume-revoke',
  'M3-consumeBytes-switch',
  'M3-consumeBytes-revoke',
  'M9-consume',
  'M9-consumeBytes'
] as const;
// M9 issues each request type from a session bound to an account that is not current.
const NON_CURRENT_CELLS = ['M9-send', 'M9-transaction', 'M9-consume', 'M9-consumeBytes', 'M9-custom'] as const;
const on = (ids: readonly string[], axes: readonly AxisLabel[]): Record<string, readonly AxisLabel[]> =>
  Object.fromEntries(ids.map(id => [id, axes]));

export const KNOWN_BUGS: readonly KnownBug[] = [
  {
    id: 'K1',
    title: 'MidenWalletAdapter never follows the provider accountChange',
    tracking: '0xMiden/web-sdk, file after the first run (Q6)',
    cells: on(['S7', 'M1'], BOTH),
    signature: ({ source, evidence }) =>
      source === 'hard' &&
      // With no address from before the switch there is nothing the adapter could have kept.
      evidence.previousAddress !== undefined &&
      evidence.providerAddress !== evidence.previousAddress &&
      evidence.adapterAddress === evidence.previousAddress
  },
  {
    id: 'K2',
    title: 'requestConsume with noteBytes of an unheld note fails after approval',
    tracking: '0xMiden/wallet, file after the first run (Q6)',
    cells: on(['W6'], BOTH),
    signature: ({ source, evidence }) =>
      source === 'hard' &&
      evidence.popupOpened === true &&
      (evidence.dappError?.message ?? '').includes('INVALID_PARAMS') &&
      (evidence.dappError?.message ?? '').includes('not found')
  },
  {
    id: 'K3',
    title: 'Guardian custom request bound below the wallet height fails at proposal (anchor mismatch)',
    tracking: 'OpenZeppelin/guardian#541 (merged), then a wallet bump to the Guardian release that carries it',
    cells: on([...GUARDIAN_CUSTOM_CELLS, 'R8'], GUARDIAN),
    signature: ({ source, evidence }) =>
      source === 'hard' &&
      evidence.rowStatus === 3 &&
      evidence.stage === 'creating-proposal' &&
      ANCHOR_MISMATCH.test(evidence.rowError ?? '')
  },
  {
    id: 'K4',
    title: 'Guardian custom preview cannot simulate a request bound below the wallet height',
    tracking: '0xMiden/wallet#1380 (open)',
    cells: on([...GUARDIAN_CUSTOM_CELLS, 'R8'], GUARDIAN),
    signature: ({ cellId, source, evidence }) =>
      (source === 'soft' && evidence.previewSimulationFailed === true) ||
      // With a spending limit set, the outgoing total the failed simulation left undefined is refused before any
      // popup (`src/lib/miden/back/dapp.ts:1651-1652`).
      (source === 'hard' &&
        cellId === 'R8' &&
        evidence.popupOpened === false &&
        evidence.dappError?.message === 'NOT_GRANTED')
  },
  {
    id: 'K5',
    title: 'Every non-connect request while locked is refused before any prompt as INVALID_PARAMS',
    tracking: '0xMiden/wallet, file after the first run (Q6); fix per Q1',
    cells: on(['S9'], BOTH),
    signature: ({ source, evidence }) =>
      source === 'hard' &&
      evidence.popupOpened === false &&
      (evidence.dappError?.message ?? '').includes('INVALID_PARAMS') &&
      (evidence.dappError?.message ?? '').includes('Wallet is locked')
  },
  {
    id: 'K6',
    title: 'An approved consume executes for an account whose authorization went stale',
    tracking: '0xMiden/wallet, file after the first run (Q6); fix per Q9',
    cells: on(STALE_CONSUME_CELLS, BOTH),
    signature: ({ source, evidence }) => source === 'hard' && evidence.staleConsumeExecuted === true
  },
  {
    id: 'K7',
    title: 'waitForTransaction has no session or origin gate',
    tracking: '0xMiden/wallet, file after the first run (Q6); fix per Q8',
    cells: on(['M7'], BOTH),
    signature: ({ source, evidence }) => source === 'hard' && evidence.crossOriginWaitServed === true
  },
  {
    id: 'K9',
    title: 'A request from a session bound to a non-current account opens a popup instead of being refused',
    tracking: '0xMiden/wallet, file after the first run (Q6); fix per Q10',
    cells: on([...NON_CURRENT_CELLS, 'M4-reads'], BOTH),
    // The cells approve the popup to see what follows: M9 a refusal after approval, or a consume that executes (K6);
    // M4-reads the dApp's own vault served.
    signature: ({ cellId, source, evidence }) =>
      source === 'hard' &&
      evidence.nonCurrentPrompted === true &&
      (cellId === 'M4-reads'
        ? evidence.nonCurrentReadLeaked === false
        : evidence.dappError?.message === 'NOT_GRANTED' ||
          (cellId.startsWith('M9-consume') && evidence.staleConsumeExecuted === true))
  },
  {
    id: 'K10',
    title: 'A note imported details-only or bare cannot be consumed or listed by the id its import returned',
    tracking: '0xMiden/wallet#1389 (open)',
    cells: on(['W5b', 'W5c', 'N4'], BOTH),
    // The consume preview and the private-note list both look the returned details commitment up as a note id
    // (`src/lib/miden/back/dapp.ts:2680-2687` and `:901, 945`), so a consume is refused before any popup.
    signature: ({ cellId, source, evidence }) =>
      source === 'hard' &&
      (cellId === 'N4'
        ? evidence.returnedIdUnlisted === true
        : evidence.popupOpened === false &&
          (evidence.dappError?.message ?? '').includes('INVALID_PARAMS') &&
          (evidence.dappError?.message ?? '').includes('could not be resolved'))
  }
];

export const knownBugRegistry: KnownBugRegistry = {
  bugsFor: (cellId, axis) => KNOWN_BUGS.filter(bug => bug.cells[cellId]?.includes(axis))
};
