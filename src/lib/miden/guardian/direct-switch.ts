import {
  AdviceMap,
  FeltArray,
  Poseidon2,
  Signature,
  Word,
  type Felt,
  type TransactionRequest
} from '@miden-sdk/miden-sdk/lazy';
import {
  AccountInspector,
  GuardianHttpClient,
  buildUpdateGuardianTransactionRequest,
  chainAnchorToBase64,
  executeForSummary,
  isLikelyNetworkError
} from '@openzeppelin/miden-multisig-client';

import { getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { u8ToB64 } from 'lib/shared/helpers';
import type { WalletAccount } from 'lib/shared/types';

import { getSignerDetailsFromAccount } from './account';
import { registerGuardianOrigin } from './native-http';
import { guardianRegisterBackoffMs } from './serialize';
import { WalletSigner, type SignWordFunction } from './signer';
import { midenClientProxy } from '../back/miden-client-proxy';
import type { GuardianAccountProvider } from '../front/guardian-manager';
import { sameWalletAccountId } from '../sdk/helpers';
import { getMidenClient, withWasmClientLock } from '../sdk/miden-client';

/**
 * Direct on-chain guardian rotation — the fallback for when the OUTGOING
 * guardian is unreachable.
 *
 * The normal switch-guardian flow uses the outgoing guardian's HTTP API as a
 * coordination mailbox (proposal storage + signature accumulation via
 * `pushDeltaProposal` / `signDeltaProposal`, and even `MultisigClient.load`
 * needs its `getState`). None of that is cryptographically required: the
 * on-chain `update_guardian` procedure is threshold-2 over the account's OWN
 * signers (hot + cold) and the SDK's own `prepareProposalExecution` deliberately
 * skips the guardian-ack signature for `switch_guardian` proposals. So when the
 * outgoing guardian is down, the wallet can build the update-guardian
 * transaction locally, sign it with hot + cold, submit it on-chain, and then
 * register the post-switch state on the NEW guardian — never touching the old
 * one.
 *
 * This module reimplements only the signature-advice-map assembly (the one
 * piece @openzeppelin/miden-multisig-client does not export — see
 * `buildSignatureAdviceEntry` in its `utils/signature.ts`); the transaction
 * build and summary execution reuse the SDK's public
 * `buildUpdateGuardianTransactionRequest` / `executeForSummary`. If upstream
 * ever exports the advice helper, the local copy below should be replaced.
 */

const MAX_DIRECT_REGISTER_RETRIES = 8;

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Is this error the outgoing guardian being UNREACHABLE (connection refused,
 * DNS, timeout, TLS, or a proxy 5xx with no guardian body) — as opposed to a
 * semantic guardian rejection? Only unreachability triggers the direct-switch
 * fallback: a reachable guardian that answers with a real error (401, 409, …)
 * keeps the normal proposal flow's error handling.
 */
export const isGuardianUnreachableError = (err: unknown): boolean => {
  if (isLikelyNetworkError(err)) return true;
  // Any 5xx also counts as the guardian being effectively down: a gateway/proxy
  // 502-504 means it could not be reached, and a 500 from the guardian itself
  // means the operator is crashing — either way it cannot serve the account.
  // Duck-typed like the other guardian error checks (see isGuardianAuthRejection)
  // so it survives duplicate-package error-class instances.
  if (typeof err !== 'object' || err === null) return false;
  const status = 'status' in err ? err.status : undefined;
  return typeof status === 'number' && status >= 500 && status <= 599;
};

const stripHexPrefix = (hex: string): string => (hex.startsWith('0x') ? hex.slice(2) : hex);

const ensureHexPrefix = (hex: string): string => (hex.startsWith('0x') ? hex : `0x${hex}`);

const hexToBytes = (hex: string): Uint8Array => {
  const clean = stripHexPrefix(hex);
  if (clean.length % 2 !== 0) {
    throw new Error(`Invalid hex string length: ${clean.length}`);
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
};

// The multisig client's auth-scheme prefix byte for ECDSA signatures
// (`ECDSA_AUTH_SCHEME_ID` in its utils/signature.ts) — `Signature.deserialize`
// dispatches on it.
const ECDSA_AUTH_SCHEME_ID = 1;

/**
 * Build one ECDSA signature advice-map entry. Local copy of the unexported
 * `buildSignatureAdviceEntry` from @openzeppelin/miden-multisig-client
 * `utils/signature.ts` (0.17 line):
 *   key    = Poseidon2(signerCommitment ‖ txCommitment)
 *   values = Signature.toPreparedSignature(txCommitment)
 * `toPreparedSignature` is the SDK binding for the Rust
 * `Signature::to_encoded_signature` — for ECDSA it emits
 * `QX[8] ‖ QY[8] ‖ SIG_R[8] ‖ SIG_S[8]`, recovering the public key from the
 * message, so the vault's signature hex must carry its recovery byte (it does:
 * the proposal flow feeds the identical `signWord` output through this same
 * SDK path).
 */
const ecdsaSignatureAdviceEntry = (
  signerCommitmentHex: string,
  txCommitmentHex: string,
  signatureHex: string
): { key: Word; values: Felt[] } => {
  const signerCommitment = Word.fromHex(ensureHexPrefix(signerCommitmentHex));
  const txCommitment = Word.fromHex(ensureHexPrefix(txCommitmentHex));
  const key = Poseidon2.hashElements(new FeltArray([...signerCommitment.toFelts(), ...txCommitment.toFelts()]));
  const sigBytes = hexToBytes(signatureHex);
  const withPrefix = new Uint8Array(sigBytes.length + 1);
  withPrefix[0] = ECDSA_AUTH_SCHEME_ID;
  withPrefix.set(sigBytes, 1);
  const signature = Signature.deserialize(withPrefix);
  return { key, values: signature.toPreparedSignature(txCommitment) };
};

/**
 * Build a fully-signed update-guardian TransactionRequest WITHOUT the outgoing
 * guardian: request + summary are built locally against a freshly-synced
 * account, the summary commitment is signed by BOTH on-device keys (hot +
 * cold — `update_guardian` is on-chain threshold-2), and the two signatures
 * are folded into the request's advice map. The result flows through the same
 * execute → prove → submit leaf as a proposal-built request.
 *
 * Since protocol 0.16 the signed summary binds the reference block commitment,
 * so the returned `chainAnchorB64` MUST be supplied to the executing
 * `executeRequest` — an unanchored execution at a later sync height derives a
 * different summary and the hot/cold signatures no longer verify.
 *
 * Only the NEW guardian is contacted (its `getPubkey` is unauthenticated), to
 * fetch the pubkey commitment the on-chain rotation installs.
 */
export const createDirectSwitchGuardianRequest = async (
  walletAccount: WalletAccount,
  newGuardianEndpoint: string,
  signWord: SignWordFunction
): Promise<{ request: TransactionRequest; chainAnchorB64: string }> => {
  const { hotPublicKey, coldPublicKey } = walletAccount;
  if (!hotPublicKey || !coldPublicKey) {
    throw new Error(
      `Guardian account ${walletAccount.publicKey} is missing hotPublicKey/coldPublicKey — re-create the wallet`
    );
  }

  registerGuardianOrigin(newGuardianEndpoint);
  const { commitment: newGuardianPubkey } = await new GuardianHttpClient(newGuardianEndpoint).getPubkey('ecdsa');

  // Build the unsigned request and execute it for its summary in ONE lock
  // scope (same rule as createReplaceHotKeyProposal): the WASM client is
  // single-threaded, and splitting resolve/build/summary across lock windows
  // leaves an aliasing gap. Sync first so the summary (and the nonce it binds)
  // is built against current on-chain state.
  //
  // Sync + account read + build + summary all use THIS realm's client — not
  // `midenClientProxy`, which on Chrome dispatches to the offscreen realm. A
  // proxy sync freshens the offscreen client while the local client that
  // `buildUpdateGuardianTransactionRequest`/`executeForSummary` run on stays
  // dormant, so the hot/cold signatures would bind a summary derived from
  // stale state and the anchored execution would fail as unauthorized —
  // precisely in the dead-old-guardian recovery this path exists for.
  const built = await withWasmClientLock(async () => {
    const midenClient = await getMidenClient();
    await midenClient.syncState();
    const account = await midenClient.getAccount(walletAccount.publicKey);
    if (!account) {
      throw new Error(`Guardian account ${walletAccount.publicKey} not found in local client`);
    }
    const accountIdHex = account.id().toString();
    const { commitment: hotCommitment } = await getSignerDetailsFromAccount(account, false);
    const { commitment: coldCommitment } = await getSignerDetailsFromAccount(account, true);
    const webClient = midenClient.client;
    const { request, salt } = await buildUpdateGuardianTransactionRequest(webClient, newGuardianPubkey, {
      signatureScheme: 'ecdsa',
      midenRpcEndpoint: getEffectiveRpcUrl()
    });
    const { summary, anchor } = await executeForSummary(webClient, accountIdHex, request, getEffectiveRpcUrl());
    const chainAnchorB64 = chainAnchorToBase64(anchor);
    anchor.free();
    return {
      hotCommitment,
      coldCommitment,
      saltHex: salt.toHex(),
      txCommitmentHex: summary.toCommitment().toHex(),
      chainAnchorB64
    };
  });

  // Sign OUTSIDE the lock — vault signing doesn't touch the WASM client, and
  // holding the global mutex across it would stall syncs for no reason.
  // `signWord` keys storage lookup by the unprefixed pubkey and signs the
  // 0x-prefixed word hex (mirrors WalletSigner.signCommitment).
  const hotSignature = await signWord(stripHexPrefix(hotPublicKey), ensureHexPrefix(built.txCommitmentHex));
  const coldSignature = await signWord(stripHexPrefix(coldPublicKey), ensureHexPrefix(built.txCommitmentHex));

  const signatureAdviceMap = new AdviceMap();
  const hotEntry = ecdsaSignatureAdviceEntry(built.hotCommitment, built.txCommitmentHex, hotSignature);
  const coldEntry = ecdsaSignatureAdviceEntry(built.coldCommitment, built.txCommitmentHex, coldSignature);
  signatureAdviceMap.insert(hotEntry.key, new FeltArray(hotEntry.values));
  signatureAdviceMap.insert(coldEntry.key, new FeltArray(coldEntry.values));

  // Rebuild with the SAME salt plus the signature advice — deterministic, so
  // the rebuilt request carries the exact summary commitment that was signed.
  const request = await withWasmClientLock(async () => {
    const webClient = (await getMidenClient()).client;
    const { request: rebuilt } = await buildUpdateGuardianTransactionRequest(webClient, newGuardianPubkey, {
      salt: Word.fromHex(ensureHexPrefix(built.saltHex)),
      signatureAdviceMap,
      signatureScheme: 'ecdsa',
      midenRpcEndpoint: getEffectiveRpcUrl()
    });
    return rebuilt;
  });
  return { request, chainAnchorB64: built.chainAnchorB64 };
};

/**
 * Post-commit finalization for a DIRECT guardian switch: register the
 * post-switch account state on the NEW guardian without a MultisigService
 * (there is none — building one would need the unreachable old guardian).
 * Mirrors `MultisigService.finalizeGuardianSwitch` +
 * `registerOnGuardianWithRetry`: fresh sync, serialize the post-switch
 * account, derive the cosigner allowlist from that SAME fresh account (never a
 * cached set), then `configure` on the new guardian with retry/backoff.
 */
export const finalizeDirectGuardianSwitch = async (
  accountId: string,
  newGuardianEndpoint: string,
  guardianProvider: GuardianAccountProvider
): Promise<void> => {
  const walletAccount = (await guardianProvider.getAccounts()).find(a => sameWalletAccountId(a.publicKey, accountId));
  if (!walletAccount?.hotPublicKey) {
    throw new Error(`Guardian account ${accountId} not found in provider (or missing hotPublicKey)`);
  }
  const hotPublicKey = walletAccount.hotPublicKey;

  const { accountIdHex, stateBase64, signerCommitments, hotCommitment } = await withWasmClientLock(async () => {
    await midenClientProxy.syncState();
    const account = await midenClientProxy.getAccount(walletAccount.publicKey);
    if (!account) {
      throw new Error(`Account ${accountId} is missing from local client`);
    }
    return {
      accountIdHex: account.id().toString(),
      stateBase64: u8ToB64(account.serialize()),
      signerCommitments: AccountInspector.fromAccount(account).signerCommitments,
      hotCommitment: (await getSignerDetailsFromAccount(account, false)).commitment
    };
  });

  // AccountInspector.fromAccount swallows per-slot read failures, so an empty
  // set means a truncated read — registering an empty allowlist would lock the
  // account out of its own new guardian (same guard as
  // reRegisterCurrentStateOnGuardian).
  if (signerCommitments.length === 0) {
    throw new Error('Refusing to register on the new guardian with an empty signer allowlist (truncated read)');
  }

  registerGuardianOrigin(newGuardianEndpoint);
  const guardian = new GuardianHttpClient(newGuardianEndpoint);
  guardian.setSigner(
    new WalletSigner(ensureHexPrefix(hotPublicKey), ensureHexPrefix(hotCommitment), guardianProvider.signWord)
  );

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_DIRECT_REGISTER_RETRIES; attempt++) {
    try {
      const response = await guardian.configure({
        accountId: accountIdHex,
        auth: { MidenEcdsa: { cosigner_commitments: signerCommitments } },
        initialState: { data: stateBase64, accountId: accountIdHex }
      });
      if (!response.success) {
        throw new Error(`Failed to register on new guardian: ${response.message}`);
      }
      return;
    } catch (error) {
      lastError = error;
      console.warn(`Direct guardian registration failed (attempt ${attempt}/${MAX_DIRECT_REGISTER_RETRIES})`, error);
      if (attempt < MAX_DIRECT_REGISTER_RETRIES) {
        await delay(guardianRegisterBackoffMs(error, attempt));
      }
    }
  }
  throw new Error('Failed to register account on the new guardian after direct switch', { cause: lastError });
};
