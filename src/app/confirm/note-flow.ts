import {
  NoteScript,
  NoteType,
  StoragePatchOperation,
  TransactionResult,
  TransactionSummary,
  type ExecutedTransaction,
  type Note,
  type OutputNote
} from '@miden-sdk/miden-sdk/lazy';

import { splitExecutedOutputNotes } from 'lib/miden/activity/fee-notes';
import { getBech32AddressFromAccountId } from 'lib/miden/sdk/helpers';
import { toNft, type NftAsset } from 'lib/miden/sdk/nft-asset';
import { b64ToU8 } from 'lib/shared/helpers';

import type { AssetAmount } from './decode';

/**
 * `StandardNote::name` in the standards library this wallet's SDK is built against.
 * A script root that matches one of these is that note. Anything else we can read is custom.
 */
const STANDARD_NOTE_NAMES = [
  'P2ID',
  'P2IDE',
  'SWAP',
  'PSWAP',
  'MINT',
  'BURN',
  'CONSTANT_FEE_POLICY_CONFIG',
  'FAUCET_POLICY_CONFIG',
  'FAUCET_METADATA_CONFIG',
  'MIN_BURN_AMOUNT_CONFIG',
  'ALLOWLIST_CONFIG',
  'BLOCKLIST_CONFIG',
  'PAUSE_CONFIG',
  'OWNER_CONFIG',
  'RBAC_CONFIG',
  'NETWORK_ACCOUNT_CONFIG',
  'UPGRADE',
  'FEE_SPONSORSHIP',
  'TX_FEE'
] as const;

export type StandardNoteName = (typeof STANDARD_NOTE_NAMES)[number];
export type NoteKind = 'fee' | 'custom' | 'unknown' | StandardNoteName;
export type NoteVisibility = 'public' | 'private' | 'unknown';

export interface NoteDetail {
  id?: string;
  kind: NoteKind;
  visibility: NoteVisibility;
  sender?: string;
  assets?: AssetAmount[];
  nfts?: NftAsset[];
  scriptRoot?: string;
}

export interface NoteFlow {
  inputCount: number;
  inputs: NoteDetail[];
  outputs: NoteDetail[];
  storageChanges?: StorageChange[];
}

export interface StorageChange {
  slotName: string;
  kind: 'value' | 'map';
  operation: 'create' | 'update' | 'remove' | 'unknown';
  entryCount?: number;
}

function attempt<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

type NamedNoteScript = NoteScript & {
  /** `StandardNote::from_script`, once the SDK exports it. Absent on older packages. */
  standardNoteName?: () => string | undefined;
};

/** Scripts the installed SDK can construct. `standardNoteName` covers the rest of `StandardNote`. */
const STANDARD_NOTE_CONSTRUCTORS: Array<[StandardNoteName, () => NoteScript]> = [
  ['P2ID', () => NoteScript.p2id()],
  ['P2IDE', () => NoteScript.p2ide()],
  ['SWAP', () => NoteScript.swap()],
  ['PSWAP', () => NoteScript.pswap()],
  ['MINT', () => NoteScript.mint()],
  ['BURN', () => NoteScript.burn()],
  ['NETWORK_ACCOUNT_CONFIG', () => NoteScript.networkAccountConfig()],
  ['FEE_SPONSORSHIP', () => NoteScript.feeSponsorship()]
];

const standardNoteNameSet = new Set<string>(STANDARD_NOTE_NAMES);
/** `StandardNote::name` is a screaming-snake token. A newer SDK may add a variant this list does not know yet. */
const STANDARD_NOTE_NAME = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/;

function isStandardNoteName(name: string): name is StandardNoteName {
  return standardNoteNameSet.has(name);
}

function kindFromReportedName(name: string): NoteKind {
  if (isStandardNoteName(name)) return name;
  if (STANDARD_NOTE_NAME.test(name)) return name as NoteKind;
  return 'custom';
}

let standardNoteRoots: Map<string, StandardNoteName> | undefined;

function rootsByStandardNote(): Map<string, StandardNoteName> | undefined {
  if (standardNoteRoots) return standardNoteRoots;
  const roots = new Map<string, StandardNoteName>();
  for (const [name, create] of STANDARD_NOTE_CONSTRUCTORS) {
    const root = attempt(() => create().root().toHex());
    if (root) roots.set(root.toLowerCase(), name);
  }
  if (roots.size === 0) return undefined;
  standardNoteRoots = roots;
  return roots;
}

function kindFromScript(script: NamedNoteScript | undefined, scriptRoot: string): NoteKind {
  // Prefer the standards library's own match. It names every StandardNote variant, including
  // TX_FEE and the config notes this package cannot construct as `NoteScript` static methods.
  if (script && typeof script.standardNoteName === 'function') {
    try {
      const name = script.standardNoteName();
      if (typeof name === 'string') return kindFromReportedName(name);
      return 'custom';
    } catch {
      return 'unknown';
    }
  }
  const roots = rootsByStandardNote();
  if (!roots) return 'unknown';
  return roots.get(scriptRoot.toLowerCase()) ?? 'custom';
}

function kindOf(note: Note | undefined): { kind: NoteKind; scriptRoot?: string } {
  const script = attempt(() => note?.script() as NamedNoteScript | undefined);
  const scriptRoot = attempt(() => script?.root().toHex());
  if (!scriptRoot) return { kind: 'unknown' };
  return { kind: kindFromScript(script, scriptRoot), scriptRoot };
}

function describe(id: string | undefined, full: Note | undefined, content: Note | OutputNote | undefined): NoteDetail {
  const metadata = content && attempt(() => content.metadata());
  const noteType = metadata && attempt(() => metadata.noteType());
  const visibility = noteType === NoteType.Public ? 'public' : noteType === NoteType.Private ? 'private' : 'unknown';
  const sender = metadata && attempt(() => getBech32AddressFromAccountId(metadata.sender()));
  const noteAssets = attempt(() => content?.assets() ?? full?.assets());
  const assets = attempt(() =>
    noteAssets?.fungibleAssets().map(asset => ({
      faucetId: getBech32AddressFromAccountId(asset.faucetId()),
      amount: asset.amount()
    }))
  );
  const nfts = attempt(() => noteAssets?.nonFungibleAssets().map(toNft));
  return { id, ...kindOf(full), visibility, sender, assets, nfts };
}

function storageOperation(operation: StoragePatchOperation): StorageChange['operation'] {
  switch (operation) {
    case StoragePatchOperation.Create:
      return 'create';
    case StoragePatchOperation.Update:
      return 'update';
    case StoragePatchOperation.Remove:
      return 'remove';
    default:
      return 'unknown';
  }
}

function storageChangesOf(transaction: TransactionSummary | ExecutedTransaction): StorageChange[] | undefined {
  const patch = attempt(() =>
    'accountDelta' in transaction ? transaction.accountDelta().storage() : transaction.accountPatch().storage()
  );
  if (!patch) return undefined;
  if (attempt(() => patch.isEmpty()) === true) return [];
  const values = attempt(() => patch.valueSlots());
  const maps = attempt(() => patch.mapSlots());
  if (!values || !maps) return undefined;
  return attempt(() => [
    ...values.map(slot => ({
      slotName: slot.slotName,
      kind: 'value' as const,
      operation: storageOperation(slot.operation)
    })),
    ...maps.map(slot => ({
      slotName: slot.slotName,
      kind: 'map' as const,
      operation: storageOperation(slot.operation),
      entryCount: attempt(() => slot.entries().length)
    }))
  ]);
}

export function noteFlowFromTransaction(transaction: TransactionSummary | ExecutedTransaction): NoteFlow {
  const inputNotes = transaction.inputNotes();
  const inputs = inputNotes.notes().map(input => {
    const id = attempt(() => input.id().toString());
    const full = attempt(() => input.note());
    return describe(id, full, full);
  });
  const { feeNote, userNotes } = splitExecutedOutputNotes(transaction);
  const toDetail = (output: OutputNote): NoteDetail =>
    describe(
      attempt(() => output.id().toString()),
      attempt(() => output.intoFull()),
      output
    );
  return {
    inputCount: inputNotes.numNotes(),
    inputs,
    storageChanges: storageChangesOf(transaction),
    outputs: [...userNotes.map(toDetail), ...(feeNote ? [{ ...toDetail(feeNote), kind: 'fee' as const }] : [])]
  };
}

export function noteFlowFromSimulatedBytes(result: {
  summaryBytes?: string;
  executedBytes?: string;
}): NoteFlow | undefined {
  if (result.summaryBytes) return noteFlowFromTransaction(TransactionSummary.deserialize(b64ToU8(result.summaryBytes)));
  if (result.executedBytes) {
    return noteFlowFromTransaction(TransactionResult.deserialize(b64ToU8(result.executedBytes)).executedTransaction());
  }
  return undefined;
}
