/**
 * Builds the transaction request that registers a Miden Name.
 */

import {
  AccountId,
  Felt,
  FeltArray,
  NetworkAccountTarget,
  Note,
  NoteArray,
  NoteAssets,
  NoteMetadata,
  NoteRecipient,
  NoteStorage,
  NoteTag,
  NoteType,
  TransactionRequestBuilder,
  Word
} from '@miden-sdk/miden-sdk/lazy';

import { getCurrentMidenBlock } from 'lib/epoch/chain';
import { midenClientProxy } from 'lib/miden/back/miden-client-proxy';
import {
  accountIdStringToSdk,
  getBech32AddressFromAccountId,
  randomFeeSalt,
  resolveHeldFungibleAsset
} from 'lib/miden/sdk/helpers';
import { assertWasmHoldCurrent, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';

import { getMidenNameConfig, MIDEN_NAME_RECLAIM_BLOCKS } from './config';
import { encodeDomainFelts, registerNoteInputs, validateMidenLabel } from './encoding';
import { MidenNameInvalidLabelError, MidenNameRegistryMismatchError, MidenNameUnsupportedNetworkError } from './errors';
import { loadRegisterDomainScript } from './script';
import { idParts } from './sdk-words';

/** Largest value of a u32. The note script reads the reclaim height as a u32. */
const U32_MAX = 4_294_967_295;

export interface RegisterNameRequestArgs {
  /** Account of the payer (bech32, composite `<address>_<suffix>`, or 0x hex). */
  senderAccountId: string;
  /** Label without the `.miden` suffix. */
  label: string;
  /** Price in base units of the payment token, from a fresh quote. */
  priceBaseUnits: bigint;
}

export interface RegisterNameRequest {
  /** Serialized `TransactionRequest`. Keep these bytes on the row and use them for all attempts. */
  requestBytes: Uint8Array;
  /** Id (hex) of the register note in the request. */
  registrationNoteId: string;
  /** Block after which the payer can reclaim the register note. */
  reclaimHeight: number;
  /** Chain tip at the time of the build. */
  builtAtBlock: number;
}

/**
 * Parse a wallet account identifier into an SDK `AccountId`. Accepts bech32,
 * the composite `<address>_<suffix>` form (only the address part is the id),
 * and 0x hex. Same rule as the Epoch collateral note builder.
 */
export function toAccountId(id: string): AccountId {
  const address = id.split('_')[0] ?? id;
  if (address.startsWith('0x')) {
    return AccountId.fromHex(address);
  }
  return accountIdStringToSdk(address);
}

export interface RegisterNameRowAccounts {
  network: string;
  /** Payment faucet (native MIDEN), bech32. */
  paymentFaucetId: string;
  /** Registry network account, bech32. */
  registryAccountId: string;
}

/**
 * The bech32 ids that a `register-name` row stores, for the effective network.
 * The caller must load the SDK WASM first (a quote or a build does this).
 */
export function registerNameRowAccounts(): RegisterNameRowAccounts {
  const config = getMidenNameConfig();
  if (!config) throw new MidenNameUnsupportedNetworkError(getEffectiveNetworkName());
  return {
    network: config.network,
    paymentFaucetId: getBech32AddressFromAccountId(AccountId.fromHex(config.paymentFaucetIdHex)),
    registryAccountId: getBech32AddressFromAccountId(AccountId.fromHex(config.registryAccountIdHex))
  };
}

export interface PublishNameRecordRequest {
  /** Serialized `TransactionRequest`. Keep these bytes on the row and use them for all attempts. */
  requestBytes: Uint8Array;
  /** Id (hex) of the registry note in the request. */
  registryNoteId: string;
  /** Block after which the sender can reclaim the registry note. */
  reclaimHeight: number;
  /** Chain tip at the time of the build. */
  builtAtBlock: number;
  /** Registry note action code. */
  action: bigint;
}

export interface PublishNameRowAccounts {
  network: string;
  /** Registry network account (also the NFA faucet), bech32. */
  registryAccountId: string;
}

/**
 * The bech32 ids that a `publish-name-record` row stores, for the effective
 * network. The caller must load the SDK WASM first (a build does this).
 */
export function publishNameRowAccounts(): PublishNameRowAccounts {
  const config = getMidenNameConfig();
  if (!config) throw new MidenNameUnsupportedNetworkError(getEffectiveNetworkName());
  return {
    network: config.network,
    registryAccountId: getBech32AddressFromAccountId(AccountId.fromHex(config.registryAccountIdHex))
  };
}

/** A random serial number for the register note. Each felt is below the field modulus. */
export function randomSerialWord(): Word {
  const raw = new BigUint64Array(4);
  crypto.getRandomValues(raw);
  return Word.newFromFelts(Array.from(raw, value => new Felt(value & 0x7fff_ffff_ffff_ffffn)));
}

/**
 * Build and serialize the request that registers `label`: one PUBLIC note to
 * the registry network account that holds `priceBaseUnits` of the payment
 * token. The note storage is
 * `[reg.prefix, reg.suffix, dw0, dw1, dw2, dw3, reclaimHeight]`.
 *
 * The serial number and the fee salt are random. Thus build the request ONE
 * time and keep the bytes on the row: retries and the guardian propose/sign
 * path must use the same bytes, so that the note id stays the same.
 *
 * The request declares no foreign account. The auth fee payment of the sender
 * adds the sponsorship note for the network note.
 */
export async function buildRegisterNameRequest(args: RegisterNameRequestArgs): Promise<RegisterNameRequest> {
  const labelError = validateMidenLabel(args.label);
  if (labelError) throw new MidenNameInvalidLabelError(args.label, labelError);
  const config = getMidenNameConfig();
  if (!config) throw new MidenNameUnsupportedNetworkError(getEffectiveNetworkName());
  const domainWord = encodeDomainFelts(args.label);

  // A fresh RPC head, not the local sync height. This call also loads the SDK
  // WASM before the code below makes SDK objects.
  const builtAtBlock = await getCurrentMidenBlock();
  const reclaimHeight = builtAtBlock + MIDEN_NAME_RECLAIM_BLOCKS;
  if (!Number.isSafeInteger(reclaimHeight) || reclaimHeight > U32_MAX) {
    throw new RangeError(`Reclaim height ${reclaimHeight} does not fit in a u32`);
  }
  const feeSalt = randomFeeSalt();
  // The script bytes come from a static asset. Fetch them BEFORE the lock, so
  // that a slow fetch does not park the client. The script is a plain SDK
  // object, not a client call, so it needs no lock.
  const script = await loadRegisterDomainScript();
  let scriptOwned = true;

  try {
    return await withWasmClientLock(
      async hold => {
        const senderAccount = await midenClientProxy.getAccount(toAccountId(args.senderAccountId).toString());
        // An eviction during the read gives the mutex to a successor. The account
        // object is a borrow of that client, so stop before a read of its vault.
        // This hold only builds the request; nothing is submitted, so a stop is safe.
        assertWasmHoldCurrent(hold, 'miden-name-register-build: after the sender account read');

        const registry = AccountId.fromHex(config.registryAccountIdHex);
        if (!registry.isPublic()) {
          throw new MidenNameRegistryMismatchError('the registry account is not public');
        }
        const sender = toAccountId(args.senderAccountId);
        const asset = resolveHeldFungibleAsset(
          senderAccount ?? undefined,
          config.paymentFaucetIdHex,
          args.priceBaseUnits
        );
        const inputs = registerNoteInputs(idParts(registry), domainWord, reclaimHeight);
        const storage = new NoteStorage(new FeltArray(inputs.map(value => new Felt(value))));
        // The recipient takes the script: from here the note owns it.
        scriptOwned = false;
        const note = Note.withAttachments(
          new NoteAssets([asset]),
          new NoteMetadata(sender, NoteType.Public, NoteTag.withAccountTarget(registry)),
          new NoteRecipient(randomSerialWord(), script, storage),
          [new NetworkAccountTarget(registry).toAttachment()]
        );
        // Read the id BEFORE the note goes into the NoteArray: that call moves
        // the note into Rust.
        const registrationNoteId = note.id().toString();
        // The salt goes on the builder: a finished `TransactionRequest` has no setter.
        const requestBytes = new TransactionRequestBuilder()
          .withOwnOutputNotes(new NoteArray([note]))
          .withFeeConversionSalt(feeSalt)
          .build()
          .serialize();
        return { requestBytes, registrationNoteId, reclaimHeight, builtAtBlock };
      },
      { label: 'miden-name-register-build' }
    );
  } catch (error) {
    // A failure before the recipient took the script leaves it with us: free it.
    if (scriptOwned) script.free();
    throw error;
  }
}
