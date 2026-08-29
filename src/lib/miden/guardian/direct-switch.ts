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
import { commitmentFromPublicKeyHex, sameCommitment } from 'lib/secure-hot-key/commitment';
import { u8ToB64 } from 'lib/shared/helpers';
import type { WalletAccount } from 'lib/shared/types';

import { assertGuardianKeyCommitment, getGuardianCommitmentFromAccount, getSignerDetailsFromAccount } from './account';
import { isGuardianAccountAlreadyRegistered, withTimeout } from './discover';
import { registerGuardianOrigin } from './native-http';
import { checkEndpointCommitment } from './operator-map';
import { guardianRegisterBackoffMs } from './serialize';
import { WalletSigner, type SignWordFunction } from './signer';
import { midenClientProxy } from '../back/miden-client-proxy';
import { isOperationAbortedError } from '../back/offscreen-codec';
import type { GuardianAccountProvider } from '../front/guardian-manager';
import { freeChainAnchor } from '../sdk/chain-anchor';
import { sameWalletAccountId } from '../sdk/helpers';
import { assertWasmHoldCurrent, getMidenClient, withWasmClientLock } from '../sdk/miden-client';
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

/**
 * Per-attempt ceiling on the `/configure` round-trip to the NEW guardian.
 *
 * Generous compared with the 5s read probes elsewhere, because this is a WRITE
 * carrying the serialized account state and it runs once per rotation, not on a
 * tick — expiring early costs a wasted attempt out of the budget. It only has to
 * sit below "the user gives up", since its job is to stop a silent operator from
 * parking the row forever rather than to hit a latency target.
 */
const DIRECT_REGISTER_TIMEOUT_MS = 30_000;

/**
 * Ceiling on the NEW guardian's unauthenticated `GET /pubkey` — the one network
 * call the direct switch makes BEFORE it signs anything.
 *
 * Same budget as the `/configure` write above, and generous for the same reason:
 * it exists to stop a silent endpoint from parking a non-requeueable row, not to
 * hit a latency target. There is no retry loop behind it — a failure here fails
 * the rotation before any state changed, which is the safe direction.
 */
const NEW_GUARDIAN_PUBKEY_TIMEOUT_MS = 30_000;

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The operator answered, and its answer is "I have no record of this account".
 *
 * Distinct from a 401, which means "I know this account but not this signer" —
 * the two need different repairs, and conflating them is why the missing
 * registration had none. Matched on the guardian's stable machine-readable codes
 * rather than on text; `data_unavailable` and its account-scoped sibling are
 * included because the server uses them for a state blob it cannot produce,
 * which is the same practical condition.
 *
 * Second consumer, and the reason this lives beside `isGuardianUnreachableError`
 * rather than staying private to the sync loop: it gates the SAME direct-switch
 * fallback. An outgoing guardian with no record of the account cannot co-sign a
 * proposal for it, so for the purpose of rotating away it is exactly as unusable
 * as one that is down — and rotating away is the documented escape from that
 * state. Without this, the escape route rejected the user at the first step (the
 * service load calls the guardian's `getState`), leaving an account whose
 * registration never landed with no working exit at all.
 */
export const isGuardianAccountUnknown = (err: unknown): boolean => {
  if (typeof err !== 'object' || err === null) return false;
  const code = 'code' in err ? err.code : undefined;
  return (
    code === 'account_not_found' ||
    code === 'state_not_found' ||
    code === 'account_data_unavailable' ||
    code === 'data_unavailable'
  );
};

/**
 * The operator answered, and its answer is "I am no longer this account's
 * guardian" — `account_released` (HTTP 409), which the server emits after it
 * observes the account switch away and which its own client documents as
 * terminal on that server until the account is re-onboarded via `configure`.
 *
 * Deliberately NOT folded into `isGuardianAccountUnknown`, because it is a
 * stronger statement than "no record": it is a positive assertion that this
 * operator has stood down, which is affirmative evidence FOR the direct path
 * rather than merely the absence of evidence against it.
 *
 * It has to route to the same fallback for the same reason. The state that
 * produces it is a rotation that landed on chain while the wallet's own record
 * of it did not — `endpointPersistFailed`, or an `apply()` that failed after the
 * submission — so the vault still names an operator the chain no longer does.
 * The user's offered repair is Rotate Guardian, and a released operator can
 * neither co-sign nor be re-onboarded by this flow, so without this the repair
 * died on the first call exactly as it did before F-166.
 */
export const isGuardianAccountReleased = (err: unknown): boolean => {
  if (typeof err !== 'object' || err === null) return false;
  return 'code' in err && err.code === 'account_released';
};

/**
 * Either answer that means "this operator cannot co-sign for this account" —
 * no record of it, or a record it has deliberately given up. One predicate
 * because every call site that cares treats them identically: the coordinated
 * path is unavailable and the direct on-chain path needs nothing the operator
 * could have supplied.
 *
 * Both arms read `code` and ONLY `code`, which is a deliberate narrowing rather
 * than an oversight. A response whose body is not the operator's JSON error
 * envelope — a proxy's HTML 404, a gateway's bare 409 — arrives with `code`
 * undefined and is classified neither unknown nor released, so it does NOT reach
 * the direct path. Matching on status instead would widen the trigger for a
 * unilateral on-chain rotation to include any intermediary that happens to answer
 * 404 or 409 for an unrelated reason, and this escape hatch is one whose false
 * positives rotate a live guardian away. The narrow reading fails safe: the
 * coordinated path errors visibly and the user can still rotate deliberately.
 */
export const isGuardianAccountUnusable = (err: unknown): boolean =>
  isGuardianAccountUnknown(err) || isGuardianAccountReleased(err);

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

/**
 * Charset is validated as well as length because the only consumer is a
 * SIGNATURE payload. `parseInt('zz', 16)` is `NaN`, which a `Uint8Array` store
 * coerces to `0` — so a malformed nibble anywhere would silently substitute a
 * zero byte and the request would carry a corrupt signature to the point of an
 * opaque on-chain rejection, having spent a real write. Neither caller can
 * produce non-hex today (both are vault/native `signWord` output), which is
 * exactly why this must fail loudly if one ever starts to.
 */
const hexToBytes = (hex: string): Uint8Array => {
  const clean = stripHexPrefix(hex);
  if (clean.length % 2 !== 0) {
    throw new Error(`Invalid hex string length: ${clean.length}`);
  }
  if (clean.length > 0 && !/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error('Invalid hex string: expected hex digits only');
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
  // Bounded, like every other guardian call on this path. `GuardianHttpClient`
  // uses bare `fetch` with no `AbortSignal`, so an endpoint that accepts the
  // connection and then goes silent produces no error at all — and this is the
  // FIRST network call of the fallback, reached precisely because a guardian just
  // failed to answer. Unbounded, a silent NEW endpoint parks the row at
  // `signing-locally` forever while holding the per-account guardian lock, and
  // `switch-guardian` is in no requeue set and has no user Retry, so nothing ever
  // frees it. The coordinated arms wrap their outgoing-guardian calls in
  // `withOutgoingGuardianDeadline` for the same reason; this one had nothing.
  const { commitment, pubkey } = await withTimeout(
    new GuardianHttpClient(newGuardianEndpoint).getPubkey('ecdsa'),
    NEW_GUARDIAN_PUBKEY_TIMEOUT_MS,
    `New guardian ${newGuardianEndpoint} pubkey`
  );
  // Validate before it becomes MASM: this value is unchecked wire data and the
  // SDK splices it into transaction-script SOURCE. See
  // `assertGuardianKeyCommitment`.
  const newGuardianPubkey = assertGuardianKeyCommitment(commitment, newGuardianEndpoint);
  // The commitment is the ONLY field that reaches the chain, and both device keys
  // are about to sign an account update installing it — so a well-formed response
  // whose commitment does not belong to the key the operator actually signs with
  // installs an operator that can never co-sign, with no error anywhere. The same
  // endpoint would keep serving the same commitment, so the drift reconciler
  // affirms it too. When the response carries the public key, that is checkable
  // for free.
  //
  // Only a DERIVED disagreement refuses. An unparseable key means an encoding this
  // wallet does not know, not a lie, and this path is the last exit from a dead
  // operator — refusing on "I could not check" would strand the account over a
  // field the protocol marks optional.
  if (pubkey) {
    const derived = await commitmentFromPublicKeyHex(pubkey).catch(deriveError => {
      console.warn(
        `Could not derive a commitment from the public key ${newGuardianEndpoint} returned; ` +
          `continuing on the commitment it declared:`,
        deriveError
      );
      return undefined;
    });
    if (derived !== undefined && !sameCommitment(derived, commitment)) {
      throw new Error(
        `Refusing to rotate to ${newGuardianEndpoint}: the commitment it declared does not match the public key ` +
          `it returned with it`
      );
    }
  }

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

  // And the KEY this device is about to sign hot with has to be the key the
  // on-chain slot it will be filed under actually names.
  //
  // The advice entry pairs `built.hotCommitment` — read from the account, i.e.
  // the chain's view — with a signature produced by `hotPublicKey`, read from
  // this device's wallet record. Those are two different sources, and they
  // diverge for real: if another device rotated the hot key, this record is
  // stale. Nothing downstream notices. The entry is filed under the chain's
  // commitment, on-chain ECDSA recovery yields a different public key, and the
  // threshold-2 `update_guardian` refuses as unauthorized — after the build, the
  // proving and the two vault prompts, with `switch-guardian` in no requeue set
  // and no user Retry, so the only diagnostic the user ever gets is an opaque
  // authorization failure on the recovery path they reached because their
  // guardian was already down.
  //
  // `finalizeDirectGuardianSwitch` already makes exactly this comparison, with
  // the same helper in the same realm, for the mirror-image reason. Deriving is
  // free and precedes every signature, so the divergence is worth naming here
  // rather than discovering on chain. Only a DERIVED disagreement refuses, as
  // there: a helper that cannot parse this device's own key says nothing about
  // whether the pairing is right, and this is the last exit from a dead
  // operator.
  const deviceHotCommitment = await commitmentFromPublicKeyHex(hotPublicKey).catch(deriveError => {
    console.warn(
      `Could not derive a commitment from this device's hot key; continuing on the account's own signer read:`,
      deriveError
    );
    return undefined;
  });
  if (deviceHotCommitment !== undefined && !sameCommitment(deviceHotCommitment, built.hotCommitment)) {
    throw new Error(
      `Guardian account ${walletAccount.publicKey} names a different hot signer on chain than this device holds; ` +
        'another device has rotated the hot key, so this device cannot sign a direct guardian switch'
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
  return { request, chainAnchorB64: built.chainAnchorB64 };
};

/**
 * The raw node-authoritative read behind `didDirectSwitchLand` — THROWS on
 * failure instead of folding it into `undefined`, for callers that must tell
 * "no verdict" apart from "could not look" (the pending-rotation recheck feeds
 * a sync fuse with exactly that distinction). The timer-driven caller passes
 * the sync ceiling plus a label, per the bounded-hold discipline (#777).
 *
 * `transactionId` is the ON-CHAIN hash, not a local Dexie row id: the read
 * matches `tx.id().toHex()`, so a row id can only ever answer `'not-found'`.
 */
export const readDirectSwitchCommitState = async (
  transactionId: string,
  lockOptions?: Parameters<typeof withWasmClientLock>[1]
) =>
  withWasmClientLock(async hold => {
    await midenClientProxy.syncState();
    // `syncState()` is a long parking await, and an eviction hands the mutex to
    // a successor while THIS callback keeps running — so the commit-state read
    // below would be a second borrow of a client somebody else is already
    // inside. The timer-driven caller (the pending-rotation recheck) makes that
    // reachable on a schedule rather than once per rotation.
    assertWasmHoldCurrent(hold, 'direct-switch commit-state read, after the state sync');
    return midenClientProxy.getTransactionCommitState(transactionId);
  }, lockOptions);

/**
 * Ask the NODE whether a submitted direct rotation actually took effect.
 *
 * `true` = the node has the transaction committed, so the rotation landed.
 * `false` = the node DISCARDED it, so it definitively did not and never will.
 * `undefined` = no verdict exists yet (still pending, no local record, or the
 * read failed) — which is not evidence in either direction and must not be
 * treated as one.
 *
 * This exists because the commit wait can end with no verdict, and the wallet
 * then has to decide whether to persist the new endpoint. Guessing is not
 * survivable in one of the two directions: persisting the endpoint for a rotation
 * that never landed points the vault at an operator with NO on-chain authority
 * over the account, and the drift reconciler does not detect it — it compares
 * the on-chain commitment against its own cached baseline, and in exactly this
 * case those two agree (both still name the old operator), so it returns
 * `in-sync` without ever looking at the stored endpoint. That is why the
 * pending-rotation recheck reverts the endpoint itself on a `discarded`
 * verdict rather than leaving the repair to drift. Post-commit
 * registration also succeeds against the new operator, so every subsequent sync
 * is healthy and the account looks fine right up until a transaction needs a
 * co-signature the chain will not accept.
 *
 * WHY THE TRANSACTION AND NOT THE ACCOUNT. The obvious implementation — sync,
 * re-read the account, compare its guardian commitment — cannot answer this
 * question, and answers `true` almost unconditionally. The leaf pipeline calls
 * `submittedTx.apply()` immediately after `submit()`, which persists the
 * transaction's account delta into the LOCAL store; the rotation's whole effect
 * is one storage slot, so the local account already names the new operator
 * before this function runs. Guardian accounts are private storage mode, so
 * there is no public account state to compare against either — the chain holds a
 * commitment to the account, not its guardian slot. A commitment read would
 * therefore be the wallet reading back its own optimistic write and reporting it
 * as chain confirmation. The transaction RECORD is the thing the node has an
 * opinion about, and `getTransactionCommitState` is the same authority
 * `verifySendLanded` uses for the equivalent double-send question.
 */
export const didDirectSwitchLand = async (
  transactionId: string,
  lockOptions?: Parameters<typeof withWasmClientLock>[1]
): Promise<boolean | undefined> => {
  try {
    const state = await readDirectSwitchCommitState(transactionId, lockOptions);
    if (state === 'committed') return true;
    if (state === 'discarded') return false;
    // 'pending' — submitted and still awaiting a block, so it may yet land — and
    // 'not-found' — this client has no record, which the accessor documents as
    // explicitly NOT evidence of not-landing — are both non-verdicts.
    return undefined;
  } catch (error) {
    // POISON IS NOT A NON-VERDICT, it is a statement about the caller. Folded to
    // `undefined` like any other read failure, an eviction of this node read
    // reached the completion path as the W1 "submitted, commit unconfirmed"
    // residue — so an abandoned pipeline went on to persist the endpoint and mark
    // the row Completed, and the `generateTransaction` poison handler whose whole
    // job is to NOT finalize an abandoned pipeline never saw it. Same rule, same
    // file: `asPreflight` rethrows poison unwrapped for exactly this reason.
    if (isWasmClientPoisonedError(error)) throw error;
    // Any other failure here is not a verdict — say so, rather than letting a
    // broken read masquerade as "did not land" and fail a rotation that may well
    // have committed.
    console.warn('Could not read the node-side state of the direct switch transaction:', error);
    return undefined;
  }
};

/**
 * Marks a failure that happened BEFORE any `/configure` was issued — a local
 * read that came back truncated, an account the client does not have, a signer
 * set this device is not in.
 *
 * The distinction is not cosmetic. `attemptMissingRegistrationSelfHeal` runs
 * this function on a bounded budget of three attempts, reset only by a
 * successful registration, and it books the attempt before the call because a
 * `/configure` that throws may still have landed. A preflight failure touched
 * no operator and proves nothing about the account, so charging it would let
 * three flaky local reads permanently disable the repair — the same defect
 * round 9 fixed on the sibling 401 self-heal, which this class exists to keep
 * from reappearing through the other door.
 */
export const GUARDIAN_REGISTRATION_PREFLIGHT = 'GuardianRegistrationPreflightError';

export class GuardianRegistrationPreflightError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = GUARDIAN_REGISTRATION_PREFLIGHT;
  }
}

/** Name-based, so it survives module mocking and structured-clone boundaries. */
export const isGuardianRegistrationPreflightError = (error: unknown): boolean =>
  error instanceof Error && error.name === GUARDIAN_REGISTRATION_PREFLIGHT;

/**
 * Tag EVERYTHING raised before the first `/configure` as preflight, rather than
 * enumerating throw sites.
 *
 * Enumerating is what the first cut did, and it missed most of them: the local
 * `syncState`, the pinned-version assert inside `AccountInspector.fromAccount`,
 * the strict signer read, the key-derivation import, and a watchdog eviction of
 * the lock hold itself all throw plain errors from this window. Each one landed
 * in the caller's "the write may have landed" arm and spent an attempt from a
 * budget only a SUCCESSFUL registration refunds — so three local read failures
 * disabled the repair for the session. The invariant is positional, not
 * per-site: no request has been sent yet, so nothing thrown here can be
 * evidence about the operator. `cause` keeps the original for the log.
 *
 * ONE EXCEPTION, and it is not about the operator either. A poison error says
 * the realm's WASM client was taken away mid-call — a fact the CALLER has to act
 * on, because its next step is another hold on a client somebody else now owns.
 * Rewrapping it as a preflight error tells that caller the opposite of what it
 * needs: "refused before contacting the operator, refund and carry on". The
 * refund is right; carrying on is not, and the wrapper is what erased the
 * difference. Kill classifiers read this class by name (`isWasmClientPoisoned-
 * Error`), so it has to survive the rethrow intact.
 */
const asPreflight = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    if (isWasmClientPoisonedError(error)) throw error;
    if (isGuardianRegistrationPreflightError(error)) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new GuardianRegistrationPreflightError(`Could not prepare the guardian registration: ${detail}`, {
      cause: error
    });
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
 *
 * Throws `GuardianRegistrationPreflightError` when it refuses before the
 * `/configure` — which is not the same as before touching the operator at all,
 * since the commitment check ahead of it does a `/pubkey`. Two production
 * callers, and they treat it differently on purpose: the missing-registration
 * self-heal refunds the attempt rather than spending it, while the completion
 * path (`complete.ts`) has no budget to refund and books every throw here as
 * `registerFailed`, leaving the repair to that same self-heal.
 */
export const finalizeDirectGuardianSwitch = async (
  accountId: string,
  newGuardianEndpoint: string,
  guardianProvider: GuardianAccountProvider,
  // Same shape, and the same reason, as `readDirectSwitchCommitState` above: the
  // preflight hold is bounded and labeled by the TIMER-DRIVEN caller, while the
  // completion path keeps the default ceiling. Both callers reach the same hold,
  // but only one of them re-enters it every three seconds for as long as the
  // operator stays unreachable, which is what the sync ceiling is calibrated for.
  lockOptions?: Parameters<typeof withWasmClientLock>[1],
  /**
   * Fired ONCE, immediately before the first `/configure` leaves this device.
   *
   * The same affordance, for the same reason, as
   * `MultisigService.reRegisterCurrentStateOnGuardian`'s callback of this name.
   * A caller on a bounded budget has to know which side of the POST a failure
   * came from, and the ERROR cannot tell it: `asPreflight` deliberately rethrows
   * a `WasmClientPoisonedError` unwrapped, so an eviction of the preflight's
   * `syncState()` — strictly pre-POST — arrives looking exactly like an eviction
   * that landed with a `/configure` in flight. The caller that guessed "charged"
   * spent a budget only a successful registration refunds, on an operator that
   * was never asked for anything.
   *
   * Not called at all when this function throws before the loop below, which is
   * precisely the signal: no call, no request, refund.
   */
  onBeforeRegister?: () => void
): Promise<void> => {
  const walletAccount = (await guardianProvider.getAccounts()).find(a => sameWalletAccountId(a.publicKey, accountId));
  if (!walletAccount?.hotPublicKey) {
    throw new GuardianRegistrationPreflightError(
      `Guardian account ${accountId} not found in provider (or missing hotPublicKey)`
    );
  }
  const hotPublicKey = walletAccount.hotPublicKey;

  const { accountIdHex, stateBase64, signerCommitments, detectedSigners, declaredSigners, guardianCommitment } =
    await asPreflight(() =>
      withWasmClientLock(async hold => {
        await midenClientProxy.syncState();
        // Same parking-await rule as `readDirectSwitchCommitState`, and this is
        // the more dangerous of the two: an eviction during the sync releases the
        // mutex, and the reads below would then serialize an account handle out
        // of a client a successor already owns — a blob this function POSTs to
        // the operator as the account's authoritative state and its new signer
        // allowlist. The self-heal reaches here from the 3 s loop, so it is a
        // scheduled exposure, not a once-per-rotation one.
        assertWasmHoldCurrent(hold, 'guardian register preflight, after the state sync');
        const account = await midenClientProxy.getAccount(walletAccount.publicKey);
        if (!account) {
          throw new GuardianRegistrationPreflightError(`Account ${accountId} is missing from local client`);
        }
        // AND AGAIN AFTER THE ACCOUNT READ, which is a parking await of its own.
        // Guarding only the sync above covered the first of the two and left the
        // whole payload derivation — `AccountInspector.fromAccount`,
        // `account.serialize()`, the guardian-slot read — running on a handle
        // borrowed from a client an eviction may already have handed to a
        // successor. That is the same one-guard-per-hold mistake
        // `reRegisterCurrentStateOnGuardian` fixed by re-checking after BOTH of
        // its awaits, and the stakes here are the highest in the change: these
        // bytes are POSTed to the operator as the account's authoritative state
        // and its new signer allowlist. Still strictly pre-write, so failing
        // here costs a refunded attempt and nothing else.
        assertWasmHoldCurrent(hold, 'guardian register preflight, after the account read');
        const detected = AccountInspector.fromAccount(account);
        return {
          accountIdHex: account.id().toString(),
          stateBase64: u8ToB64(account.serialize()),
          detectedSigners: detected.signerCommitments.length,
          // Storage's own count, so the completeness check below compares the read
          // against what the account SAYS it holds rather than against a constant.
          declaredSigners: detected.numSigners,
          signerCommitments: detected.signerCommitments,
          // Read from the SAME account as the bytes below, because the check it
          // feeds is about those bytes.
          guardianCommitment: getGuardianCommitmentFromAccount(account)
        };
      }, lockOptions)
    );

  // `AccountInspector.fromAccount` swallows per-slot read failures, so a set
  // SHORTER than the count storage declares is a truncated read — and this
  // allowlist becomes the new operator's authorization policy for the account.
  //
  // The empty case alone is not enough. A partial read of a 2-of-3 guardian
  // account — say the hot key alone, cold's slot unreadable — passes a length
  // check, and `/configure` then installs an allowlist the COLD key is not in.
  // Cold is the key the recovery paths sign with (`buildColdMultisigService`,
  // `reRegisterCurrentStateOnGuardian`), so the account would be left unable to
  // repair its own registration on the operator it just rotated to, on the path
  // whose whole premise is that the previous operator is gone. The inspector's
  // own docs say a truncated read must not be stored as authoritative config;
  // `assertCompleteDetectedConfig` is the library's check for exactly this, and
  // it additionally requires the guardian commitment a guarded multisig always
  // has. Failing here costs nothing — nothing has been written yet, and the
  // rotation itself has already committed, so the row completes with
  // `registerFailed` and the self-heal retries against a later, complete read.
  if (declaredSigners === 0 || detectedSigners !== declaredSigners) {
    throw new GuardianRegistrationPreflightError(
      `Refusing to register on the new guardian with an incomplete signer allowlist: storage declares ` +
        `${declaredSigners} signers, read ${detectedSigners} (truncated read)`
    );
  }
  // And THIS DEVICE has to be in the policy it is installing.
  //
  // Note what the comparison is between. Deriving the left-hand side from the
  // same account read as the allowlist proves nothing — that read's own slot 0 is
  // a member of that read by construction, and the check is a tautology. The
  // question is whether the WALLET RECORD's hot key — the key `setSigner` below
  // authenticates `/configure` with, and the only one this device can actually
  // sign as — is in the set. If another device rotated the hot key, this record
  // is stale, the allowlist just read belongs to that other device, and pushing
  // it hands the new operator a policy this device cannot then talk to.
  // `/configure` is account-wide, so the mirror image is worse — the same guard
  // in `attemptMissingRegistrationSelfHeal` exists to stop this device revoking
  // the one that legitimately owns the account.
  //
  // The checked value is then the SIGNED-WITH value, deliberately: verifying one
  // commitment and authenticating with another would leave the guard true and the
  // request still unauthorized. `deviceHotCommitment` and `hotPublicKey` are a
  // derived pair, so they cannot disagree.
  const deviceHotCommitment = await asPreflight(() => commitmentFromPublicKeyHex(hotPublicKey));
  if (!signerCommitments.some(commitment => sameCommitment(commitment, deviceHotCommitment))) {
    throw new GuardianRegistrationPreflightError(
      "Refusing to register on the new guardian with an allowlist that omits this device's hot signer commitment"
    );
  }

  // And the state about to be pushed has to DESCRIBE a rotation to this operator.
  //
  // `attemptMissingRegistrationSelfHeal` makes this same check, and it is kept
  // there because it fails fast — before the WASM lock and before an attempt is
  // spent. But the caller checks a SNAPSHOT: it reads the guardian key, probes the
  // endpoint, and only then calls this function, which re-syncs and re-serializes
  // the account. Between the two there is a 5s probe plus up to eight 30s
  // `/configure` deadlines with backoff, and rotations are serialized per account
  // while the sync loop is not — so a user-initiated rotation A→B can commit
  // inside that window. The caller's guard passed against pre-rotation state; the
  // bytes serialized above are POST-rotation, and they would be POSTed to A, the
  // operator the user just rotated away from (plausibly because it was failing).
  // Guardian accounts are private storage mode, so that state exists nowhere on
  // chain: the disclosure is bounded only by A already holding an older copy.
  //
  // So the authoritative check belongs on this side of the boundary, against the
  // read whose bytes go over the wire — the same "check the value you are about to
  // use" rule the allowlist and hot-signer guards above follow. A preflight class,
  // so a refusal here refunds the caller's attempt rather than spending it: no
  // `/configure` has been sent.
  if (!guardianCommitment) {
    throw new GuardianRegistrationPreflightError(
      'Refusing to register on the new guardian: the local account state names no guardian key, so there is ' +
        'nothing to check the operator against'
    );
  }
  // On the tick budget this probe would be 5s, which is right for a caller that
  // repeats every ~3s and wrong here: this fires ONCE, past the on-chain commit,
  // in front of a retry loop that allows the very same operator 30s per attempt.
  // A self-hosted operator cold-starting in 6s would fail the guard, book
  // `registerFailed`, and hand the account to a self-heal that probes it on the
  // same 5s budget — a slow operator convicted of being the wrong one, which is
  // the mistake `USER_ENDPOINT_CHECK_TIMEOUT_MS` was introduced to stop making.
  const endpointHoldsGuardianKey = await asPreflight(() =>
    checkEndpointCommitment(newGuardianEndpoint, guardianCommitment, DIRECT_REGISTER_TIMEOUT_MS)
  );
  if (endpointHoldsGuardianKey !== 'match') {
    throw new GuardianRegistrationPreflightError(
      `Refusing to register on ${newGuardianEndpoint}: it did not confirm the guardian key this account's state ` +
        `names (${endpointHoldsGuardianKey}), so that state may have moved to a different operator since the caller ` +
        `checked`
    );
  }

  registerGuardianOrigin(newGuardianEndpoint);
  const guardian = new GuardianHttpClient(newGuardianEndpoint);
  guardian.setSigner(
    new WalletSigner(ensureHexPrefix(hotPublicKey), ensureHexPrefix(deviceHotCommitment), guardianProvider.signWord)
  );

  // THE BOUNDARY. Everything above is preflight — local reads, the allowlist and
  // hot-signer guards, the operator probe — and every one of them refunds. From
  // here on a request can be in flight, so a failure may have landed and the
  // caller must count it.
  onBeforeRegister?.();

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_DIRECT_REGISTER_RETRIES; attempt++) {
    try {
      // Bounded, for the same reason every call to the OUTGOING guardian is
      // (`withOutgoingGuardianDeadline`): `GuardianHttpClient` calls bare `fetch`
      // with no `AbortSignal`, so an operator that accepts the connection and
      // then goes silent produces no error at all. The retry budget below bounds
      // REJECTIONS and never advances on silence, and this call sits PAST the
      // on-chain commit — so an unbounded wait here parks the row before its
      // terminal status write, leaving the rotation screen spinning forever and
      // never recording `registerFailed`, the very flag whose self-heal exists to
      // finish this registration later. A deadline converts silence into an
      // attempt failure the loop can consume.
      const response = await withTimeout(
        guardian.configure({
          accountId: accountIdHex,
          auth: { MidenEcdsa: { cosigner_commitments: signerCommitments } },
          initialState: { data: stateBase64, accountId: accountIdHex }
        }),
        DIRECT_REGISTER_TIMEOUT_MS,
        `New guardian ${newGuardianEndpoint} registration`
      );
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
