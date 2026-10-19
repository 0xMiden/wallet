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
const on = (ids: readonly string[], axes: readonly AxisLabel[]): Record<string, readonly AxisLabel[]> =>
  Object.fromEntries(ids.map(id => [id, axes]));

export const KNOWN_BUGS: readonly KnownBug[] = [
  {
    id: 'K1',
    title: 'MidenWalletAdapter never follows the provider accountChange',
    tracking: '0xMiden/web-sdk#469 (open)',
    cells: on(['S7', 'M1', 'WP7-switch', 'WP7-revoke'], BOTH),
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
  }
];

export const knownBugRegistry: KnownBugRegistry = {
  bugsFor: (cellId, axis) => KNOWN_BUGS.filter(bug => bug.cells[cellId]?.includes(axis))
};
