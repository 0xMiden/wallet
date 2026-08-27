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

import { assertGuardianKeyCommitment, getGuardianCommitmentFromAccount, getSignerDetailsFromAccount } from './account';
import { registerGuardianOrigin } from './native-http';
import { guardianRegisterBackoffMs } from './serialize';
import { WalletSigner, type SignWordFunction } from './signer';
import { midenClientProxy } from '../back/miden-client-proxy';
import { isOperationAbortedError } from '../back/offscreen-codec';
import type { GuardianAccountProvider } from '../front/guardian-manager';
import { freeChainAnchor } from '../sdk/chain-anchor';
import { sameWalletAccountId } from '../sdk/helpers';
import { getMidenClient, withWasmClientLock } from '../sdk/miden-client';
import { isWasmClientPoisonedError } from '../sdk/wasm-client-poison';

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
  // A local realm KILL is not evidence about the guardian, and it must never
  // reach the fallback: both errors mean "the operation was torn down from
  // outside with its outcome unknown", so treating one as an outage would swap
  // a coordinated proposal against a HEALTHY guardian for a fresh on-chain
  // write. Checked first because `isLikelyNetworkError` is a message-substring
  // heuristic that matches the bare token `abort` — which every
  // `OperationAbortedError` carries ("Offscreen operation … aborted (…)"),
  // including the purely local `deadline` / `transport` / `doc-closed` kills.
  // The two are classified together on purpose: `WasmClientPoisonedError` keeps
  // foreign text off its message precisely so text heuristics can't reach it,
  // so it does NOT match today, and this pins that asymmetry shut rather than
  // leaving it to the wording of a message.
  if (isOperationAbortedError(err) || isWasmClientPoisonedError(err)) return false;

  // A numeric `status` means the guardian ANSWERED, so the answer decides and
  // the message is never consulted: any 5xx counts as effectively down (a
  // gateway 502-504 could not reach it, a 500 means the operator is crashing),
  // everything else is a reachable guardian with a semantic rejection.
  //
  // This ordering is load-bearing, not stylistic. `GuardianHttpError.message`
  // interpolates two attacker-chosen strings — the HTTP reason phrase and the
  // body's `message` field — and `isLikelyNetworkError` is a substring match
  // over `connection` / `abort` / `timeout` / `dns`. Consulting the text first
  // would let a reachable guardian answering `403 {"message":"connection reset
  // by peer"}` classify ITSELF as unreachable and hand the wallet an on-chain
  // rotation the user did not ask for. It also mis-fires by accident on any
  // honest operator whose error copy happens to contain one of those words.
  // Duck-typed like the other guardian error checks (see isGuardianAuthRejection)
  // so it survives duplicate-package error-class instances.
  if (typeof err === 'object' && err !== null && 'status' in err && typeof err.status === 'number') {
    return err.status >= 500 && err.status <= 599;
  }

  // A body that failed to PARSE carries no status — the guardian client calls
  // `response.json()` on any 2xx — yet V8 embeds the offending body prefix in the
  // `SyntaxError` message. That is the same attacker-chosen text the ordering
  // above exists to keep away from the heuristic, arriving by a different door,
  // and it decides in both directions: a body beginning `connection reset…`
  // matches, while the far likelier captive-portal or CDN reply beginning
  // `<html>502…` does not — so a genuinely dead operator would be read as a
  // reachable one and the fallback would never fire.
  //
  // Decide it structurally instead. A 2xx whose body is not JSON is not a
  // guardian answering, whatever the bytes say, so it belongs with the transport
  // failures; and this way no response content reaches the substring match.
  if (err instanceof SyntaxError) return true;

  // No status: a transport failure that never reached an HTTP response, which is
  // the only case where the message is the sole evidence available.
  return isLikelyNetworkError(err);
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
 *
 * That commitment is also RETURNED, because it is the only local way to ask the
 * chain afterwards whether this rotation actually landed: the caller compares it
 * against the account's on-chain guardian commitment when the commit wait ends
 * without a verdict. Re-fetching it from the endpoint at that point would be a
 * second chance to get a different answer from a host that is already suspect.
 */
export const createDirectSwitchGuardianRequest = async (
  walletAccount: WalletAccount,
  newGuardianEndpoint: string,
  signWord: SignWordFunction
): Promise<{ request: TransactionRequest; chainAnchorB64: string; newGuardianPubkey: string }> => {
  const { hotPublicKey, coldPublicKey } = walletAccount;
  if (!hotPublicKey || !coldPublicKey) {
    throw new Error(
      `Guardian account ${walletAccount.publicKey} is missing hotPublicKey/coldPublicKey — re-create the wallet`
    );
  }

  registerGuardianOrigin(newGuardianEndpoint);
  const { commitment } = await new GuardianHttpClient(newGuardianEndpoint).getPubkey('ecdsa');
  // Validate before it becomes MASM: this value is unchecked wire data and the
  // SDK splices it into transaction-script SOURCE. See
  // `assertGuardianKeyCommitment`.
  const newGuardianPubkey = assertGuardianKeyCommitment(commitment, newGuardianEndpoint);

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
    // `freeChainAnchor` in a `finally`, like every other anchor site (#784): the
    // anchor carries a partial blockchain, so it must not leak if the
    // serialization below throws, and wasm-bindgen's `free()` has no
    // null-pointer guard — on a disposed module it throws, and a bare `free()`
    // in this position would surface that instead of the successful build.
    try {
      return {
        hotCommitment,
        coldCommitment,
        saltHex: salt.toHex(),
        txCommitmentHex: summary.toCommitment().toHex(),
        chainAnchorB64: chainAnchorToBase64(anchor)
      };
    } finally {
      freeChainAnchor(anchor);
    }
  });

  // Hot and cold must be DISTINCT on-chain signers. `getSignerDetailsFromAccount`
  // resolves cold as `commitments[1] ?? commitments[0]`, so an account carrying a
  // single signer commitment yields the hot one twice — the two advice entries
  // would then collide on one Poseidon2 key (it is derived from the signer
  // commitment), the map would hold ONE signature, and the threshold-2
  // `update_guardian` would fail on-chain as unauthorized. Say so here instead,
  // where the reason is still available.
  if (built.hotCommitment === built.coldCommitment) {
    throw new Error(
      `Guardian account ${walletAccount.publicKey} resolves the same on-chain signer commitment for hot and cold; ` +
        'a direct guardian switch needs two distinct signers to meet the update_guardian threshold'
    );
  }

  // Sign OUTSIDE the lock — vault signing doesn't touch the WASM client, and
  // holding the global mutex across it would stall syncs for no reason.
  // `signWord` keys storage lookup by the unprefixed pubkey and signs the
  // 0x-prefixed word hex (mirrors WalletSigner.signCommitment).
  const hotSignature = await signWord(stripHexPrefix(hotPublicKey), ensureHexPrefix(built.txCommitmentHex));
  const coldSignature = await signWord(stripHexPrefix(coldPublicKey), ensureHexPrefix(built.txCommitmentHex));

  // Rebuild with the SAME salt plus the signature advice — deterministic, so
  // the rebuilt request carries the exact summary commitment that was signed.
  //
  // The advice map is assembled INSIDE this lock scope, after `getMidenClient()`,
  // for the same reason `Word.fromHex(salt)` is: `AdviceMap`, `Word`,
  // `FeltArray` and `Signature` are wasm-bindgen handles into the CURRENT
  // module instance. Building them before the `await` on the lock would leave
  // them dangling if a poison eviction ran `replaceClientSingletons()` while we
  // waited — the next `extendAdviceMap` borrows a freed pointer. Everything
  // that crosses the two lock scopes is a plain hex string (`built`) precisely
  // so it survives a client replacement.
  const request = await withWasmClientLock(async () => {
    const webClient = (await getMidenClient()).client;
    const signatureAdviceMap = new AdviceMap();
    const hotEntry = ecdsaSignatureAdviceEntry(built.hotCommitment, built.txCommitmentHex, hotSignature);
    const coldEntry = ecdsaSignatureAdviceEntry(built.coldCommitment, built.txCommitmentHex, coldSignature);
    signatureAdviceMap.insert(hotEntry.key, new FeltArray(hotEntry.values));
    signatureAdviceMap.insert(coldEntry.key, new FeltArray(coldEntry.values));
    const { request: rebuilt } = await buildUpdateGuardianTransactionRequest(webClient, newGuardianPubkey, {
      salt: Word.fromHex(ensureHexPrefix(built.saltHex)),
      signatureAdviceMap,
      signatureScheme: 'ecdsa',
      midenRpcEndpoint: getEffectiveRpcUrl()
    });
    return rebuilt;
  });
  return { request, chainAnchorB64: built.chainAnchorB64, newGuardianPubkey };
};

/**
 * Does this error mean the operator already has a record of the account?
 *
 * Duck-typed on the guardian's stable machine-readable code, like every other
 * guardian error check here (see `isGuardianUnreachableError`), so it survives
 * the duplicate-package error-class instances this repo can end up with.
 */
const isGuardianAccountAlreadyRegistered = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && 'code' in err && err.code === 'account_already_exists';

const normalizedCommitment = (hex: string): string => stripHexPrefix(hex).toLowerCase();

/**
 * Ask the CHAIN whether a submitted direct rotation actually took effect.
 *
 * `true` = the account's on-chain guardian commitment is the new operator's, so
 * the rotation landed. `false` = it names something else, so it definitively did
 * NOT. `undefined` = no answer available (the sync or the account read failed, or
 * the account carries no guardian commitment at all) — which is not evidence in
 * either direction and must not be treated as one.
 *
 * This exists because the commit wait can end with no verdict, and the wallet
 * then has to decide whether to persist the new endpoint. Guessing is not
 * survivable in one of the two directions: persisting the endpoint for a rotation
 * that never landed points the vault at an operator with NO on-chain authority
 * over the account, and nothing detects it afterwards — the drift reconciler
 * compares the on-chain commitment against its own cached baseline, and in
 * exactly this case those two agree (both still name the old operator), so it
 * returns `in-sync` without ever looking at the stored endpoint. Post-commit
 * registration also succeeds against the new operator, so every subsequent sync
 * is healthy and the account looks fine right up until a transaction needs a
 * co-signature the chain will not accept.
 *
 * Reading the commitment costs one sync and one local account read, and it
 * replaces that guess with a fact in the case that matters.
 */
export const didDirectSwitchLand = async (
  accountId: string,
  newGuardianPubkey: string
): Promise<boolean | undefined> => {
  try {
    const onChain = await withWasmClientLock(async () => {
      await midenClientProxy.syncState();
      const account = await midenClientProxy.getAccount(accountId);
      return account ? getGuardianCommitmentFromAccount(account) : undefined;
    });
    if (!onChain) return undefined;
    return normalizedCommitment(onChain) === normalizedCommitment(newGuardianPubkey);
  } catch (error) {
    // A failure here is not a verdict — say so, rather than letting a broken read
    // masquerade as "did not land" and fail a rotation that may well have
    // committed.
    console.warn('Could not read the on-chain guardian commitment to confirm the direct switch:', error);
    return undefined;
  }
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
      // `!== true`, not `!response.success`: `fromServerConfigureResponse`
      // copies the field straight off `response.json()`, so a body of
      // `{"success":"false"}` is a truthy STRING and would read as a successful
      // registration. And the server's own `message` is logged rather than
      // interpolated — by the time this throws, the on-chain rotation has
      // already committed, so this message is persisted on the transaction row
      // and rendered as wallet copy on the rotation screen. That makes an
      // endpoint-supplied string a phishing surface; the guardian client keeps
      // raw bodies off `Error.message` for exactly this reason.
      if (response.success !== true) {
        console.warn('New guardian rejected the direct-switch registration:', response.message);
        throw new Error('The new guardian rejected the account registration');
      }
      return;
    } catch (error) {
      // The operator already holds this account. That is the goal state, so it
      // must not be retried into a failure: the reachable causes are a `/configure`
      // whose response was lost after the server applied it, and a second rotation
      // to the guardian the account already has. Both leave a correctly registered
      // account, and reporting `registerFailed` for either one arms a self-heal
      // against a state that needs no healing.
      //
      // It is NOT proof that the state the operator holds is the state this
      // rotation intended — the server refused to overwrite, so an older blob
      // would survive. That distinction belongs to whatever compares held state,
      // not to a retry loop; treating this as a hard failure here would not detect
      // it either, and would break the idempotent case as well.
      if (isGuardianAccountAlreadyRegistered(error)) {
        console.warn(
          `New guardian ${newGuardianEndpoint} already holds account ${accountIdHex}; registration is a no-op.`
        );
        return;
      }
      lastError = error;
      console.warn(`Direct guardian registration failed (attempt ${attempt}/${MAX_DIRECT_REGISTER_RETRIES})`, error);
      if (attempt < MAX_DIRECT_REGISTER_RETRIES) {
        await delay(guardianRegisterBackoffMs(error, attempt));
      }
    }
  }
  throw new Error('Failed to register account on the new guardian after direct switch', { cause: lastError });
};
