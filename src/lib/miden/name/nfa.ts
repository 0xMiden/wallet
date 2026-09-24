/**
 * Non-fungible asset (NFA) side of Miden Name.
 *
 * Ownership of a name is custody of its NFA, which the registry faucet mints.
 * This module reads the NFAs of an account vault (SDK `AssetVault.nonFungibleAssets`),
 * matches one to a label through the domain commitment, and builds the
 * registry note that publishes the record of a name (the NFA is the asset of
 * that note; the registry returns it in a P2ID note that the tracker consumes).
 *
 * Match rule: the vault key of a name NFA carries the first two felts of the
 * domain commitment in its first two limbs (the same two felts that key the
 * registry's `asset_status` and `token_to_domain` maps). A label matches an NFA
 * when the faucet is the registry and these two limbs are equal. A different
 * limb layout gives "not held", never a false positive.
 */

import {
  Account,
  AccountId,
  Felt,
  FeltArray,
  NetworkAccountTarget,
  NonFungibleAsset,
  Note,
  NoteArray,
  NoteAssets,
  NoteMetadata,
  NoteRecipient,
  NoteStorage,
  NoteTag,
  NoteType,
  TransactionRequestBuilder
} from '@miden-sdk/miden-sdk/lazy';

import { getCurrentMidenBlock } from 'lib/epoch/chain';
import { midenClientProxy } from 'lib/miden/back/miden-client-proxy';
import { randomFeeSalt } from 'lib/miden/sdk/helpers';
import { assertWasmHoldCurrent, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { initiatePublishNameRecordTransaction } from 'lib/miden/transaction/initiate';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { isDelegateProofEnabled } from 'lib/settings/helpers';

import { getMidenNameConfig, MIDEN_NAME_RECLAIM_BLOCKS, MIDEN_NAME_SLOTS, type MidenNameConfig } from './config';
import { traceRegistryStep } from './debug';
import {
  type AccountIdParts,
  type Felts4,
  decodeDomainFelts,
  encodeDomainFelts,
  REGISTRY_NOTE_ACTION,
  registryNoteInputs,
  validateMidenLabel
} from './encoding';
import {
  MidenNameInvalidLabelError,
  MidenNameNotHeldError,
  MidenNameRegistryMismatchError,
  MidenNameUnsupportedNetworkError
} from './errors';
import { type PublishNameRecordRequest, randomSerialWord, toAccountId } from './note';
import { readRegistryStorage } from './reads';
import { loadRegistryNoteScript } from './script';
import {
  domainCommitment,
  feltsFromWord,
  idParts,
  idPartsFromHex,
  isRegistryNfa,
  keyMatchesCommitment
} from './sdk-words';

/** True: the registry script is vendored and the SDK carries NFAs in notes. */
export const REGISTRY_PUBLISHING_SUPPORTED = true;

/**
 * False: clearing uses the registry actions 4..6, whose exact semantics (which
 * of the two records each one clears) are not confirmed by Digine Labs yet.
 */
export const REGISTRY_CLEARING_SUPPORTED = false;

export type DomainNfaHolding = 'held' | 'not-held';

/** Largest value of a u32. The note script reads the reclaim height as a u32. */
const U32_MAX = 4_294_967_295;

function requireConfig(): MidenNameConfig {
  const config = getMidenNameConfig();
  if (!config) throw new MidenNameUnsupportedNetworkError(getEffectiveNetworkName());
  return config;
}

/**
 * The NFA of `label` in the vault of `account`, or undefined. The returned
 * object is a borrow of the client that gave `account`; every other NFA of the
 * vault is freed here.
 */
export function findDomainNfa(
  account: Account,
  label: string,
  registry: AccountIdParts,
  registryHex: string
): NonFungibleAsset | undefined {
  const commitment = domainCommitment(label, registry);
  let found: NonFungibleAsset | undefined;
  for (const nfa of account.vault().nonFungibleAssets()) {
    if (
      found === undefined &&
      isRegistryNfa(nfa, registryHex) &&
      keyMatchesCommitment(feltsFromWord(nfa.vaultKey()), commitment)
    ) {
      found = nfa;
      continue;
    }
    nfa.free();
  }
  return found;
}

/** The vault keys of every registry NFA in the vault, as plain felts. Frees the NFAs. */
function registryNfaKeys(account: Account, registryHex: string): Felts4[] {
  const keys: Felts4[] = [];
  for (const nfa of account.vault().nonFungibleAssets()) {
    if (isRegistryNfa(nfa, registryHex)) keys.push(feltsFromWord(nfa.vaultKey()));
    nfa.free();
  }
  return keys;
}

/**
 * True when the account holds the NFA of `label`. Reads the local vault
 * snapshot under the WASM client lock; no RPC.
 */
export async function accountHoldsDomainNfa(accountId: string, label: string): Promise<DomainNfaHolding> {
  const config = requireConfig();
  const registry = idPartsFromHex(config.registryAccountIdHex);
  return withWasmClientLock(
    async hold => {
      const account = await midenClientProxy.getAccount(toAccountId(accountId).toString());
      assertWasmHoldCurrent(hold, 'miden-name-nfa-read: after the account read');
      if (!account) return 'not-held';
      const nfa = findDomainNfa(account, label, registry, config.registryAccountIdHex);
      if (!nfa) return 'not-held';
      nfa.free();
      return 'held';
    },
    { label: 'miden-name-nfa-read' }
  );
}

/**
 * The labels of every name whose NFA is in the vault of the account, from the
 * vault and the registry's `token_to_domain` map: no local registration
 * history is needed (for example after a restore). A label is listed only when
 * the commitment that the wallet computes for it matches the NFA key.
 */
export async function listOwnedDomainLabels(accountId: string): Promise<string[]> {
  const config = requireConfig();
  const registry = idPartsFromHex(config.registryAccountIdHex);
  const nfaKeys = await withWasmClientLock(
    async hold => {
      const account = await midenClientProxy.getAccount(toAccountId(accountId).toString());
      assertWasmHoldCurrent(hold, 'miden-name-nfa-list: after the account read');
      return account ? registryNfaKeys(account, config.registryAccountIdHex) : [];
    },
    { label: 'miden-name-nfa-list' }
  );
  if (nfaKeys.length === 0) return [];

  const mapKeys: Felts4[] = nfaKeys.map(key => [key[0], key[1], 0n, 0n]);
  const storage = await readRegistryStorage(
    config,
    [{ slot: MIDEN_NAME_SLOTS.tokenToDomain, keys: mapKeys }],
    'midenNameOwnedNames'
  );
  const labels: string[] = [];
  for (const key of mapKeys) {
    const label = decodeDomainFelts(storage.mapValue(MIDEN_NAME_SLOTS.tokenToDomain, key));
    if (label === null || labels.includes(label)) continue;
    if (keyMatchesCommitment(key, domainCommitment(label, registry))) labels.push(label);
  }
  return labels;
}

export interface PublishNameRecordRequestArgs {
  /** Account that owns the NFA and gets the record (bech32, composite, or 0x hex). */
  accountId: string;
  /** Label without the `.miden` suffix. */
  label: string;
}

/**
 * Build and serialize the request that publishes the record of `label`: one
 * PUBLIC registry note to the registry network account that carries the name
 * NFA and the update-records action. The note storage is
 * `[registry.prefix, registry.suffix, dw0, dw1, dw2, dw3, reclaimHeight, 3]`.
 *
 * The serial number and the fee salt are random. Thus build the request ONE
 * time and keep the bytes on the row. Throws MidenNameNotHeldError when the
 * vault has no NFA for the label.
 */
export async function buildPublishNameRecordRequest(
  args: PublishNameRecordRequestArgs
): Promise<PublishNameRecordRequest> {
  const labelError = validateMidenLabel(args.label);
  if (labelError) throw new MidenNameInvalidLabelError(args.label, labelError);
  const config = requireConfig();
  const domainWord = encodeDomainFelts(args.label);
  const action = REGISTRY_NOTE_ACTION.updateRecords;

  // A fresh RPC head, not the local sync height. This call also loads the SDK WASM.
  const builtAtBlock = await traceRegistryStep('publish.chain-tip', getCurrentMidenBlock);
  const reclaimHeight = builtAtBlock + MIDEN_NAME_RECLAIM_BLOCKS;
  if (!Number.isSafeInteger(reclaimHeight) || reclaimHeight > U32_MAX) {
    throw new RangeError(`Reclaim height ${reclaimHeight} does not fit in a u32`);
  }
  const feeSalt = randomFeeSalt();
  // The script bytes come from a static asset: fetch them BEFORE the lock.
  const script = await traceRegistryStep('publish.load-script', loadRegistryNoteScript);
  let scriptOwned = true;

  console.log('[registry-debug] publish.build-lock: waiting');
  try {
    return await withWasmClientLock(
      async hold => {
        console.log('[registry-debug] publish.build-lock: acquired');
        const account = await traceRegistryStep('publish.read-account', () =>
          midenClientProxy.getAccount(toAccountId(args.accountId).toString())
        );
        // An eviction during the read gives the mutex to a successor. The account
        // object is a borrow of that client, so stop before a read of its vault.
        assertWasmHoldCurrent(hold, 'miden-name-publish-build: after the account read');

        const registry = AccountId.fromHex(config.registryAccountIdHex);
        if (!registry.isPublic()) {
          throw new MidenNameRegistryMismatchError('the registry account is not public');
        }
        const sender = toAccountId(args.accountId);
        const nfa = account
          ? findDomainNfa(account, args.label, idParts(registry), config.registryAccountIdHex)
          : undefined;
        console.log('[registry-debug] publish.find-nfa', { accountFound: !!account, nfaFound: !!nfa });
        if (!nfa) throw new MidenNameNotHeldError(args.label);

        // The storage target is the registry. The note metadata identifies the owner.
        const inputs = registryNoteInputs(idParts(registry), domainWord, reclaimHeight, action);
        const storage = new NoteStorage(new FeltArray(inputs.map(value => new Felt(value))));
        // The recipient takes the script: from here the note owns it.
        scriptOwned = false;
        const note = Note.withAttachments(
          new NoteAssets([nfa]),
          new NoteMetadata(sender, NoteType.Public, NoteTag.withAccountTarget(registry)),
          new NoteRecipient(randomSerialWord(), script, storage),
          [new NetworkAccountTarget(registry).toAttachment()]
        );
        // Read the id BEFORE the note goes into the NoteArray: that call moves
        // the note into Rust.
        const registryNoteId = note.id().toString();
        const requestBytes = new TransactionRequestBuilder()
          .withOwnOutputNotes(new NoteArray([note]))
          .withFeeConversionSalt(feeSalt)
          .build()
          .serialize();
        console.log('[registry-debug] publish.request-built', { registryNoteId, reclaimHeight, builtAtBlock });
        return { requestBytes, registryNoteId, reclaimHeight, builtAtBlock, action };
      },
      { label: 'miden-name-publish-build' }
    );
  } catch (error) {
    // A failure before the recipient took the script leaves it with us: free it.
    if (scriptOwned) script.free();
    throw error;
  }
}

/**
 * Publish the registry record of `label` for the account: build the registry
 * note and queue a `publish-name-record` row. Returns the id of the row, for
 * the in-progress transaction page. The tracker follows the row until the
 * returned NFA is back in the vault.
 */
export async function publishRegistryRecord(accountId: string, label: string): Promise<string> {
  const request = await traceRegistryStep('publish.build-request', () =>
    buildPublishNameRecordRequest({ accountId, label })
  );
  const rowId = await traceRegistryStep('publish.queue-row', () =>
    initiatePublishNameRecordTransaction({ accountId, label, request, delegateTransaction: isDelegateProofEnabled() })
  );
  console.log('[registry-debug] publish.queued', { rowId, registryNoteId: request.registryNoteId });
  return rowId;
}
