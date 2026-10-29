import {
  Note,
  NoteFile,
  NoteFilterTypes,
  NoteType,
  SigningInputs,
  SigningInputsType,
  TransactionRequest,
  type NoteQuery,
  type TransactionSummary
} from '@miden-sdk/miden-sdk/lazy';
import {
  AllowedPrivateData,
  Asset,
  InputNoteDetails,
  MidenConsumeTransaction,
  MidenCustomTransaction,
  PrivateDataPermission,
  SendTransaction
} from '@miden-sdk/miden-wallet-adapter-base';
import { nanoid } from 'nanoid';
import type { Runtime, Windows } from 'webextension-polyfill';

import {
  declaredTransactionRequestToView,
  netOutflowByFaucet,
  simulatedBytesToView,
  summaryToView,
  type AssetAmount,
  type TxAssetView
} from 'app/confirm/decode';
import { noteFlowFromSimulatedBytes } from 'app/confirm/note-flow';
import {
  MidenDAppDisconnectRequest,
  MidenDAppDisconnectResponse,
  MidenDAppErrorType,
  MidenDAppGetCurrentPermissionResponse,
  MidenDAppGuardianInfoRequest,
  MidenDAppGuardianInfoResponse,
  MidenDAppLoginKeyRequest,
  MidenDAppLoginKeyResponse,
  MidenDAppLoginSignRequest,
  MidenDAppLoginSignResponse,
  MidenDAppMessageType,
  MidenDAppPermissionRequest,
  MidenDAppPermissionResponse,
  MidenDAppSendTransactionRequest,
  MidenDAppSendTransactionResponse,
  MidenDAppTransactionRequest,
  MidenDAppTransactionResponse,
  MidenDAppConsumeRequest,
  MidenDAppConsumeResponse,
  MidenDAppPrivateNotesResponse,
  MidenDAppPrivateNotesRequest,
  MidenDAppSignRequest,
  MidenDAppSignResponse,
  MidenDAppAssetsResponse,
  MidenDAppAssetsRequest,
  MidenDAppImportPrivateNoteRequest,
  MidenDAppImportPrivateNoteResponse,
  MidenDAppConsumableNotesRequest,
  MidenDAppConsumableNotesResponse,
  MidenDAppWaitForTxRequest,
  MidenDAppWaitForTxResponse
} from 'lib/adapter/types';
import { endOriginSessions } from 'lib/bread-connect/revoke';
import {
  dappConfirmationStore,
  type DAppConfirmationRequest,
  type DAppConfirmationResult,
  type DAppLoginSignConfirmationRequest
} from 'lib/dapp-browser/confirmation-store';
import { formatBigInt } from 'lib/i18n/numbers';
import { APPROVAL_CONFIRMATION_TYPES } from 'lib/miden/back/approval-confirmation';
import { intercom } from 'lib/miden/back/defaults';
import { Vault } from 'lib/miden/back/vault';
import { FEE_RESERVE_MULTIPLE } from 'lib/miden/fees/spendable';
import { guardianProviderFromEndpoint, resolveGuardianEndpoint } from 'lib/miden/guardian/account';
import { dappGuardianSyncStatus } from 'lib/miden/guardian/sync-guard';
import { loginKeyDomain } from 'lib/miden/login-key/derive';
import { MIDEN_METADATA } from 'lib/miden/metadata';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { getAssetSymbol, getTokenMetadata } from 'lib/miden/metadata/utils';
import { NETWORKS } from 'lib/miden/networks';
import { importedNoteIds, noteIdFromBytes, releaseNoteIds } from 'lib/miden/note-quarantine';
import * as Repo from 'lib/miden/repo';
import { createSpendingLimitAuthorization } from 'lib/miden/spending-limits/authorization';
import {
  assessOutgoingSpendingLimitDetails,
  hasSpendingLimits,
  type SpendingLimitAssessmentDetails
} from 'lib/miden/spending-limits/queue';
import {
  isSpendingLimitPriceUnavailable,
  spendingLimitAssessmentFromError,
  toSerializedSpendingLimitAssessment,
  type SpendingLimitAuthorization
} from 'lib/miden/spending-limits/types';
import {
  DappMetadata,
  MidenDAppAssetsConfirmationRequest,
  MidenDAppConsumableNotesConfirmationRequest,
  MidenDAppPayload,
  MidenDAppPrivateNotesConfirmationRequest,
  MidenDAppSession,
  MidenDAppSessions,
  MidenDAppTransactionPayload,
  MidenMessageType,
  MidenRequest
} from 'lib/miden/types';
import { ensureSdkWasmReady } from 'lib/miden-chain/constants';
import { getEffectiveNetworkName, getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { getNativeAssetId, getVerificationBaseFee } from 'lib/miden-chain/native-asset';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import { isDesktop, isExtension } from 'lib/platform';
import { getStorageProvider } from 'lib/platform/storage-adapter';
import { commitmentToHex } from 'lib/secure-hot-key/commitment';
import { DEFAULT_DELEGATE_PROOF } from 'lib/settings/constants';
import { b64ToU8, bytesToHex, u8ToB64 } from 'lib/shared/helpers';
import { GuardianInfo, WalletStatus } from 'lib/shared/types';
import {
  backgroundAgeOf,
  type ConfirmationHandlerState,
  type ConfirmationRegistryState,
  type ConfirmationRequestShape
} from 'lib/telemetry/crash-diagnostics';
import { WalletType } from 'screens/onboarding/types';
import { capitalizeFirstLetter, truncateAddress } from 'utils/string';

import { queueNoteImport } from '../activity';
import { isLikelyNetworkError } from '../activity/connectivity-classify';
import {
  assertValidRecallBlocks,
  type ConsumeRestriction,
  mayConsume,
  noteConsumeRestriction,
  toNoteTypeString,
  toPersistedNoteType
} from '../helpers';
import {
  isStoreLocked,
  isWalletLockedError,
  lockedRefusal,
  mayPromptToUnlock,
  noteLockedPromptEnded,
  onceAfterUnlock,
  waitForUnlock
} from './dapp-locked';
import { fieldWordFromBase64 } from './login-word';
import { midenClientProxy } from './miden-client-proxy';
import { simulateCustomTransaction, type SimulateCustomTxResult } from './simulate-custom-tx';
import { store, withUnlocked } from './store';
import { startTransactionProcessing } from './transaction-processor';
import { IConsumedAssetTotal, type ITransaction } from '../db/types';
import { accountRefToSdk, getBech32AddressFromAccountId, sameWalletAccountId } from '../sdk/helpers';
import { assertWasmHoldCurrent, withWasmClientLock, type WasmLockHold } from '../sdk/miden-client';
import type { DetailsCommitmentMatches } from '../sdk/miden-client-interface';
import { describeNft, toNft, type NftAsset } from '../sdk/nft-asset';
import { normalizedCommitment, noteDetailsCommitment, type NoteDetailsParts } from '../sdk/note-details-commitment';
import { resolvePublicKeyCommitments } from '../sdk/resolve-public-key-commitments';
import { causeChain, isPipelineKillLink, pipelineKillIn } from '../sdk/sdk-error-code';
import {
  initiateSendTransaction,
  requestCustomTransaction,
  initiateConsumeTransactionFromId,
  waitForTransactionCompletion
} from '../transaction';
import { ClaimFeeRefusedError } from '../transaction/claim-fee';
import { deterministicKernelFailureCopy } from '../transaction/constants';
import { TransactionQueuedError } from '../transaction/initiate';

/**
 * Starts background transaction processing using the unified SW
 * transaction processor. Defensive: any synchronous throw from the
 * lazy-import chain is swallowed here so the caller can safely run
 * `resolve(...)` afterwards. A thrown startup error would otherwise
 * cause the tx preview to succeed, the tx to actually sign, and then
 * the dApp promise to reject with "InvalidParams" — the dApp would
 * believe its request failed even though it broadcast on-chain.
 */
function startDappBackgroundProcessing() {
  try {
    startTransactionProcessing().catch(err => console.error('[DApp] Transaction processing error:', err));
  } catch (err) {
    console.error('[DApp] startTransactionProcessing sync throw:', err);
  }
}

// Debug logger — gated so production builds don't dump wallet request
// payloads (addresses, amounts, allowedPrivateData) into platform logs.
// Enable via `DEBUG_DAPP_BRIDGE=1` env at build time. Exported so
// `actions.ts` can use the same gate for its top-level dispatcher log.
const DEBUG_DAPP_BRIDGE = typeof process !== 'undefined' && process.env?.DEBUG_DAPP_BRIDGE === '1';
export const dappDebug = (...args: unknown[]) => {
  /* c8 ignore start */ if (DEBUG_DAPP_BRIDGE) console.log(...args); /* c8 ignore stop */
};

// Log to Rust stdout for desktop debugging. Gated behind the same
// DEBUG_DAPP_BRIDGE flag as `dappDebug` — several call sites in this
// file pass the origin / sessionId / appMeta.name and these breadcrumbs
// would otherwise land unredacted in the Tauri process's stdout on
// every dApp connection in production desktop builds. Desktop devs can
// flip the env flag at build time to see the stream again.
async function dappLog(message: string): Promise<void> {
  /* c8 ignore start */ if (!DEBUG_DAPP_BRIDGE) return; /* c8 ignore stop */
  /* c8 ignore start */
  if (isDesktop()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      invoke('js_log', { message }).catch(() => {});
    } catch {
      // Not in Tauri context
    }
  }
  /* c8 ignore stop */
}

/**
 * The connected account's first auth public-key commitment, b64-encoded.
 *
 * `hold` is the caller's lock hold, REQUIRED rather than optional: both connect
 * paths run this inside `withWasmClientLock`, and an optional guard is one a
 * future caller disables by forgetting it.
 */
async function getAccountPublicKeyB64(accountId: string, hold: WasmLockHold): Promise<string> {
  const account = await midenClientProxy.getAccount(accountId);
  // The account read parks (offscreen round trip, or inline store/gRPC work). A
  // watchdog eviction during it hands the mutex to a successor without stopping
  // this callback, and the commitment resolution + `serialize()` below are WASM
  // reads on an Account borrowed from the client's RefCell — continuing would be
  // the double borrow the lock exists to prevent, not merely a stale read.
  assertWasmHoldCurrent(hold, 'after the connect account read');
  if (!account) {
    throw new Error('Account not found');
  }
  const publicKeyCommitments = resolvePublicKeyCommitments(account);
  if (publicKeyCommitments.length === 0) {
    throw new Error('Account has no public key commitments');
  }
  return u8ToB64(publicKeyCommitments[0]!.serialize());
}

/**
 * True when `suppliedPublicKey` names a signing key that `accountId` actually
 * authenticates with.
 *
 * `signData`'s default path loads whatever secret sits at
 * `accAuthSecretKeyStrgKey(publicKey)` and signs with it. The vault is keyed by
 * commitment alone, with no back-reference to an account, so that lookup will
 * happily return a DIFFERENT account's key — every account in the wallet is
 * reachable from that one string. Nothing else on the path narrows it: the
 * session is resolved from the separate `sourceAccountId`, which an attacking
 * page fills in with its own connected account so the permission check passes.
 * So the key has to be checked against the account here, or not at all.
 */
async function publicKeyBelongsToAccount(
  accountId: string,
  suppliedPublicKey: string,
  // The caller's lock hold, REQUIRED rather than optional for the same reason as
  // getAccountPublicKeyB64's: an optional guard is one a future caller disables
  // by forgetting it.
  hold: WasmLockHold
): Promise<boolean> {
  const supplied = commitmentToHex(suppliedPublicKey);
  if (supplied === undefined) return false;
  const account = await midenClientProxy.getAccount(accountId);
  // Between the parking account read and the commitment reads: an eviction
  // during the read hands the mutex to a successor, and `serialize()` below is a
  // WASM call on the borrowed Account. This runs pre-signature, so aborting is
  // safe — and the poison throw is routed as a retryable failure by the caller,
  // never as an authorization verdict.
  assertWasmHoldCurrent(hold, 'after the sign-authorization account read');
  if (!account) return false;
  return resolvePublicKeyCommitments(account).some(
    commitment => commitmentToHex(Buffer.from(commitment.serialize()).toString('hex')) === supplied
  );
}

// Lazy-loaded browser polyfill (only in extension context)
type Browser = import('webextension-polyfill').Browser;
let browserInstance: Browser | null = null;
async function getBrowser(): Promise<Browser> {
  /* c8 ignore start */ if (!isExtension())
    throw new Error('Browser extension APIs only available in extension context'); /* c8 ignore stop */
  if (!browserInstance) {
    const module = await import('webextension-polyfill');
    browserInstance = module.default;
  }
  return browserInstance;
}

const CONFIRM_WINDOW_WIDTH = 440;
// 716 plus the 44px network banner (#875) that tops the confirm window.
const CONFIRM_WINDOW_HEIGHT = 760;
const AUTODECLINE_AFTER = 120_000;
// How long a confirm popup may hold the dApp queue through an unlock, its build and a full review.
const LOCKED_PROMPT_CAP_MS = 2 * AUTODECLINE_AFTER;
const STORAGE_KEY = 'dapp_sessions';

export async function getCurrentPermission(origin: string): Promise<MidenDAppGetCurrentPermissionResponse> {
  const currentAccountPubKey = await Vault.getCurrentAccountPublicKey();
  const dApp = currentAccountPubKey ? await getDApp(origin, currentAccountPubKey) : undefined;
  const permission = dApp
    ? {
        rpc: await getNetworkRPC(dApp.network),
        address: dApp.accountId,
        privateDataPermission: dApp.privateDataPermission,
        allowedPrivateData: dApp.allowedPrivateData,
        // Older sessions stored null here (see requestPermission), so the key is omitted then.
        ...(typeof dApp.publicKey === 'string' && dApp.publicKey !== '' ? { publicKey: dApp.publicKey } : {})
      }
    : null;
  return {
    type: MidenDAppMessageType.GetCurrentPermissionResponse,
    permission
  };
}

export async function requestDisconnect(
  origin: string,
  _req: MidenDAppDisconnectRequest
): Promise<MidenDAppDisconnectResponse> {
  const currentAccountPubKey = await Vault.getCurrentAccountPublicKey();
  if (currentAccountPubKey) {
    const dApp = await getDApp(origin, currentAccountPubKey);
    if (dApp) {
      await removeDApp(origin, currentAccountPubKey);
      return {
        type: MidenDAppMessageType.DisconnectResponse
      };
    }
  }
  throw new Error(MidenDAppErrorType.NotFound);
}

export async function requestPermission(
  origin: string,
  req: MidenDAppPermissionRequest,
  // PR-4 chunk 8: optional multi-instance session id, threaded into the
  // confirmation store so the React modal can route the prompt to the
  // matching foreground session.
  sessionId?: string,
  // Internal, never from the dApp: the re-entry after an unlock keeps the request's one deadline.
  waits: UnlockWaits = {}
): Promise<MidenDAppPermissionResponse> {
  dappDebug('[requestPermission] Called with origin:', origin);
  dappDebug('[requestPermission] Request:', JSON.stringify(req));
  dappDebug('[requestPermission] isExtension():', isExtension());
  let network = req?.network?.toString();
  const reqChainId = network;

  if (![isAllowedNetwork(), typeof req?.appMeta?.name === 'string'].every(Boolean)) {
    throw new Error(MidenDAppErrorType.InvalidParams);
  }
  const networkRpc = await getNetworkRPC(reqChainId);
  const currentAccountPubKey = await Vault.getCurrentAccountPublicKey();
  const dApp = currentAccountPubKey ? await getDApp(origin, currentAccountPubKey) : undefined;

  // const current = await getCurrentMidenNetwork();
  // const currentChainId = loadChainId(current.rpcBaseURL);

  // Assert that the dApp network or the req.network matches the current chain id
  // if (reqChainId.toString() !== currentChainId && dApp?.network?.toString() !== currentChainId) {
  //   throw new Error(MidenDAppErrorType.NetworkNotGranted);
  // }

  if (!req.force && dApp && req.appMeta.name === dApp.appMeta.name) {
    if (store.getState().status === WalletStatus.Locked) {
      if (!isExtension()) {
        // The app's own lock screen is the Unlock step here; once unlocked, the request runs as it would have.
        if (!(await waitForUnlockOnNonExtension(origin, waits))) throw lockedRefusal();
        return requestPermission(origin, req, sessionId, waits);
      }
      dappLog('[requestPermission] PATH: existing permission but wallet LOCKED, going through confirmation');
      return generatePromisifyRequestPermission(
        origin,
        reqChainId,
        networkRpc,
        dApp.appMeta,
        !!dApp,
        dApp.privateDataPermission,
        dApp.allowedPrivateData,
        sessionId
      );
    }
    dappLog('[requestPermission] PATH: existing permission, wallet unlocked, DIRECT RETURN');
    return {
      type: MidenDAppMessageType.PermissionResponse,
      network: reqChainId,
      accountId: dApp.accountId,
      privateDataPermission: dApp.privateDataPermission,
      allowedPrivateData: dApp.allowedPrivateData,
      publicKey: dApp.publicKey
    };
  }

  dappLog('[requestPermission] PATH: NO existing permission, going through confirmation store');
  dappLog(`[requestPermission] dApp: ${dApp}, force: ${req.force}, appMeta.name: ${req.appMeta?.name}`);
  return generatePromisifyRequestPermission(
    origin,
    reqChainId,
    networkRpc,
    req.appMeta,
    // Not `!!dApp`: a forced or renamed connect asks a scope the saved session's consent never covered, so it is a new
    // permission, prompted with its consent box and saved on approval, never answered on its own.
    false,
    req.privateDataPermission,
    req.allowedPrivateData,
    sessionId,
    waits
  );
}

export async function generatePromisifyRequestPermission(
  origin: string,
  network: string,
  networkRpc: string,
  appMeta: DappMetadata,
  existingPermission: boolean,
  privateDataPermission?: PrivateDataPermission,
  allowedPrivateData?: AllowedPrivateData,
  // PR-4 chunk 8: optional multi-instance session id.
  sessionId?: string,
  waits: UnlockWaits = {}
): Promise<MidenDAppPermissionResponse> {
  dappDebug('[generatePromisifyRequestPermission] Called, isExtension:', isExtension());
  // On mobile/desktop, use confirmation store to request user approval
  if (!isExtension()) {
    if (isStoreLocked() && !(await waitForUnlockOnNonExtension(origin, waits))) {
      throw lockedRefusal();
    }
    // One deadline bounds every sheet and key read of this connect, so a failed read never buys a fresh window.
    const deadline = waits.deadline ?? Date.now() + AUTODECLINE_AFTER;
    let previousAttemptError: string | undefined;
    for (;;) {
      const id = nanoid();
      dappLog(`[DApp] Non-extension requesting confirmation for: ${origin} id: ${id} sessionId: ${sessionId}`);
      dappLog(`[DApp] Calling dappConfirmationStore.requestConfirmation...`);

      // Request confirmation from the user via the confirmation store
      dappLog(`[DApp] About to call requestConfirmation, store instance: ${dappConfirmationStore.getInstanceId()}`);
      const result = await requestConfirmationWithWatchdog(deadline, {
        id,
        sessionId,
        type: 'connect',
        origin,
        appMeta,
        network,
        networkRpc,
        privateDataPermission: privateDataPermission || PrivateDataPermission.UponRequest,
        allowedPrivateData: allowedPrivateData || AllowedPrivateData.None,
        existingPermission,
        ...(previousAttemptError !== undefined && { previousAttemptError })
      });
      dappLog(`[DApp] requestConfirmation returned! confirmed: ${result.confirmed}`);

      if (!result.confirmed || !result.accountPublicKey) {
        throw new Error(MidenDAppErrorType.NotGranted);
      }

      const accountPublicKey = result.accountPublicKey;
      let publicKey: string | typeof KEY_READ_PAST_DEADLINE;
      try {
        publicKey = await readApprovedKeyBefore(deadline, accountPublicKey);
      } catch (e) {
        console.error('[DApp] Error fetching account public key:', e);
        // The user approved, so a failed read, a kill included (#775), is no answer to the dApp (#1471): the sheet is
        // asked again with its error, until a read succeeds, the user denies or the deadline passes.
        if (Date.now() >= deadline) throw new Error(MidenDAppErrorType.NotGranted);
        previousAttemptError = e instanceof Error ? e.message : '';
        continue;
      }
      if (publicKey === KEY_READ_PAST_DEADLINE) throw new Error(MidenDAppErrorType.NotGranted);

      if (!existingPermission) {
        await setDApp(origin, {
          network,
          appMeta,
          accountId: accountPublicKey,
          privateDataPermission: result.privateDataPermission || PrivateDataPermission.UponRequest,
          allowedPrivateData: allowedPrivateData || AllowedPrivateData.None,
          publicKey
        });
      }

      dappDebug('[DApp] Non-extension approved connection for:', origin);
      return {
        type: MidenDAppMessageType.PermissionResponse,
        accountId: accountPublicKey,
        network,
        privateDataPermission: result.privateDataPermission || PrivateDataPermission.UponRequest,
        allowedPrivateData: allowedPrivateData || AllowedPrivateData.None,
        publicKey
      };
    }
  }

  // `.catch(reject)`, as in every other handler: a popup that cannot be opened answers the dApp instead of becoming an
  // unhandled rejection in the worker.
  return new Promise((resolve, reject) => {
    const id = nanoid();
    // Set once requestConfirm answers the dApp with a refusal (a Cancel, or the cap reached while the read still runs):
    // a key read still running then saves no session and sends nothing (#1471).
    let refused = false;

    requestConfirm({
      id,
      payload: {
        type: 'connect',
        origin,
        network,
        networkRpc,
        appMeta,
        privateDataPermission: privateDataPermission || PrivateDataPermission.UponRequest,
        allowedPrivateData: allowedPrivateData || AllowedPrivateData.None,
        existingPermission
      },
      onDecline: () => {
        refused = true;
        reject(new Error(MidenDAppErrorType.NotGranted));
      },
      handleIntercomRequest: async (confirmReq, decline) => {
        if (confirmReq?.type === MidenMessageType.DAppPermConfirmationRequest && confirmReq?.id === id) {
          const { confirmed, accountPublicKey, privateDataPermission } = confirmReq;
          if (confirmed && accountPublicKey) {
            let publicKey: string;
            try {
              publicKey = await withUnlocked(async () => {
                // Wrap WASM client operations in a lock to prevent concurrent access
                return await withWasmClientLock(async hold => {
                  return await getAccountPublicKeyB64(accountPublicKey, hold);
                });
              });
            } catch (e) {
              console.error('Error fetching account public key:', e);
              // The user approved, so a failed read is no answer to the dApp (#1471): not NotGranted, and not the
              // read's error either, a kill included (#775). The throw fails this confirmation, so the window stays
              // open on its error with Retry, and the dApp waits for a Retry, a Cancel or the auto-decline.
              throw e;
            }
            if (refused) return { type: MidenMessageType.DAppPermConfirmationResponse };
            if (!existingPermission)
              await setDApp(origin, {
                network,
                appMeta,
                accountId: accountPublicKey,
                privateDataPermission: privateDataPermission || PrivateDataPermission.UponRequest,
                allowedPrivateData: allowedPrivateData || AllowedPrivateData.None,
                publicKey
              });
            resolve({
              type: MidenDAppMessageType.PermissionResponse,
              accountId: accountPublicKey,
              network,
              privateDataPermission: privateDataPermission || PrivateDataPermission.UponRequest,
              allowedPrivateData: allowedPrivateData || AllowedPrivateData.None,
              publicKey
            });
          } else {
            decline();
          }

          return {
            type: MidenMessageType.DAppPermConfirmationResponse
          };
        }
        return undefined;
      }
    }).catch(reject);
  });
}

const KEY_READ_PAST_DEADLINE = Symbol('key read past deadline');

// The approved account's key, or KEY_READ_PAST_DEADLINE once `deadline` passes first. A read still running then is
// abandoned, not cancelled: it keeps its WASM hold until it ends, and its key is never used.
async function readApprovedKeyBefore(
  deadline: number,
  accountPublicKey: string
): Promise<string | typeof KEY_READ_PAST_DEADLINE> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      withUnlocked(async () => {
        return await withWasmClientLock(async hold => {
          return await getAccountPublicKeyB64(accountPublicKey, hold);
        });
      }),
      new Promise<typeof KEY_READ_PAST_DEADLINE>(resolve => {
        timer = setTimeout(() => resolve(KEY_READ_PAST_DEADLINE), Math.max(0, deadline - Date.now()));
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Posts a confirmation on mobile or desktop and waits for the user's answer, bounded like the extension popup: a full
 * AUTODECLINE_AFTER, within what `deadline` leaves when the request waited for an unlock first.
 * Every non-extension sheet goes through here (#1414).
 */
async function requestConfirmationWithWatchdog(
  deadline: number | undefined,
  request: DAppConfirmationRequest
): Promise<DAppConfirmationResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      dappConfirmationStore.requestConfirmation(request),
      // Backstop watchdog, mirroring `requestConfirm`'s AUTODECLINE_AFTER on the
      // extension popup path. Without it a prompt that never reaches a renderer
      // (a routing bug, a session closed before its modal mounted) leaves this
      // promise pending forever, and because `processDApp` runs every request
      // through ONE `PQueue({concurrency: 1})` shared by every origin, that
      // wedges dApp handling process-wide until a full restart.
      new Promise<DAppConfirmationResult>(resolve => {
        timer = setTimeout(() => {
          // Only cancel OUR entry: the slot is keyed by session, and a later
          // request may already have replaced it.
          if (dappConfirmationStore.getPendingRequest(request.sessionId)?.id === request.id) {
            dappConfirmationStore.resolveConfirmation(request.sessionId, { confirmed: false });
          }
          resolve({ confirmed: false });
        }, timeLeftWithin(deadline));
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// What `confirmOnNonExtension` asks for: a kind on its own, or a login's with the site's domain and the account it
// signs in to, which only a login carries.
type ConfirmationKind =
  | Exclude<DAppConfirmationRequest['type'], 'loginSign'>
  | Pick<DAppLoginSignConfirmationRequest, 'type' | 'domain' | 'accountId'>;

/**
 * Raise a confirmation on the platforms that have no extension popup (mobile via
 * Capacitor, desktop via Tauri) and report whether the user approved.
 *
 * `requestConfirm` — the popup path — throws outright when `isExtension()` is
 * false. Five handlers used to reach it with no non-extension branch of their own
 * (`sign`, `importPrivateNote`, and the `UponRequest` arms of `privateNotes` /
 * `assets` / `consumableNotes`). Because each runs as an un-awaited async function
 * inside a promise executor, that throw never reached `reject` — it became an
 * unhandled rejection and the dApp's promise simply never settled, until the
 * injection script's 5-minute timeout reported the misleading "Request timeout".
 */
async function confirmOnNonExtension(
  kind: ConfirmationKind,
  origin: string,
  dApp: MidenDAppSession,
  networkRpc: string,
  detailMessages: string[],
  sessionId: string | undefined,
  deadline: number | undefined
): Promise<boolean> {
  const result = await requestConfirmationWithWatchdog(deadline, {
    id: nanoid(),
    sessionId,
    origin,
    appMeta: dApp.appMeta,
    network: dApp.network,
    networkRpc,
    privateDataPermission: dApp.privateDataPermission,
    allowedPrivateData: dApp.allowedPrivateData,
    existingPermission: true,
    transactionMessages: detailMessages,
    sourcePublicKey: dApp.accountId,
    ...(typeof kind === 'string' ? { type: kind } : kind)
  });
  return result.confirmed;
}

/**
 * True when `sourcePublicKey` (a dApp-supplied hex commitment) is the signing key
 * of the account this session authorizes.
 *
 * `MidenDAppSignRequest` carries `sourceAccountId` and `sourcePublicKey` as two
 * INDEPENDENT dApp-controlled strings: the session is looked up by the former,
 * but `Vault.signData` loads the secret key by the latter — every account's key is
 * stored under `accAuthSecretKeyStrgKey(<commitment hex>)` and all of them are
 * wrapped under the one vault key, so an unbound `sourcePublicKey` resolves for
 * ANY account the wallet owns. A page connected to account A could therefore name
 * A as the source account, pass account B's commitment (which it received from an
 * earlier connect, or read off a public on-chain account), and get back a
 * signature made with B's key — including a `signingInputs` signature, which
 * authorizes a transaction. Same defect class `executingAccountError` closes for
 * the send/custom paths; this closes it for the sign path.
 *
 * `dApp.publicKey` is base64 of the serialized commitment (`getAccountPublicKeyB64`
 * at connect); `MidenWindowObject.signBytes` sends `bytesToHex` of those same
 * bytes. A session with no stored public key fails CLOSED — it cannot be verified,
 * and reconnecting the dApp repopulates it.
 */
function isAuthorizedSigningKey(dApp: MidenDAppSession, sourcePublicKey: string): boolean {
  if (!dApp.publicKey) return false;
  // The same key in either encoding the wallet itself hands out: the base64 the
  // connect response carries verbatim, or the hex `MidenWindowObject.signBytes`
  // derives from it. Both name the SAME commitment, so accepting both binds just as
  // tightly — no other account's key satisfies either form.
  if (dApp.publicKey === sourcePublicKey) return true;
  const normalize = (hex: string) => (hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex).toLowerCase();
  try {
    return normalize(bytesToHex(b64ToU8(dApp.publicKey))) === normalize(sourcePublicKey);
  } catch {
    return false;
  }
}

export async function requestSign(
  origin: string,
  req: MidenDAppSignRequest,
  // PR-4 chunk 8 / multi-instance routing: the confirmation store keys pending
  // prompts by session id, and the mobile modal only renders the FOREGROUND
  // session's slot. Omitting this parked the prompt in the '__default__' slot
  // that no mobile renderer reads, so the promise never settled and the shared
  // concurrency-1 dApp queue wedged for every origin.
  sessionId?: string
): Promise<MidenDAppSignResponse> {
  if (!req?.sourcePublicKey) {
    throw new Error(MidenDAppErrorType.InvalidParams);
  }

  const dApp = await getDApp(origin, req.sourceAccountId);
  if (!dApp) {
    throw new Error(MidenDAppErrorType.NotGranted);
  }
  await assertRequestAccountIsCurrent(dApp.accountId);

  // Bind the signing KEY to the authorized ACCOUNT before anything prompts the
  // user: no approval surface can contradict a swapped key. The extension's
  // `sign` screen shows no account at all, and the mobile/desktop sheet's
  // `Account` row is `req.sourcePublicKey` — the very field being substituted —
  // so a request for account B under a session for account A renders B's address
  // and reads as consistent. The check therefore has to happen in code, before
  // any prompt. See isAuthorizedSigningKey.
  if (!isAuthorizedSigningKey(dApp, req.sourcePublicKey)) {
    throw new Error(`${MidenDAppErrorType.NotGranted}: signing key is not the connected account's key`);
  }

  // `.catch(reject)`: each `generatePromisify*` is an async function invoked
  // inside this executor, so a throw of its own would otherwise become an
  // unhandled rejection and leave the dApp's promise unsettled forever (the
  // caller only ever sees the injection script's 5-minute "Request timeout").
  return new Promise((resolve, reject) => {
    generatePromisifySign(resolve, reject, origin, dApp, req, sessionId).catch(reject);
  });
}

const generatePromisifySign = async (
  resolve: (value: MidenDAppSignResponse | PromiseLike<MidenDAppSignResponse>) => void,
  reject: (reason?: any) => void,
  origin: string,
  dApp: MidenDAppSession,
  req: MidenDAppSignRequest,
  sessionId?: string
) => {
  const id = nanoid();
  const networkRpc = await getNetworkRPC(dApp.network);

  // Mobile / desktop: no popup window exists, so prompt through the shared
  // confirmation store instead of falling into requestConfirm's throw.
  if (!isExtension()) {
    try {
      // The sheet cannot unlock, and posted while locked it would sit over the lock screen.
      const waits: UnlockWaits = {};
      if (isStoreLocked() && !(await waitForUnlockOnNonExtension(origin, waits))) {
        reject(lockedRefusal());
        return;
      }
      const confirmed = await confirmOnNonExtension(
        'sign',
        origin,
        dApp,
        networkRpc,
        await formatSignPreview(req),
        sessionId,
        waits.deadline
      );
      if (!confirmed) {
        reject(new Error(MidenDAppErrorType.NotGranted));
        return;
      }
      // The entry gate ran before the sheet opened; the session or the current account may have changed since (#1419).
      await assertDappSendStillAuthorized(origin, req.sourceAccountId, dApp.accountId);
      const signature = await withUnlocked(async ({ vault }) =>
        vault.signData(req.sourcePublicKey, req.payload, req.kind, req.sourceAccountId)
      );
      resolve({ type: MidenDAppMessageType.SignResponse, signature });
    } catch (e) {
      reject(dappSendFailure(e));
    }
    return;
  }

  await requestConfirm({
    id,
    payload: {
      type: 'sign',
      origin,
      networkRpc,
      appMeta: dApp.appMeta,
      sourcePublicKey: req.sourcePublicKey,
      payload: req.payload,
      kind: req.kind,
      preview: null
    },
    onDecline: () => {
      reject(new Error(MidenDAppErrorType.NotGranted));
    },
    handleIntercomRequest: async (confirmReq, decline) => {
      if (confirmReq?.type === MidenMessageType.DAppSignConfirmationRequest && confirmReq?.id === id) {
        if (confirmReq.confirmed) {
          // The key is authorized HERE, after approval, rather than at the top
          // of `requestSign`: resolving it reads the local client, and the
          // wallet is only reliably unlocked from this point. Checking earlier
          // would refuse legitimate requests that arrive while locked, which is
          // worse than approving and then declining.
          const authorized = await withUnlocked(() =>
            withWasmClientLock(hold => publicKeyBelongsToAccount(dApp.accountId, req.sourcePublicKey, hold))
          ).catch((err: unknown) => pipelineKillIn(err) ?? false);
          if (authorized !== true) {
            // A kill (a lock-recovery eviction, an offscreen abort or a
            // terminated client, issue #775) is not an authorization verdict:
            // reject an APPROVED request with the real, retryable failure
            // rather than a false NotGranted.
            reject(pipelineKillIn(authorized) ?? new Error(MidenDAppErrorType.NotGranted));
            return {
              type: MidenMessageType.DAppSignConfirmationResponse
            };
          }
          try {
            // See the mobile/desktop arm: same post-approval re-check.
            await assertDappSendStillAuthorized(origin, req.sourceAccountId, dApp.accountId);
            let signature = await withUnlocked(async ({ vault }) => {
              const signDataResult = await vault.signData(
                req.sourcePublicKey,
                req.payload,
                req.kind,
                req.sourceAccountId
              );
              return signDataResult;
            });
            resolve({
              type: MidenDAppMessageType.SignResponse,
              signature
            });
          } catch (e) {
            reject(dappSendFailure(e));
          }
        } else {
          decline();
        }

        return {
          type: MidenMessageType.DAppSignConfirmationResponse
        };
      }
      return undefined;
    }
  });
};

/**
 * A login signature: once the user approves, the account's login key for the page's domain signs the login message,
 * Poseidon2 of the login tag and the page's word, never the word itself. A word holds four little-endian u64 field
 * elements, each strictly below 0xffffffff00000001, in 32 bytes. The page chooses the word but not the message the key
 * signs, so it cannot make a login signature authorize a transaction.
 */
export async function requestLoginSign(
  origin: string,
  req: MidenDAppLoginSignRequest,
  // Routes the mobile and desktop prompt to the requesting session, as requestSign's does.
  sessionId?: string
): Promise<MidenDAppLoginSignResponse> {
  const { dApp, domain } = await loginKeySession(origin, req?.sourceAccountId);
  if (req.kind !== 'word' || !isLoginWord(req.payload)) {
    throw new Error(
      `${MidenDAppErrorType.InvalidParams}: a login signature signs only a word: 32 bytes holding four little-endian field elements`
    );
  }

  // Caught, as requestSign's is, or a throw of its own would leave the dApp's promise unsettled. Mapped as
  // requestLoginKey maps its failures, so a popup that fails to open reads the same from both.
  return new Promise((resolve, reject) => {
    generatePromisifyLoginSign(resolve, reject, origin, dApp, req, domain, sessionId).catch(error =>
      reject(dappRequestFailure(error))
    );
  });
}

const generatePromisifyLoginSign = async (
  resolve: (value: MidenDAppLoginSignResponse) => void,
  reject: (reason: unknown) => void,
  origin: string,
  dApp: MidenDAppSession,
  req: MidenDAppLoginSignRequest,
  domain: string,
  sessionId?: string
) => {
  const networkRpc = await getNetworkRPC(dApp.network);
  const checkRootKey = sessionLoginKey(dApp, domain);
  const sign = async (): Promise<MidenDAppLoginSignResponse> => {
    // The entry gate ran before the prompt; the session or the current account may have changed since (#1419).
    await assertDappSendStillAuthorized(origin, req.sourceAccountId, dApp.accountId);
    const signature = await withUnlocked(({ vault }) => vault.signWithLoginKey(dApp.accountId, domain, req.payload));
    return { type: MidenDAppMessageType.LoginSignResponse, signature };
  };

  if (!isExtension()) {
    try {
      // The sheet cannot unlock, and posted while locked it would sit over the lock screen.
      const waits: UnlockWaits = {};
      if (isStoreLocked() && !(await waitForUnlockOnNonExtension(origin, waits))) {
        reject(lockedRefusal());
        return;
      }
      // Unlocked from here, so a device without the account's root key is refused before the sheet opens.
      await checkRootKey();
      const login: ConfirmationKind = { type: 'loginSign', domain, accountId: dApp.accountId };
      if (!(await confirmOnNonExtension(login, origin, dApp, networkRpc, [], sessionId, waits.deadline))) {
        reject(new Error(MidenDAppErrorType.NotGranted));
        return;
      }
      resolve(await sign());
    } catch (e) {
      reject(dappRequestFailure(e));
    }
    return;
  }

  // A locked wallet's popup builds its payload once unlocked, so the root key is checked before the approval shows
  // either way: before the popup while unlocked, and after the popup's unlock while locked.
  const prepared = await prepareOrReject(checkRootKey, error => reject(dappRequestFailure(error)));
  if (prepared === undefined) return;
  const sheet = sheetFor(prepared, origin, req.sourceAccountId, dApp.accountId, checkRootKey);
  const id = nanoid();
  await requestConfirmFor(origin, sheet, error => reject(dappRequestFailure(error)), {
    id,
    payload: async () => {
      await sheet.data();
      return { type: 'loginSign', origin, networkRpc, appMeta: dApp.appMeta, domain, accountId: dApp.accountId };
    },
    handleIntercomRequest: async (confirmReq, decline) => {
      if (confirmReq?.type !== MidenMessageType.DAppSignConfirmationRequest || confirmReq.id !== id) {
        return undefined;
      }
      if (confirmReq.confirmed) {
        try {
          resolve(await sign());
        } catch (e) {
          reject(dappRequestFailure(e));
        }
      } else {
        decline();
      }
      return { type: MidenMessageType.DAppSignConfirmationResponse };
    }
  });
};

// The session a login key request acts for, and the domain whose key it uses. The domain is read from `origin`, the
// page's real origin, never from the request, so a page reaches only its own site's key.
async function loginKeySession(
  origin: string,
  sourceAccountId: string | undefined
): Promise<{ dApp: MidenDAppSession; domain: string }> {
  if (!sourceAccountId) {
    throw new Error(MidenDAppErrorType.InvalidParams);
  }
  const dApp = await getDApp(origin, sourceAccountId);
  if (!dApp) {
    throw new Error(MidenDAppErrorType.NotGranted);
  }
  await assertRequestAccountIsCurrent(dApp.accountId);
  return { dApp, domain: loginKeyDomain(origin) };
}

// The account comes from the stored session, never from the request.
const sessionLoginKey = (dApp: MidenDAppSession, domain: string) => () =>
  withUnlocked(({ vault }) => vault.loginKeyCommitment(dApp.accountId, domain));

function isLoginWord(payload: unknown): boolean {
  if (typeof payload !== 'string') return false;
  return fieldWordFromBase64(payload) !== null;
}

const hasDAppErrorCode = (message: string): boolean =>
  Object.values(MidenDAppErrorType).some(code => message === code || message.startsWith(`${code}:`));

export async function requestPrivateNotes(
  origin: string,
  req: MidenDAppPrivateNotesRequest,
  // PR-4 chunk 8 / multi-instance routing: the confirmation store keys pending
  // prompts by session id, and the mobile modal only renders the FOREGROUND
  // session's slot. Omitting this parked the prompt in the '__default__' slot
  // that no mobile renderer reads, so the promise never settled and the shared
  // concurrency-1 dApp queue wedged for every origin.
  sessionId?: string
): Promise<MidenDAppPrivateNotesResponse> {
  if (!req?.sourcePublicKey) {
    throw new Error(MidenDAppErrorType.InvalidParams);
  }

  const dApp = await getDApp(origin, req.sourcePublicKey);
  if (!dApp) {
    throw new Error(MidenDAppErrorType.NotGranted);
  }
  await assertRequestAccountIsCurrent(dApp.accountId);

  // `.catch(reject)`: each `generatePromisify*` is an async function invoked
  // inside this executor, so a throw of its own would otherwise become an
  // unhandled rejection and leave the dApp's promise unsettled forever (the
  // caller only ever sees the injection script's 5-minute "Request timeout").
  return new Promise((resolve, reject) => {
    generatePromisifyRequestPrivateNotes(resolve, reject, origin, dApp, req, sessionId).catch(reject);
  });
}

const generatePromisifyRequestPrivateNotes = (
  resolve: (value: MidenDAppPrivateNotesResponse | PromiseLike<MidenDAppPrivateNotesResponse>) => void,
  reject: (reason?: any) => void,
  origin: string,
  dApp: MidenDAppSession,
  req: MidenDAppPrivateNotesRequest,
  sessionId?: string
) =>
  servePrivateDataRead<InputNoteDetails[], MidenDAppPrivateNotesResponse>(
    resolve,
    reject,
    origin,
    dApp,
    req.sourcePublicKey,
    sessionId,
    {
      allowed: AllowedPrivateData.Notes,
      prepare: () => getPrivateNoteDetails(dApp.accountId, req.notefilterType, req.noteIds),
      respond: privateNotes => ({ type: MidenDAppMessageType.PrivateNotesResponse, privateNotes }),
      lines: privateNotes => ['This app is requesting your private notes.', `Notes, ${privateNotes.length}`],
      payload: (base, privateNotes) => ({ ...base, type: 'privateNotes', privateNotes }),
      confirmation: MidenMessageType.DAppPrivateNotesConfirmationRequest,
      confirmationResponse: MidenMessageType.DAppPrivateNotesConfirmationResponse
    }
  );

function noteFilterTypeToQuery(filterType: NoteFilterTypes, noteIds?: string[]): NoteQuery | undefined {
  if (filterType === NoteFilterTypes.List && noteIds) return { ids: noteIds };
  const statusMap: Record<string, string> = {
    [NoteFilterTypes.Consumed]: 'consumed',
    [NoteFilterTypes.Committed]: 'committed',
    [NoteFilterTypes.Expected]: 'expected',
    [NoteFilterTypes.Processing]: 'processing',
    [NoteFilterTypes.Unverified]: 'unverified'
  };
  const status = statusMap[filterType as unknown as string];
  if (status) return { status } as NoteQuery;
  return undefined;
}

/**
 * Private input notes belonging to `accountId` — the account this dApp session is
 * connected to, NOT the whole wallet.
 *
 * `midenClientProxy.getInputNoteDetails(query)` reaches `client.notes.list(query)`,
 * and a `NoteQuery` is only ever `{ ids }` or `{ status }` — it has no account
 * field, and every account in the wallet shares the one MidenClient store. So the
 * unscoped read returned the id, nullifier, sender, state and per-asset amounts of
 * EVERY private note in the wallet, including accounts the user never connected,
 * while the approval screen promises "Share all private note data for account
 * <connected account>" (ConfirmPage's `sharePrivateNoteDataForAccount`). Under
 * `PrivateDataPermission.Auto` there is no prompt at all, so a connected page could
 * poll it and watch every account's private balances.
 *
 * Scoping is by CONSUMABILITY, which is the only per-account note attribution the
 * SDK exposes (`getConsumableNotes(accountId)`). That can under-report — a note
 * that is already consumed, or not yet consumable, cannot be attributed to an
 * account and is withheld — but it can never over-report across accounts, which is
 * the property the user consented to. Intersecting also covers a caller that names
 * another account's note ids explicitly via `req.noteIds`.
 *
 * With the List filter, every requested id is also looked up as the details
 * commitment `importPrivateNote` returns (#1536), hashing only this account's
 * consumable notes. Matches are listed under their own note ids, once per note.
 */
async function getPrivateNoteDetails(
  accountId: string,
  notefilterType: NoteFilterTypes,
  noteIds?: string[]
): Promise<InputNoteDetails[]> {
  let privateNotes: InputNoteDetails[] = [];
  try {
    privateNotes = await withUnlocked(async () => {
      return await withWasmClientLock(async hold => {
        const query = noteFilterTypeToQuery(notefilterType, noteIds);
        const allNotes = await midenClientProxy.getInputNoteDetails(query, () =>
          assertWasmHoldCurrent(hold, 'inside the private-note read, before the record reach-through')
        );
        // An eviction hands the mutex to a successor without stopping this callback,
        // so every subsequent client read must first prove this hold is still current.
        assertWasmHoldCurrent(hold, 'after the private-note read');
        const listed = notefilterType === NoteFilterTypes.List ? (noteIds ?? []) : [];
        // Every listed id is looked up as a commitment too, found by the id read or not, so an id another account
        // holds takes the same path as one nobody holds and the timing tells a dApp nothing about other accounts.
        const asked = new Set<string>();
        const commitments = listed.filter(id => {
          const key = normalizedCommitment(id);
          if (asked.has(key)) return false;
          asked.add(key);
          return true;
        });
        const ownNoteIds = new Set(
          (
            await midenClientProxy.getConsumableNotes(accountId, step =>
              assertWasmHoldCurrent(hold, 'inside the consumable-notes read', step)
            )
          ).flatMap(note => (note.noteId ? [note.noteId] : []))
        );
        if (commitments.length > 0) assertWasmHoldCurrent(hold, 'after the consumable-notes read');
        const byCommitment =
          commitments.length === 0
            ? []
            : (
                await midenClientProxy.getDetailsCommitmentMatches(commitments, [...ownNoteIds], () =>
                  assertWasmHoldCurrent(
                    hold,
                    'inside the private-note details-commitment read, before the record reach-through'
                  )
                )
              ).flatMap(match => match.notes);
        const candidates = [...allNotes, ...byCommitment];
        const seen = new Set<string>();
        const uniqueCandidates =
          notefilterType === NoteFilterTypes.List
            ? candidates.filter(note => {
                const id = normalizedCommitment(note.noteId);
                if (seen.has(id)) return false;
                seen.add(id);
                return true;
              })
            : candidates;
        // `restriction` is the wallet's own consume guard and `nonFungibleAssets` feeds only its own approval sheet,
        // not note data the user agreed to share.
        return uniqueCandidates
          .filter(note => note.noteType === NoteType.Private && ownNoteIds.has(note.noteId))
          .map(({ restriction: _restriction, nonFungibleAssets: _nonFungibleAssets, ...note }) => note);
      });
    });
    return privateNotes;
  } catch (e) {
    throw dappReadFailure(e);
  }
}

export async function requestConsumableNotes(
  origin: string,
  req: MidenDAppConsumableNotesRequest,
  // PR-4 chunk 8 / multi-instance routing: the confirmation store keys pending
  // prompts by session id, and the mobile modal only renders the FOREGROUND
  // session's slot. Omitting this parked the prompt in the '__default__' slot
  // that no mobile renderer reads, so the promise never settled and the shared
  // concurrency-1 dApp queue wedged for every origin.
  sessionId?: string
): Promise<MidenDAppConsumableNotesResponse> {
  if (!req?.sourcePublicKey) {
    throw new Error(MidenDAppErrorType.InvalidParams);
  }

  const dApp = await getDApp(origin, req.sourcePublicKey);
  if (!dApp) {
    throw new Error(MidenDAppErrorType.NotGranted);
  }
  await assertRequestAccountIsCurrent(dApp.accountId);

  // `.catch(reject)`: each `generatePromisify*` is an async function invoked
  // inside this executor, so a throw of its own would otherwise become an
  // unhandled rejection and leave the dApp's promise unsettled forever (the
  // caller only ever sees the injection script's 5-minute "Request timeout").
  return new Promise((resolve, reject) => {
    generatePromisifyRequestConsumableNotes(resolve, reject, origin, dApp, req, sessionId).catch(reject);
  });
}

export const generatePromisifyRequestConsumableNotes = (
  resolve: (value: MidenDAppConsumableNotesResponse | PromiseLike<MidenDAppConsumableNotesResponse>) => void,
  reject: (reason?: any) => void,
  origin: string,
  dApp: MidenDAppSession,
  req: MidenDAppConsumableNotesRequest,
  sessionId?: string
) =>
  servePrivateDataRead<InputNoteDetails[], MidenDAppConsumableNotesResponse>(
    resolve,
    reject,
    origin,
    dApp,
    req.sourcePublicKey,
    sessionId,
    {
      allowed: AllowedPrivateData.Notes,
      prepare: () => getConsumableNotes(dApp.accountId),
      respond: consumableNotes => ({ type: MidenDAppMessageType.ConsumableNotesResponse, consumableNotes }),
      lines: consumableNotes => ['This app is requesting your consumable notes.', `Notes, ${consumableNotes.length}`],
      payload: (base, consumableNotes) => ({ ...base, type: 'consumableNotes', consumableNotes }),
      confirmation: MidenMessageType.DAppConsumableNotesConfirmationRequest,
      confirmationResponse: MidenMessageType.DAppConsumableNotesConfirmationResponse
    }
  );

async function getConsumableNotes(accountId: string): Promise<InputNoteDetails[]> {
  let consumableNotes: InputNoteDetails[] = [];
  try {
    consumableNotes = await withUnlocked(async () => {
      // Wrap WASM client operations in a lock to prevent concurrent access
      return await withWasmClientLock(async hold => {
        await midenClientProxy.syncState();
        // Sync is THE parking await on this path (network-bound, tens of seconds
        // on a slow node) — a watchdog eviction during it hands the mutex to a
        // successor, and the consumable-notes read below would be a second
        // borrow of a client somebody else is inside.
        assertWasmHoldCurrent(hold, 'after the consumable-notes sync');
        // Consumable notes as DTOs (issue #260, slice 4). The reclaim gate + the
        // reduction ran in the client's realm (offscreen when the flag is on, so
        // it uses the same realm that just ran syncState above — no stale height).
        // The DTO is a strict superset of InputNoteDetails; map it 1:1.
        const notes = await midenClientProxy.getConsumableNotes(accountId, step =>
          assertWasmHoldCurrent(hold, 'inside the consumable-notes read', step)
        );
        return notes.flatMap<InputNoteDetails>(note => {
          // Partial (metadata-less) notes have no ID — and, since 0.15
          // nullifiers fold in metadata, no nullifier either. They cannot
          // be consumed, so skip until sync completes them.
          if (!note.noteId || !note.nullifier) {
            return [];
          }
          return [
            {
              noteId: note.noteId,
              noteType: note.noteType,
              senderAccountId: note.senderAccountId,
              nullifier: note.nullifier,
              state: note.state,
              assets: note.assets
            }
          ];
        });
      });
    });
    return consumableNotes;
  } catch (e) {
    throw dappReadFailure(e);
  }
}

export async function requestAssets(
  origin: string,
  req: MidenDAppAssetsRequest,
  // PR-4 chunk 8 / multi-instance routing: the confirmation store keys pending
  // prompts by session id, and the mobile modal only renders the FOREGROUND
  // session's slot. Omitting this parked the prompt in the '__default__' slot
  // that no mobile renderer reads, so the promise never settled and the shared
  // concurrency-1 dApp queue wedged for every origin.
  sessionId?: string
): Promise<MidenDAppAssetsResponse> {
  if (!req?.sourcePublicKey) {
    throw new Error(MidenDAppErrorType.InvalidParams);
  }

  const dApp = await getDApp(origin, req.sourcePublicKey);
  if (!dApp) {
    throw new Error(MidenDAppErrorType.NotGranted);
  }
  await assertRequestAccountIsCurrent(dApp.accountId);

  // `.catch(reject)`: each `generatePromisify*` is an async function invoked
  // inside this executor, so a throw of its own would otherwise become an
  // unhandled rejection and leave the dApp's promise unsettled forever (the
  // caller only ever sees the injection script's 5-minute "Request timeout").
  return new Promise((resolve, reject) => {
    generatePromisifyRequestAssets(resolve, reject, origin, dApp, req, sessionId).catch(reject);
  });
}

export const generatePromisifyRequestAssets = (
  resolve: (value: MidenDAppAssetsResponse | PromiseLike<MidenDAppAssetsResponse>) => void,
  reject: (reason?: any) => void,
  origin: string,
  dApp: MidenDAppSession,
  req: MidenDAppAssetsRequest,
  sessionId?: string
) =>
  servePrivateDataRead<Asset[], MidenDAppAssetsResponse>(
    resolve,
    reject,
    origin,
    dApp,
    req.sourcePublicKey,
    sessionId,
    {
      allowed: AllowedPrivateData.Assets,
      prepare: () => getAssets(dApp.accountId),
      respond: assets => ({ type: MidenDAppMessageType.AssetsResponse, assets }),
      lines: assets => ['This app is requesting your account balances.', `Assets, ${assets.length}`],
      payload: (base, assets) => ({ ...base, type: 'assets', assets }),
      confirmation: MidenMessageType.DAppAssetsConfirmationRequest,
      confirmationResponse: MidenMessageType.DAppAssetsConfirmationResponse
    }
  );

async function getAssets(accountId: string): Promise<Asset[]> {
  let assets: Asset[] = [];
  try {
    assets = await withUnlocked(async () => {
      // Wrap WASM client operations in a lock to prevent concurrent access
      return await withWasmClientLock(async hold => {
        const account = await midenClientProxy.getAccount(accountId);
        // Before the borrow chain: `vault()` / `fungibleAssets()` / `faucetId()`
        // / `amount()` are WASM calls on an Account borrowed from the client's
        // RefCell, so touching them after an eviction during the account read IS
        // the double borrow, not merely a stale balance.
        assertWasmHoldCurrent(hold, 'after the assets account read');
        const fungibleAssets = account?.vault().fungibleAssets() || [];
        const balances = fungibleAssets.map(asset => ({
          faucetId: getBech32AddressFromAccountId(asset.faucetId()),
          amount: asset.amount().toString()
        })) as Asset[];
        return balances;
      });
    });

    return assets;
  } catch (e) {
    throw dappReadFailure(e);
  }
}

// Answers directly while unlocked (mirrors getCurrentPermission): guardian info is non-sensitive. Locked, it needs the
// unlock all the same, since the account records it reads are encrypted (#1414).
export async function requestGuardianInfo(
  origin: string,
  req: MidenDAppGuardianInfoRequest
): Promise<MidenDAppGuardianInfoResponse> {
  if (!req?.sourcePublicKey) {
    throw new Error(MidenDAppErrorType.InvalidParams);
  }

  const dApp = await getDApp(origin, req.sourcePublicKey);
  if (!dApp) {
    throw new Error(MidenDAppErrorType.NotGranted);
  }
  await assertRequestAccountIsCurrent(dApp.accountId);

  const guardianInfo = await prepareWithoutPrompt(origin, dApp, req.sourcePublicKey, () =>
    getGuardianInfoData(dApp.accountId)
  );
  return { type: MidenDAppMessageType.GuardianInfoResponse, guardianInfo };
}

const NOT_GUARDIAN_INFO: GuardianInfo = {
  isGuardianAccount: false,
  guardianEndpoint: null,
  guardianProvider: null,
  guardianSyncStatus: null
};

async function getGuardianInfoData(accountId: string): Promise<GuardianInfo> {
  return withUnlocked(async ({ vault }) => {
    const accounts = await vault.fetchAccounts();
    // Tolerant match: the dApp-connected id may be the bare bech32 address while
    // the stored publicKey is a composite `<address>_<suffix>`.
    const account = accounts.find(acc => sameWalletAccountId(acc.publicKey, accountId));
    if (!account || account.type !== WalletType.Guardian) {
      return NOT_GUARDIAN_INFO;
    }

    const guardianEndpoint = resolveGuardianEndpoint(account);
    return {
      isGuardianAccount: true,
      guardianEndpoint: guardianEndpoint || null,
      guardianProvider: guardianProviderFromEndpoint(guardianEndpoint || null),
      guardianSyncStatus: dappGuardianSyncStatus(account)
    };
  });
}

// Answers without a prompt, as requestGuardianInfo does: the commitment signs nothing, and every login signature is
// approved in the wallet. Locked, it needs the unlock all the same, since the vault holds the root key.
export async function requestLoginKey(
  origin: string,
  req: MidenDAppLoginKeyRequest
): Promise<MidenDAppLoginKeyResponse> {
  const { dApp, domain } = await loginKeySession(origin, req?.sourceAccountId);
  const prepare = sessionLoginKey(dApp, domain);
  // Mapped at this boundary, not in `prepare`: `runPrepare` must still see a lock as one.
  try {
    const loginKey = await prepareWithoutPrompt(origin, dApp, req.sourceAccountId, prepare);
    return { type: MidenDAppMessageType.LoginKeyResponse, loginKey };
  } catch (error) {
    throw dappRequestFailure(error);
  }
}

export async function requestImportPrivateNote(
  origin: string,
  req: MidenDAppImportPrivateNoteRequest,
  // PR-4 chunk 8 / multi-instance routing: the confirmation store keys pending
  // prompts by session id, and the mobile modal only renders the FOREGROUND
  // session's slot. Omitting this parked the prompt in the '__default__' slot
  // that no mobile renderer reads, so the promise never settled and the shared
  // concurrency-1 dApp queue wedged for every origin.
  sessionId?: string
): Promise<MidenDAppImportPrivateNoteResponse> {
  if (!req?.sourcePublicKey || !req?.note) {
    throw new Error(MidenDAppErrorType.InvalidParams);
  }

  const dApp = await getDApp(origin, req.sourcePublicKey);
  if (!dApp) {
    throw new Error(MidenDAppErrorType.NotGranted);
  }
  await assertRequestAccountIsCurrent(dApp.accountId);

  // `.catch(reject)`: each `generatePromisify*` is an async function invoked
  // inside this executor, so a throw of its own would otherwise become an
  // unhandled rejection and leave the dApp's promise unsettled forever (the
  // caller only ever sees the injection script's 5-minute "Request timeout").
  return new Promise((resolve, reject) => {
    generatePromisifyImportPrivateNote(resolve, reject, origin, dApp, req, sessionId).catch(reject);
  });
}

/**
 * Imports a dApp-supplied private note into the client store, shared by the
 * extension popup path and the mobile/desktop confirmation-store path so the two
 * cannot drift.
 *
 * Route through the offscreen proxy (issue #260, slice 7c): this is a STORE WRITE
 * (a claimable private note imported by a dApp flow). Flag-ON the note MUST land
 * in the OFFSCREEN client's store — the realm that syncs and consumes — else it
 * would import into the dormant SW store and be unclaimable. Flag-OFF each proxy
 * method is byte-identical to the former inline `getMidenClient().importNoteBytes()`
 * / `.syncState()` (verbatim getMidenClient path under this caller's lock).
 *
 * Don't lose the note on a transient blip (resilience gap 1): a private note's
 * bytes can be its only copy. Queue it for the background import loop (wall-clock
 * retry + backoff, dead-letter on give-up) before rethrowing. Only transient
 * failures are re-queued — a genuinely malformed note would just dead-letter.
 */
async function importDAppPrivateNote(note: string): Promise<string> {
  try {
    return await withUnlocked(async () =>
      withWasmClientLock(async hold => {
        const noteAsUint8Array = b64ToU8(note);
        const noteId = await midenClientProxy.importNoteBytes(noteAsUint8Array, hold);
        // Between the import and its sync: an eviction while the import was
        // parked leaves it unknown whether the note landed, and the sync below
        // would borrow a client a successor now owns. The poison throw routes
        // through the catch below into the same queue-for-background-retry path
        // as an eviction of the import itself — the note is preserved either way.
        assertWasmHoldCurrent(hold, 'between the dApp note import and its sync');
        await midenClientProxy.syncState();
        return noteId;
      })
    );
  } catch (e) {
    // Every kill shape, for the reason the same gate in `back/main.ts` gives: an eviction,
    // a deadline kill or a terminated client leaves it unknown whether the note landed, so
    // the note has to be preserved. This is the sharper of the two sites: the dApp is the only
    // other holder of these bytes.
    //
    // Of the three, the poison and the terminated client are the shapes `isLikelyNetworkError`
    // genuinely misses (their messages are closed text). The abort shape reaches the classifier
    // as a match today purely because its message contains 'aborted', which is a
    // coincidence of transport-text heuristics rather than a contract — so it is named
    // here too, and the clause stays load-bearing the moment that token list is re-tuned.
    if (isLikelyNetworkError(e) || pipelineKillIn(e) !== undefined) {
      await queueNoteImport(note).catch(queueError =>
        console.error('[importDAppPrivateNote] failed to queue the note for background retry', queueError)
      );
    }
    throw e;
  }
}

/**
 * Imports carried bytes checked against the request's id, which may be their note id or details commitment.
 * The resolved store id is used to consume the note, never to validate the bytes. Unreadable bytes are not imported;
 * the consume reads the note from the store or refuses it. A decode that traps rejects its WASM hold.
 */
async function importConsumeNoteBytes(transaction: MidenConsumeTransaction): Promise<void> {
  const { noteId, noteBytes } = transaction;
  if (!noteBytes) return;
  const carried = await decodeCarriedConsumeNoteLocked(transaction);
  if (!carried) {
    let carriedId: string | null = null;
    try {
      carriedId = await withWasmClientLock(async () => noteIdFromBytes(b64ToU8(noteBytes)));
    } catch (e) {
      const kill = pipelineKillIn(e);
      if (kill !== undefined) throw kill;
      if (e instanceof WebAssembly.RuntimeError) throw e;
      // Invalid base64 reads as unreadable bytes.
    }
    if (carriedId === null) return;
    if (carriedId !== noteId) {
      throw new Error('noteBytes describe a different note than noteId - refusing to consume it');
    }
  }
  await importDAppPrivateNote(noteBytes);
}

export const generatePromisifyImportPrivateNote = async (
  resolve: (value: MidenDAppImportPrivateNoteResponse | PromiseLike<MidenDAppImportPrivateNoteResponse>) => void,
  reject: (reason?: any) => void,
  origin: string,
  dApp: MidenDAppSession,
  req: MidenDAppImportPrivateNoteRequest,
  sessionId?: string
) => {
  const id = nanoid();
  const networkRpc = await getNetworkRPC(dApp.network);

  if (!isExtension()) {
    try {
      // The sheet cannot unlock, and posted while locked it would sit over the lock screen.
      const waits: UnlockWaits = {};
      if (isStoreLocked() && !(await waitForUnlockOnNonExtension(origin, waits))) {
        reject(lockedRefusal());
        return;
      }
      const confirmed = await confirmOnNonExtension(
        'importPrivateNote',
        origin,
        dApp,
        networkRpc,
        [`Account, ${truncateAddress(dApp.accountId)}`],
        sessionId,
        waits.deadline
      );
      if (!confirmed) {
        reject(new Error(MidenDAppErrorType.NotGranted));
        return;
      }
      await assertDappSendStillAuthorized(origin, req.sourcePublicKey, dApp.accountId);
      const noteId = await importDAppPrivateNote(req.note);
      resolve({ type: MidenDAppMessageType.ImportPrivateNoteResponse, noteId });
    } catch (e) {
      reject(dappRequestFailure(e));
    }
    return;
  }

  await requestConfirm({
    id,
    payload: {
      type: 'importPrivateNote',
      origin,
      networkRpc,
      appMeta: dApp.appMeta,
      sourcePublicKey: req.sourcePublicKey,
      note: req.note,
      preview: null
    },
    onDecline: () => {
      reject(new Error(MidenDAppErrorType.NotGranted));
    },
    handleIntercomRequest: async (confirmReq, decline) => {
      if (confirmReq?.type === MidenMessageType.DAppImportPrivateNoteConfirmationRequest && confirmReq?.id === id) {
        if (confirmReq.confirmed) {
          try {
            await assertDappSendStillAuthorized(origin, req.sourcePublicKey, dApp.accountId);
            const noteId = await importDAppPrivateNote(req.note);
            resolve({
              type: MidenDAppMessageType.ImportPrivateNoteResponse,
              // Hex string: the note ID for metadata-bearing files, or the
              // details commitment for details-only imports (the common
              // dApp `noteBytes` path). `requestConsume` accepts either (#1389).
              noteId
            });
          } catch (e) {
            reject(dappRequestFailure(e));
          }
        } else {
          decline();
        }

        return {
          type: MidenMessageType.DAppImportPrivateNoteConfirmationResponse
        };
      }
      return undefined;
    }
  });
};

export async function requestTransaction(
  origin: string,
  req: MidenDAppTransactionRequest,
  // PR-4 chunk 8: optional multi-instance session id.
  sessionId?: string
): Promise<MidenDAppTransactionResponse> {
  dappDebug('requestTransaction, dapp.ts', req);
  if (!req?.sourcePublicKey || !req?.transaction) {
    throw new Error(MidenDAppErrorType.InvalidParams);
  }

  const dApp = await getDApp(origin, req.sourcePublicKey);

  if (!dApp) {
    throw new Error(MidenDAppErrorType.NotGranted);
  }
  await assertRequestAccountIsCurrent(dApp.accountId);

  // `.catch(reject)`: each `generatePromisify*` is an async function invoked
  // inside this executor, so a throw of its own would otherwise become an
  // unhandled rejection and leave the dApp's promise unsettled forever (the
  // caller only ever sees the injection script's 5-minute "Request timeout").
  return new Promise((resolve, reject) => {
    generatePromisifyTransaction(resolve, reject, origin, dApp, req, sessionId).catch(reject);
  });
}

export function buildCustomTxConfirmPayload(args: {
  origin: string;
  networkRpc: string;
  appMeta: DappMetadata;
  sourcePublicKey: string;
  transactionMessages: string[];
  customTransaction: MidenCustomTransaction;
  spendingLimitDetails?: SpendingLimitAssessmentDetails;
}): MidenDAppTransactionPayload {
  const { customTransaction: tx } = args;
  return {
    type: 'transaction',
    origin: args.origin,
    networkRpc: args.networkRpc,
    appMeta: args.appMeta,
    sourcePublicKey: args.sourcePublicKey,
    transactionMessages: args.transactionMessages,
    preview: null,
    ...(args.spendingLimitDetails !== undefined &&
      args.spendingLimitDetails.assessment.breach !== undefined && {
        spendingLimitAssessment: toSerializedSpendingLimitAssessment(args.spendingLimitDetails.assessment)
      }),
    txKind: 'custom',
    requestBytes: tx.transactionRequest,
    importNotes: tx.importNotes,
    recipientAddress: tx.recipientAddress || undefined
  };
}

/**
 * Builds the intercom handler that answers a `DAppSimulateTransactionRequest`
 * for THIS confirm popup (matched by id) with the ground-truth summary. Returns
 * `undefined` for non-matching requests so the caller keeps dispatching.
 */
export function makeSimulateHandler(
  id: string,
  tx: MidenCustomTransaction,
  /**
   * The dry run the caller already performed for this confirm id. Answering from it keeps the
   * request simulated once: the sheet renders the same execution the spending-limit policy
   * assessed, and the WASM lock is taken once rather than twice per approval.
   */
  simulated?: { summaryBytes?: string; executedBytes?: string; error?: string }
) {
  return async (req: MidenRequest): Promise<any | undefined> => {
    if (req?.type !== MidenMessageType.DAppSimulateTransactionRequest || (req as any).id !== id) {
      return undefined;
    }
    // Only a SUCCESSFUL dry run is reusable. A timeout or a WASM-lock eviction resolves as
    // `{ error }`, and caching that would leave the sheet's verified asset view - an anti-phishing
    // control - permanently unavailable for this confirm id, even once the lock frees.
    const reusable = simulated?.summaryBytes !== undefined || simulated?.executedBytes !== undefined;
    const { summaryBytes, executedBytes, error } =
      reusable && simulated
        ? simulated
        : await simulateCustomTransaction({
            address: tx.address,
            transactionRequest: tx.transactionRequest,
            importNotes: tx.importNotes
          });
    return {
      type: MidenMessageType.DAppSimulateTransactionResponse,
      summaryBytes,
      executedBytes,
      error: error === undefined ? undefined : dryRunFailureReason(error)
    };
  };
}

/**
 * Delegated-proving flag for a mobile/desktop dApp write.
 *
 * The extension threads the user's Settings toggle through its confirm popup
 * (`ConfirmPage` reads `isDelegateProofEnabled()` and returns it as
 * `confirmReq.delegate`); the mobile modal and the desktop overlay now do the
 * same via `DAppConfirmationResult.delegate`. These three call sites used to
 * pass a literal `true`, so a user who had turned Delegated proving OFF still
 * had every dApp transaction shipped to the remote prover on two of the three
 * platforms, with no UI indication.
 *
 * Falls back to `DEFAULT_DELEGATE_PROOF` when a resolver supplies no flag,
 * which is the same value `isDelegateProofEnabled()` returns for a user who
 * never touched the setting.
 */
function delegateFromConfirmation(result: DAppConfirmationResult): boolean {
  return result.delegate ?? DEFAULT_DELEGATE_PROOF;
}

const DAPP_SPENDING_LIMIT_RETRY = 'Spending limit changed. Review and retry the transaction.';

/**
 * The one message a dApp ever sees for a spending-limit refusal it can retry past (a policy or
 * price read that failed, or a stale authorization). One place decides the text so every throw
 * site - the send path's `dappSendFailure` and the custom path's own conversion below - says the
 * same thing for the same underlying condition.
 */
const spendingLimitRetryError = (): Error =>
  new Error(`${MidenDAppErrorType.NotGranted}: ${DAPP_SPENDING_LIMIT_RETRY}`);

const authorizationForDappSend = (
  details: SpendingLimitAssessmentDetails | undefined,
  strictlyAuthenticated: boolean | undefined,
  spends: readonly IConsumedAssetTotal[]
): SpendingLimitAuthorization | undefined => {
  if (details === undefined || details.assessment.breach === undefined) return undefined;
  if (strictlyAuthenticated !== true) throw new Error(MidenDAppErrorType.NotGranted);
  return createSpendingLimitAuthorization(details.assessment, spends);
};

/**
 * Spending-limit state for a dApp CUSTOM request, or a refusal.
 *
 * A custom request states its value only through the dry run, so an unknown `outgoing` is refused
 * whenever the account has any limit configured - otherwise "make the simulation fail" is the
 * bypass. A dollar figure sums across every asset the request moves, so there is exactly one
 * charge and one authorization to bind it to - unlike the old per-asset caps, nothing here refuses
 * a request for covering more than one asset.
 */
const customSpendingLimitState = async (
  accountId: string,
  outgoing: IConsumedAssetTotal[] | undefined
): Promise<{ totals: IConsumedAssetTotal[]; details?: SpendingLimitAssessmentDetails }> => {
  if (outgoing === undefined) {
    if (await hasSpendingLimits(accountId)) throw new Error(MidenDAppErrorType.NotGranted);
    return { totals: [] };
  }
  try {
    const details = await assessOutgoingSpendingLimitDetails({ accountId, spends: outgoing });
    return { totals: outgoing, details: details?.assessment.breach === undefined ? undefined : details };
  } catch (error) {
    // An untrusted page cannot spend against a cap the wallet cannot value, so ordinary price
    // failures become the same retry refusal as the send path at this boundary. A kill must
    // keep its cause chain for the caller's mapper to return the kill link instead.
    if (pipelineKillIn(error) === undefined && isSpendingLimitPriceUnavailable(error)) throw spendingLimitRetryError();
    throw error;
  }
};

// A request names the account it acts for; answering one that is not current would show or act on an account the
// user is not looking at (#1419). The vault's plain-storage read works while locked, unlike the store.
const assertRequestAccountIsCurrent = async (accountId: string): Promise<void> => {
  const current = await Vault.getCurrentAccountPublicKey();
  if (!current || !sameWalletAccountId(current, accountId)) {
    throw new Error(MidenDAppErrorType.NotGranted);
  }
};

// Every prompted request runs this after approval and before it answers or acts: the sheet may have sat open while
// the dApp was disconnected or the user switched accounts (#1419, #1415).
const assertDappSendStillAuthorized = async (
  origin: string,
  sourcePublicKey: string,
  senderAddress: string
): Promise<void> => {
  const liveSession = await getDApp(origin, sourcePublicKey);
  const currentAccount = store.getState().currentAccount?.publicKey;
  if (
    liveSession === undefined ||
    currentAccount === undefined ||
    !sameWalletAccountId(liveSession.accountId, senderAddress) ||
    !sameWalletAccountId(currentAccount, senderAddress)
  ) {
    throw new Error(MidenDAppErrorType.NotGranted);
  }
};

const dappSendFailure = (error: unknown): unknown => {
  const kill = pipelineKillIn(error);
  if (kill !== undefined) return kill;
  if (spendingLimitAssessmentFromError(error) !== undefined) {
    return spendingLimitRetryError();
  }
  // A policy that cannot be evaluated, and a value the policy cannot see, are both refusals, not a
  // malformed request. Without this a storage-read failure or an unpriced asset reached the dApp as
  // `InvalidParams: Error: Spending limit policy is unavailable: ...` - raw internal text on a
  // line the page renders, and the wrong error class for a permission decision.
  if (
    isSpendingLimitPriceUnavailable(error) ||
    (isRecord(error) && Reflect.get(error, 'code') === 'SPENDING_LIMIT_POLICY_UNAVAILABLE')
  ) {
    return spendingLimitRetryError();
  }
  return dappRequestFailure(error);
};

/**
 * InvalidParams tells a dApp its bytes are bad and it should give up. A kill means the operation was stopped from
 * outside and may even have landed, so retrying the note import is still correct, as on the connect path.
 * Preserve the kill link's own message: a wrapper can carry a misleading parameter or permission code.
 */
const dappRequestFailure = (error: unknown): unknown => {
  const kill = pipelineKillIn(error);
  if (kill !== undefined) return kill;
  if (error instanceof ClaimFeeRefusedError) return error;
  // A lock that lands after approval is not a malformed request (#1414).
  if (isWalletLockedError(error)) return lockedRefusal();
  if (error instanceof Error && hasDAppErrorCode(error.message)) return error;
  return new Error(`${MidenDAppErrorType.InvalidParams}: ${error}`);
};

// A kill (a lock-recovery eviction, an offscreen abort or a terminated
// client) is a retryable internal failure, not a parameter problem
// (issue #775); a locked wallet gets an Unlock step from the caller (#1414).
const dappReadFailure = (error: unknown): unknown => {
  const kill = pipelineKillIn(error);
  if (kill !== undefined) return kill;
  if (isWalletLockedError(error)) return error;
  if (error instanceof Error && hasDAppErrorCode(error.message)) return error;
  return new Error(`${MidenDAppErrorType.InvalidParams}: ${error}`);
};

// The answer when an approval's cap arrives while its approved action still runs: the action may yet queue the
// transaction, so the dApp hears that the outcome is unknown, never a refusal (#1584).
const actionOutlivedApproval = (): Error =>
  new Error(
    `${MidenDAppErrorType.OutcomeUnknown}: the approved transaction was still being prepared when the approval timed ` +
      'out; check before sending again'
  );

const dappWriteFailure = (error: unknown): unknown => {
  // A queued id outranks a kill anywhere in the chain: retrying the write could send it twice.
  for (const link of causeChain(error)) {
    if (link instanceof TransactionQueuedError) {
      // Bread Connect reads the queued id from this cause, never from the message.
      return new Error(
        `${MidenDAppErrorType.OutcomeUnknown}: transaction ${link.transactionId} may already be queued; ` +
          'wait for it before sending again',
        { cause: link }
      );
    }
  }
  if (pipelineKillIn(error) !== undefined) {
    return new Error(
      `${MidenDAppErrorType.OutcomeUnknown}: the wallet could not confirm whether the transaction was queued; ` +
        'check before sending again'
    );
  }
  return dappSendFailure(error);
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

type Prepared<T> = { readonly locked: false; readonly value: T } | { readonly locked: true };

// A request's pre-prompt work. Its failures are already in the dApp's terms, except a locked wallet, which the caller
// answers with an Unlock step rather than an error (#1414).
async function runPrepare<T>(prepare: () => Promise<T>): Promise<Prepared<T>> {
  try {
    return { locked: false, value: await prepare() };
  } catch (error) {
    if (isWalletLockedError(error)) return { locked: true };
    throw error;
  }
}

// `runPrepare` with any other failure answered: `undefined` means the dApp already has its answer.
async function prepareOrReject<T>(
  prepare: () => Promise<T>,
  reject: (reason: unknown) => void
): Promise<Prepared<T> | undefined> {
  try {
    return await runPrepare(prepare);
  } catch (error) {
    reject(error);
    return undefined;
  }
}

// A request's pre-prompt work for after an unlock. The gate goes first: the re-check reads the store's current account,
// which a locked store does not hold, so it would refuse a request that only has to wait.
const recheckedPrepare =
  <T>(origin: string, sourcePublicKey: string, accountId: string, prepare: () => Promise<T>) =>
  async (): Promise<T> => {
    await withUnlocked(() => assertDappSendStillAuthorized(origin, sourcePublicKey, accountId));
    return prepare();
  };

// What a confirm popup shows. `cancel` runs when the popup closes, so a build still waiting for the unlock never runs
// the re-check or the read for a popup nobody sees.
type Sheet<T> = {
  readonly locked: boolean;
  readonly data: () => Promise<T>;
  readonly cancel: () => void;
};

// A request that met no lock shows what it read before its popup, as it always did. One that met a locked wallet is
// built once by its popup after the unlock; the popup's own lock-up check can lock the wallet as it opens, so the build
// waits for the unlock itself rather than trust the page. The wait's own bound is a backstop: the popup's auto-decline
// closes the popup first, and the close cancels the wait.
function sheetFor<T>(
  prepared: Prepared<T>,
  origin: string,
  sourcePublicKey: string,
  accountId: string,
  prepare: () => Promise<T>
): Sheet<T> {
  if (!prepared.locked) {
    const { value } = prepared;
    return { locked: false, data: async () => value, cancel: () => undefined };
  }
  const closed = new AbortController();
  const build = recheckedPrepare(origin, sourcePublicKey, accountId, prepare);
  return {
    locked: true,
    data: onceAfterUnlock(build, LOCKED_PROMPT_CAP_MS, closed.signal),
    cancel: () => closed.abort()
  };
}

// A request's confirm popup. One raised for a locked wallet opens on Unlock, and closing it before unlocking answers
// that the wallet is locked rather than a decline.
async function requestConfirmFor(
  origin: string,
  sheet: Sheet<unknown>,
  reject: (reason: unknown) => void,
  params: Omit<RequestConfirmParams, 'onDecline' | 'onPayloadError' | 'onClose'>
): Promise<void> {
  if (sheet.locked && !mayPromptToUnlock(origin)) {
    reject(lockedRefusal());
    return;
  }
  await requestConfirm({
    ...params,
    onClose: sheet.cancel,
    onPayloadError: reject,
    onDecline: () => {
      if (sheet.locked && isStoreLocked()) {
        noteLockedPromptEnded(origin);
        reject(lockedRefusal());
      } else {
        reject(new Error(MidenDAppErrorType.NotGranted));
      }
    }
  });
}

type PrivateDataConfirmationRequest =
  | MidenDAppAssetsConfirmationRequest
  | MidenDAppPrivateNotesConfirmationRequest
  | MidenDAppConsumableNotesConfirmationRequest;

type PrivateDataPayloadBase = {
  origin: string;
  networkRpc: string;
  appMeta: DappMetadata;
  sourcePublicKey: string;
  preview: null;
};

// What sets the three private-data reads apart; `servePrivateDataRead` runs each in the same order (#1414).
type PrivateDataRead<T, R> = {
  // The `allowedPrivateData` bit that lets an Auto session read with no prompt.
  allowed: AllowedPrivateData;
  prepare: () => Promise<T>;
  respond: (data: T) => R;
  // The mobile and desktop sheet's lines.
  lines: (data: T) => string[];
  payload: (base: PrivateDataPayloadBase, data: T) => MidenDAppPayload;
  confirmation: PrivateDataConfirmationRequest['type'];
  confirmationResponse: MidenMessageType;
};

function privateDataConfirmation(
  req: MidenRequest,
  type: PrivateDataConfirmationRequest['type'],
  id: string
): PrivateDataConfirmationRequest | undefined {
  switch (req?.type) {
    case MidenMessageType.DAppAssetsConfirmationRequest:
    case MidenMessageType.DAppPrivateNotesConfirmationRequest:
    case MidenMessageType.DAppConsumableNotesConfirmationRequest:
      return req.type === type && req.id === id ? req : undefined;
    default:
      return undefined;
  }
}

async function servePrivateDataRead<T, R>(
  resolve: (value: R) => void,
  reject: (reason: unknown) => void,
  origin: string,
  dApp: MidenDAppSession,
  sourcePublicKey: string,
  sessionId: string | undefined,
  read: PrivateDataRead<T, R>
): Promise<void> {
  const { prepare } = read;
  if (dApp.privateDataPermission === PrivateDataPermission.Auto && (dApp.allowedPrivateData & read.allowed) !== 0) {
    const prepared = await prepareOrReject(prepare, reject);
    if (prepared === undefined) return;
    if (!prepared.locked) {
      resolve(read.respond(prepared.value));
    } else if (isExtension()) {
      await requestUnlockOnly(origin, dApp, sourcePublicKey, prepare, data => resolve(read.respond(data)), reject);
    } else {
      try {
        resolve(read.respond(await prepareAfterUnlock(origin, sourcePublicKey, dApp.accountId, prepare)));
      } catch (e) {
        reject(e);
      }
    }
    return;
  }

  const id = nanoid();
  const networkRpc = await getNetworkRPC(dApp.network);
  const prepared = await prepareOrReject(prepare, reject);
  if (prepared === undefined) return;

  if (!isExtension()) {
    const waits: UnlockWaits = {};
    const data = await sheetDataOnNonExtension(
      origin,
      sourcePublicKey,
      dApp.accountId,
      prepared,
      prepare,
      reject,
      waits
    );
    if (data === undefined) return;
    const confirmed = await confirmOnNonExtension(
      'privateData',
      origin,
      dApp,
      networkRpc,
      read.lines(data),
      sessionId,
      waits.deadline
    );
    if (!confirmed) {
      reject(new Error(MidenDAppErrorType.NotGranted));
      return;
    }
    await assertDappSendStillAuthorized(origin, sourcePublicKey, dApp.accountId);
    resolve(read.respond(data));
    return;
  }

  const sheet = sheetFor(prepared, origin, sourcePublicKey, dApp.accountId, prepare);
  await requestConfirmFor(origin, sheet, reject, {
    id,
    payload: async () =>
      read.payload({ origin, networkRpc, appMeta: dApp.appMeta, sourcePublicKey, preview: null }, await sheet.data()),
    handleIntercomRequest: async (confirmReq, decline) => {
      const decision = privateDataConfirmation(confirmReq, read.confirmation, id);
      if (decision === undefined) return undefined;
      if (decision.confirmed) {
        try {
          const data = await sheet.data();
          await assertDappSendStillAuthorized(origin, sourcePublicKey, dApp.accountId);
          resolve(read.respond(data));
        } catch (e) {
          reject(dappRequestFailure(e));
        }
      } else {
        decline();
      }
      return { type: read.confirmationResponse };
    }
  });
}

/**
 * A request that never prompts while unlocked (an Auto read, guardianInfo) met a locked wallet: its popup only
 * unlocks. ConfirmPage answers it on its own once unlocked; the request then runs its unlocked path after the same
 * re-check a prompted request runs, since the session may have changed while the popup sat on Unlock.
 */
async function requestUnlockOnly<T>(
  origin: string,
  dApp: MidenDAppSession,
  sourcePublicKey: string,
  prepare: () => Promise<T>,
  resolve: (value: T) => void,
  reject: (reason: unknown) => void
): Promise<void> {
  const id = nanoid();
  const networkRpc = await getNetworkRPC(dApp.network);
  const sheet = sheetFor<T>({ locked: true }, origin, sourcePublicKey, dApp.accountId, prepare);
  await requestConfirmFor(origin, sheet, reject, {
    id,
    payload: { type: 'unlock', origin, networkRpc, appMeta: dApp.appMeta },
    handleIntercomRequest: async confirmReq => {
      if (confirmReq?.type !== MidenMessageType.DAppUnlockConfirmationRequest || confirmReq.id !== id) {
        return undefined;
      }
      try {
        resolve(await sheet.data());
      } catch (e) {
        reject(e);
      }
      return { type: MidenMessageType.DAppUnlockConfirmationResponse };
    }
  });
}

/**
 * `prepare`'s value for a request that never prompts: read at once while unlocked; locked, read after the app's own
 * unlock on mobile and desktop, or after the extension's popup that only unlocks.
 */
async function prepareWithoutPrompt<T>(
  origin: string,
  dApp: MidenDAppSession,
  sourcePublicKey: string,
  prepare: () => Promise<T>
): Promise<T> {
  const prepared = await runPrepare(prepare);
  if (!prepared.locked) return prepared.value;
  if (!isExtension()) return prepareAfterUnlock(origin, sourcePublicKey, dApp.accountId, prepare);
  return new Promise<T>((resolve, reject) => {
    requestUnlockOnly(origin, dApp, sourcePublicKey, prepare, resolve, reject).catch(reject);
  });
}

// One mobile or desktop request's unlock waits, and the sheet that follows them, share one deadline set by its first
// wait: LOCKED_PROMPT_CAP_MS, the extension popup's cap over its whole life, so a wallet that locks again after each
// unlock cannot hold the dApp queue past it. Unset while the request has never waited.
type UnlockWaits = { deadline?: number };

// A full AUTODECLINE_AFTER, within what the request's deadline leaves.
function timeLeftWithin(deadline: number | undefined): number {
  if (deadline === undefined) return AUTODECLINE_AFTER;
  return Math.max(0, Math.min(AUTODECLINE_AFTER, deadline - Date.now()));
}

// Mobile and desktop have no Unlock step in their sheet, so the app's own lock screen is that step: a request that met
// a locked wallet waits for the unlock, bounded because the dApp queue is held meanwhile.
async function waitForUnlockOnNonExtension(origin: string, waits: UnlockWaits): Promise<boolean> {
  if (!mayPromptToUnlock(origin)) return false;
  waits.deadline ??= Date.now() + LOCKED_PROMPT_CAP_MS;
  // The desktop wallet window sits behind the dApp's own, and nothing else raises it while locked.
  if (isDesktop()) void raiseWalletWindow();
  const isUnlocked = await waitForUnlock(timeLeftWithin(waits.deadline));
  if (!isUnlocked) noteLockedPromptEnded(origin);
  return isUnlocked;
}

async function raiseWalletWindow(): Promise<void> {
  try {
    const { focusMainWindow } = await import('lib/desktop/dapp-browser');
    await focusMainWindow();
  } catch {
    // Non-fatal: the user can still bring the window up and unlock.
  }
}

// A request's pre-prompt work run again once the app is unlocked, after the same re-check the extension popup runs.
async function prepareAfterUnlock<T>(
  origin: string,
  sourcePublicKey: string,
  accountId: string,
  prepare: () => Promise<T>,
  waits: UnlockWaits = {}
): Promise<T> {
  const build = recheckedPrepare(origin, sourcePublicKey, accountId, prepare);
  for (;;) {
    if (!(await waitForUnlockOnNonExtension(origin, waits))) throw lockedRefusal();
    const prepared = await runPrepare(build);
    if (!prepared.locked) return prepared.value;
  }
}

// What a mobile or desktop sheet shows: the prepared value, or the same work after the unlock. `undefined` means the
// dApp already has its answer.
async function sheetDataOnNonExtension<T>(
  origin: string,
  sourcePublicKey: string,
  accountId: string,
  prepared: Prepared<T>,
  prepare: () => Promise<T>,
  reject: (reason: unknown) => void,
  waits: UnlockWaits
): Promise<T | undefined> {
  if (!prepared.locked) return prepared.value;
  try {
    return await prepareAfterUnlock(origin, sourcePublicKey, accountId, prepare, waits);
  } catch (error) {
    reject(error);
    return undefined;
  }
}

/**
 * The account a dApp request is AUTHORIZED for is `dApp.accountId` — the id
 * `getDApp(origin, req.sourcePublicKey)` matched a stored session on. The account
 * a send / custom transaction actually EXECUTES with is a separate, fully
 * dApp-controlled field on the transaction payload (`senderAddress` / `address`),
 * which is written straight onto the queued row and later signed with whatever
 * vault key that account owns.
 *
 * Nothing else compares the two, and the approval screen never renders the sender,
 * so without this check a page connected to account A could name account B as the
 * sender and move B's funds behind an approval that looks exactly like A's.
 * Sessions are per-origin AND per-account (`MidenDAppSessions` is an array keyed by
 * `accountId`, and `removeDApp(origin, accountId)` revokes exactly one), so that
 * substitution also makes revocation unenforceable.
 *
 * `sameWalletAccountId` (not `===`) because the dApp side uses the bare bech32
 * address while a stored `WalletAccount.publicKey` may be the composite
 * `<address>_<suffix>` form. The consume path already gets this right by passing
 * `req.sourcePublicKey` to `initiateConsumeTransactionFromId`.
 *
 * Returns the dApp error to reject with, or `undefined` when the executing account
 * IS the authorized one. A missing id is a malformed request (`InvalidParams`);
 * a present id that names a different account is an authorization failure
 * (`NotGranted`).
 */
function executingAccountError(
  dApp: MidenDAppSession,
  executingAccountId: string | undefined
): MidenDAppErrorType | undefined {
  if (!executingAccountId) return MidenDAppErrorType.InvalidParams;
  return sameWalletAccountId(executingAccountId, dApp.accountId) ? undefined : MidenDAppErrorType.NotGranted;
}

const generatePromisifyTransaction = async (
  resolve: (value: MidenDAppTransactionResponse | PromiseLike<MidenDAppTransactionResponse>) => void,
  reject: (reason?: any) => void,
  origin: string,
  dApp: MidenDAppSession,
  req: MidenDAppTransactionRequest,
  sessionId?: string
) => {
  // The generalized TransactionRequest carries a tagged `MidenTransaction`
  // ({ type, payload }). A `send`/`consume` payload is not a custom-transaction
  // payload, so delegate those to their dedicated flows (preview, confirmation
  // UI and execution) instead of validating them as a CustomTransaction —
  // otherwise they fail with "Invalid CustomTransaction payload". Only `custom`
  // (and bare/legacy payloads) fall through to the custom flow below. Issue #88.
  // `req.transaction.type` is a string enum from `MidenTransaction`
  // ('send' | 'consume' | 'custom'). Compare by value rather than importing
  // the `TransactionType` enum as a runtime value: adapter-base is consumed
  // type-only in this module, and its runtime exports aren't loadable in the
  // unit-test (jest) setup. The string values are part of the dApp↔wallet
  // wire contract, so they're stable.
  const type: string = req.transaction.type;
  if (type === 'send') {
    return generatePromisifySendTransaction(
      value =>
        resolve({
          type: MidenDAppMessageType.TransactionResponse,
          transactionId: (value as MidenDAppSendTransactionResponse).transactionId
        }),
      reject,
      origin,
      dApp,
      { ...req, transaction: req.transaction.payload } as unknown as MidenDAppSendTransactionRequest,
      sessionId
    );
  }
  if (type === 'consume') {
    return generatePromisifyConsumeTransaction(
      value =>
        resolve({
          type: MidenDAppMessageType.TransactionResponse,
          transactionId: (value as MidenDAppConsumeResponse).transactionId
        }),
      reject,
      origin,
      dApp,
      { ...req, transaction: req.transaction.payload } as unknown as MidenDAppConsumeRequest,
      sessionId
    );
  }

  // Same authorization check as the send path: the custom payload's `address` is
  // the account that will execute and is fully dApp-controlled. A payload with no
  // address at all stays an `InvalidParams` malformed-payload rejection, matching
  // what the preview build below would have reported.
  const customAddressError = executingAccountError(dApp, (req.transaction.payload as MidenCustomTransaction)?.address);
  if (customAddressError) {
    reject(new Error(`${customAddressError}: executing account is not the connected account`));
    return;
  }

  const id = nanoid();
  const networkRpc = await getNetworkRPC(dApp.network);
  const customTransaction = req.transaction.payload as MidenCustomTransaction;

  // Checked before the gate, so a malformed payload is reported as one while the wallet is locked; the E2E cell
  // R3-customPayload pins the text.
  if (!customTransaction.address || !customTransaction.transactionRequest) {
    reject(new Error(`${MidenDAppErrorType.InvalidParams}: Invalid CustomTransaction payload`));
    return;
  }

  // Reject malformed bytes before any unlock prompt; WASM startup failures keep their original error. The decode and
  // its summary share one hold, so a trap in either reaches the lock, which retires the client before the refusal.
  await ensureSdkWasmReady();
  let declared: TxAssetView | undefined;
  try {
    declared = await withWasmClientLock(async () => {
      const request = TransactionRequest.deserialize(b64ToU8(customTransaction.transactionRequest));
      try {
        return declaredTransactionRequestToView(request, customTransaction.importNotes ?? [], { rethrowTraps: true });
      } catch (e) {
        if (e instanceof WebAssembly.RuntimeError) throw e;
        console.error('[DApp] Could not decode the custom transaction request for the approval sheet:', e);
        return undefined;
      }
    });
  } catch (e) {
    // A kill during the decode says nothing about the bytes, so it answers retryable, as the other previews do.
    reject(dappReadFailure(e));
    return;
  }

  const prepare = async () => {
    let declaredMessages: string[];
    try {
      declaredMessages = await withUnlocked(async () => formatCustomTransactionPreview(customTransaction, declared));
    } catch (e) {
      throw dappReadFailure(e);
    }
    // The effects go in front of the user BEFORE either sheet is raised, because the mobile/desktop
    // sheet cannot ask for them itself - see `formatSimulatedCustomEffects`. Hoisted above the
    // platform split because the spending-limit gate below needs the dry run's outgoing totals on
    // BOTH paths: a custom request moves value too, and before this it reached the queue with no
    // assessment at all, which made "send it as a custom transaction" the way around a cap.
    // ONE dry run per custom request, shared by the effects the signer reads, the spending-limit
    // assessment, and (on the extension arm) the confirm sheet's own simulate request. Running it
    // twice took the single-threaded WASM lock twice and let the displayed numbers and the enforced
    // numbers come from two different executions.
    // A dry run that throws must not take the request down with it: the sheet still rises, saying
    // the effects are unknown. Previously this catch lived inside the formatter; hoisting the call
    // moved the failure out of its reach, so it is restated here as the same contract.
    const simulated = await withUnlocked(async () => {
      try {
        return await simulateCustomTransaction({
          address: customTransaction.address,
          transactionRequest: customTransaction.transactionRequest,
          importNotes: customTransaction.importNotes
        });
      } catch (e) {
        console.error('Failed to simulate a custom transaction for approval', e);
        return { error: consentReason(e) };
      }
    });
    const simulatedEffects = await formatSimulatedCustomEffects(simulated);
    try {
      const customLimit = await customSpendingLimitState(customTransaction.address, simulatedEffects.outgoing);
      return { transactionMessages: [...declaredMessages, ...simulatedEffects.messages], simulated, customLimit };
    } catch (e) {
      // The dry run above already quarantined the carried notes. This refusal is the WALLET's, not a
      // user decline, so the notes go back to the claimable list; only a decline earns staying
      // hidden. Without this a contention refusal hid the user's own notes for the 7-day TTL.
      await releaseNoteIds(importedNoteIds(customTransaction.importNotes));
      // Through the same mapper as every other limit-observing path: this catch also sees a
      // SpendingLimitPolicyUnavailableError from the configuration read or a malformed record.
      throw dappSendFailure(e);
    }
  };
  const prepared = await prepareOrReject(prepare, reject);
  if (prepared === undefined) return;

  // On mobile/desktop, use confirmation store to request user approval
  if (!isExtension()) {
    dappDebug('[DApp] Non-extension requesting transaction confirmation');
    const waits: UnlockWaits = {};
    const sheetData = await sheetDataOnNonExtension(
      origin,
      req.sourcePublicKey,
      customTransaction.address,
      prepared,
      prepare,
      reject,
      waits
    );
    if (sheetData === undefined) return;
    const { transactionMessages, customLimit, simulated } = sheetData;
    let noteFlow: ReturnType<typeof noteFlowFromSimulatedBytes>;
    try {
      noteFlow = noteFlowFromSimulatedBytes(simulated);
    } catch (error) {
      console.error('Custom transaction note details unavailable:', error);
    }

    const result = await requestConfirmationWithWatchdog(waits.deadline, {
      id,
      sessionId,
      type: 'transaction',
      origin,
      appMeta: dApp.appMeta,
      network: dApp.network,
      networkRpc,
      privateDataPermission: dApp.privateDataPermission,
      allowedPrivateData: dApp.allowedPrivateData,
      existingPermission: true,
      transactionMessages,
      noteFlow: noteFlow ?? null,
      ...(customLimit.details !== undefined && {
        spendingLimitAssessment: customLimit.details.assessment
      }),
      sourcePublicKey: req.sourcePublicKey
    });

    if (!result.confirmed) {
      reject(new Error(MidenDAppErrorType.NotGranted));
      return;
    }

    try {
      const transactionId = await withUnlocked(async () => {
        const { payload } = req.transaction;
        const { address, recipientAddress, transactionRequest, inputNoteIds, importNotes } =
          payload as MidenCustomTransaction;
        // The same re-check the send arm performs: the sheet may have sat open while the origin
        // disconnected or the user switched accounts, and a custom request moves value too.
        await assertDappSendStillAuthorized(origin, req.sourcePublicKey, address);
        return await requestCustomTransaction(
          address,
          transactionRequest,
          inputNoteIds,
          importNotes,
          delegateFromConfirmation(result),
          recipientAddress || undefined,
          customLimit.totals,
          authorizationForDappSend(customLimit.details, result.spendingLimitAuthenticated, customLimit.totals),
          origin
        );
      });
      // Same reason as the extension branch below: the dry run above quarantined
      // the carried notes, and the queued transaction is about to consume them.
      // Not released on the decline path, so a declined request stays hidden.
      await releaseNoteIds(importedNoteIds(customTransaction.importNotes));
      startDappBackgroundProcessing();
      resolve({
        type: MidenDAppMessageType.TransactionResponse,
        transactionId
      } as any);
    } catch (e) {
      if ([...causeChain(e)].some(link => link instanceof TransactionQueuedError)) {
        await releaseNoteIds(importedNoteIds(customTransaction.importNotes));
        startDappBackgroundProcessing();
      }
      reject(dappWriteFailure(e));
    }
    return;
  }

  const sheet = sheetFor(prepared, origin, req.sourcePublicKey, customTransaction.address, prepare);
  await requestConfirmFor(origin, sheet, reject, {
    id,
    onOwnedAnswerTimeout: () => reject(actionOutlivedApproval()),
    payload: async () => {
      const { transactionMessages, customLimit } = await sheet.data();
      return buildCustomTxConfirmPayload({
        origin,
        networkRpc,
        appMeta: dApp.appMeta,
        sourcePublicKey: req.sourcePublicKey,
        transactionMessages,
        customTransaction,
        spendingLimitDetails: customLimit.details
      });
    },
    // The sheet's own simulate request reuses the build's dry run, so it shows what the policy assessed.
    handleSimulate: async simulateReq =>
      makeSimulateHandler(id, customTransaction, (await sheet.data()).simulated)(simulateReq),
    handleIntercomRequest: async (confirmReq, decline) => {
      if (confirmReq?.type === MidenMessageType.DAppTransactionConfirmationRequest && confirmReq?.id === id) {
        if (confirmReq.confirmed) {
          try {
            const { customLimit } = await sheet.data();
            const transactionId = await withUnlocked(async () => {
              const { payload } = req.transaction;
              const { address, recipientAddress, transactionRequest, inputNoteIds, importNotes } =
                payload as MidenCustomTransaction;
              // See the mobile/desktop arm: same stale-confirmation re-check.
              await assertDappSendStillAuthorized(origin, req.sourcePublicKey, address);
              return await requestCustomTransaction(
                address,
                transactionRequest,
                inputNoteIds,
                importNotes,
                confirmReq.delegate,
                recipientAddress || undefined,
                customLimit.totals,
                authorizationForDappSend(
                  customLimit.details,
                  confirmReq.spendingLimitAuthenticated,
                  customLimit.totals
                ),
                origin
              );
            });
            // The transaction is queued and will consume these notes —
            // release the quarantine the pre-confirm dry-run placed on them
            // so a failed/abandoned submission doesn't hide them forever.
            // Deliberately NOT released on the decline branch below:
            // declined notes must stay hidden from the claimable UI.
            await releaseNoteIds(importedNoteIds(customTransaction.importNotes));
            startDappBackgroundProcessing();
            resolve({
              type: MidenDAppMessageType.TransactionResponse,
              transactionId
            } as any);
          } catch (e) {
            if ([...causeChain(e)].some(link => link instanceof TransactionQueuedError)) {
              await releaseNoteIds(importedNoteIds(customTransaction.importNotes));
              startDappBackgroundProcessing();
            }
            reject(dappWriteFailure(e));
          }
        } else {
          decline();
        }

        return {
          type: MidenMessageType.DAppTransactionConfirmationResponse
        };
      }
      return undefined;
    }
  });
};

export async function requestSendTransaction(
  origin: string,
  req: MidenDAppSendTransactionRequest,
  // PR-4 chunk 8: optional multi-instance session id.
  sessionId?: string
): Promise<MidenDAppSendTransactionResponse> {
  if (!req?.transaction) {
    throw new Error(MidenDAppErrorType.InvalidParams);
  }

  const dApp = await getDApp(origin, req.sourcePublicKey);

  if (!dApp) {
    throw new Error(MidenDAppErrorType.NotGranted);
  }
  await assertRequestAccountIsCurrent(dApp.accountId);

  // `.catch(reject)`: each `generatePromisify*` is an async function invoked
  // inside this executor, so a throw of its own would otherwise become an
  // unhandled rejection and leave the dApp's promise unsettled forever (the
  // caller only ever sees the injection script's 5-minute "Request timeout").
  return new Promise((resolve, reject) => {
    generatePromisifySendTransaction(resolve, reject, origin, dApp, req, sessionId).catch(reject);
  });
}

const generatePromisifySendTransaction = async (
  resolve: (value: MidenDAppSendTransactionResponse | PromiseLike<MidenDAppSendTransactionResponse>) => void,
  reject: (reason?: any) => void,
  origin: string,
  dApp: MidenDAppSession,
  req: MidenDAppSendTransactionRequest,
  sessionId?: string
) => {
  // Reject BEFORE any preview or prompt: the request is authorized for
  // `dApp.accountId` but would execute as `req.transaction.senderAddress`.
  const senderError = executingAccountError(dApp, req.transaction?.senderAddress);
  if (senderError) {
    reject(new Error(senderError));
    return;
  }

  const id = nanoid();
  const networkRpc = await getNetworkRPC(dApp.network);

  // Authorization, and it has to live HERE rather than in `requestSendTransaction`.
  // A session authorizes exactly one account, but the account to debit is taken
  // from the request, so without this a page connected to A names B as the
  // sender and spends from B — and the approval sheet shows amount, recipient,
  // token and note type but not the sender, so nothing on screen gives it away.
  //
  // `requestSendTransaction` is only ONE of the two ways in. The generalized
  // `TRANSACTION_REQUEST` entrypoint routes a `{ type: 'send' }` payload
  // straight into this function (`generatePromisifyTransaction`), reaching the
  // same `initiateSendTransaction` while validating only `sourcePublicKey`
  // against the session — which the attacking page satisfies with its own
  // connected account. A check on the outer function is simply not on that
  // path; the two other boundary validations below are here for that reason.
  const senderAddress = req.transaction?.senderAddress;
  if (typeof senderAddress !== 'string' || senderAddress === '') {
    // Checked before the comparison, which would otherwise `.split` undefined
    // and hand the page a raw TypeError instead of the documented error.
    reject(new Error(`${MidenDAppErrorType.InvalidParams}: senderAddress is required`));
    return;
  }
  if (!sameWalletAccountId(senderAddress, dApp.accountId)) {
    reject(new Error(MidenDAppErrorType.NotGranted));
    return;
  }

  let spends: IConsumedAssetTotal[] = [];
  try {
    // Normalize the note type ONCE, before anything reads it. It crosses
    // postMessage from an untrusted page, so its type is a claim rather than a
    // guarantee, and the wallet accepts both the persisted 'public'/'private'
    // strings and the SDK's numeric enum. Everything downstream compares the
    // STRING form — including the private-note relay in
    // `completeSendTransaction` — so persisting a numeric `0` would build a
    // Private note and then skip its delivery, leaving the recipient unable to
    // ever see it. A missing or unrecognized value throws, which the catch
    // below turns into InvalidParams before the user is prompted.
    if (req.transaction.noteType === undefined || req.transaction.noteType === null) {
      throw new Error('noteType is required');
    }
    req.transaction.noteType = toPersistedNoteType(req.transaction.noteType) as typeof req.transaction.noteType;
    // Same reasoning one field over: the recall offset also crosses postMessage
    // unvalidated, and it ends up as a u32 block height that wasm-bindgen
    // truncates rather than rejects. Check it here so the number the approval
    // sheet renders below is the number the note is actually built with.
    assertValidRecallBlocks(req.transaction.recallBlocks);
    // Parsed here, before the gate, so a malformed amount is reported as one while the wallet is locked.
    spends = [{ faucetId: req.transaction.faucetId, amount: BigInt(req.transaction.amount) }];
  } catch (e) {
    reject(dappSendFailure(e));
    return;
  }

  const prepare = async () => {
    try {
      const transactionMessages = await withUnlocked(async () => formatSendTransactionPreview(req.transaction));
      const spendingLimitDetails = await assessOutgoingSpendingLimitDetails({ accountId: senderAddress, spends });
      return { transactionMessages, spendingLimitDetails };
    } catch (e) {
      if (isWalletLockedError(e)) throw e;
      // Through the mapper: the assessment above can raise a policy error from a storage read or a
      // malformed record, and a malformed REQUEST is the only thing InvalidParams should mean.
      throw dappSendFailure(e);
    }
  };
  const prepared = await prepareOrReject(prepare, reject);
  if (prepared === undefined) return;

  // On mobile/desktop, use confirmation store to request user approval
  if (!isExtension()) {
    dappDebug('[DApp] Non-extension requesting send transaction confirmation');
    const waits: UnlockWaits = {};
    const sheetData = await sheetDataOnNonExtension(
      origin,
      req.sourcePublicKey,
      senderAddress,
      prepared,
      prepare,
      reject,
      waits
    );
    if (sheetData === undefined) return;
    const { transactionMessages, spendingLimitDetails } = sheetData;

    const result = await requestConfirmationWithWatchdog(waits.deadline, {
      id,
      sessionId,
      type: 'transaction',
      origin,
      appMeta: dApp.appMeta,
      network: dApp.network,
      networkRpc,
      privateDataPermission: dApp.privateDataPermission,
      allowedPrivateData: dApp.allowedPrivateData,
      existingPermission: true,
      transactionMessages,
      sourcePublicKey: req.sourcePublicKey,
      ...(spendingLimitDetails !== undefined &&
        spendingLimitDetails.assessment.breach !== undefined && {
          spendingLimitAssessment: spendingLimitDetails.assessment
        })
    });

    if (!result.confirmed) {
      reject(new Error(MidenDAppErrorType.NotGranted));
      return;
    }

    try {
      const transactionId = await withUnlocked(async () => {
        await assertDappSendStillAuthorized(origin, req.sourcePublicKey, senderAddress);
        const spendingLimitAuthorization = authorizationForDappSend(
          spendingLimitDetails,
          result.spendingLimitAuthenticated,
          spends
        );
        const { recipientAddress, faucetId, noteType, amount, recallBlocks } = req.transaction;
        return await initiateSendTransaction(
          senderAddress,
          recipientAddress,
          faucetId,
          noteType as any,
          BigInt(amount),
          recallBlocks,
          delegateFromConfirmation(result),
          spendingLimitAuthorization,
          origin
        );
      });
      startDappBackgroundProcessing();
      resolve({
        type: MidenDAppMessageType.SendTransactionResponse,
        transactionId
      } as any);
    } catch (e) {
      reject(dappWriteFailure(e));
    }
    return;
  }

  const sheet = sheetFor(prepared, origin, req.sourcePublicKey, senderAddress, prepare);
  await requestConfirmFor(origin, sheet, reject, {
    id,
    onOwnedAnswerTimeout: () => reject(actionOutlivedApproval()),
    payload: async () => {
      const { transactionMessages, spendingLimitDetails } = await sheet.data();
      return {
        type: 'transaction',
        origin,
        networkRpc,
        appMeta: dApp.appMeta,
        sourcePublicKey: req.sourcePublicKey,
        transactionMessages,
        preview: null,
        ...(spendingLimitDetails !== undefined &&
          spendingLimitDetails.assessment.breach !== undefined && {
            spendingLimitAssessment: toSerializedSpendingLimitAssessment(spendingLimitDetails.assessment)
          })
      };
    },
    handleIntercomRequest: async (confirmReq, decline) => {
      if (confirmReq?.type === MidenMessageType.DAppTransactionConfirmationRequest && confirmReq?.id === id) {
        if (confirmReq.confirmed) {
          try {
            const { spendingLimitDetails } = await sheet.data();
            const transactionId = await withUnlocked(async () => {
              await assertDappSendStillAuthorized(origin, req.sourcePublicKey, senderAddress);
              const spendingLimitAuthorization = authorizationForDappSend(
                spendingLimitDetails,
                confirmReq.spendingLimitAuthenticated,
                spends
              );
              const { recipientAddress, faucetId, noteType, amount, recallBlocks } = req.transaction;
              return await initiateSendTransaction(
                senderAddress,
                recipientAddress,
                faucetId,
                noteType as any,
                BigInt(amount),
                recallBlocks,
                confirmReq.delegate,
                spendingLimitAuthorization,
                origin
              );
            });
            startDappBackgroundProcessing();
            resolve({
              type: MidenDAppMessageType.SendTransactionResponse,
              transactionId
            } as any);
          } catch (e) {
            reject(dappWriteFailure(e));
          }
        } else {
          decline();
        }

        return {
          type: MidenMessageType.DAppTransactionConfirmationResponse
        };
      }
      return undefined;
    }
  });
};

export async function requestConsumeTransaction(
  origin: string,
  req: MidenDAppConsumeRequest,
  // PR-4 chunk 8: optional multi-instance session id.
  sessionId?: string
): Promise<MidenDAppConsumeResponse> {
  if (!req?.sourcePublicKey || !req?.transaction) {
    throw new Error(MidenDAppErrorType.InvalidParams);
  }

  const dApp = await getDApp(origin, req.sourcePublicKey);

  if (!dApp) {
    throw new Error(MidenDAppErrorType.NotGranted);
  }
  await assertRequestAccountIsCurrent(dApp.accountId);

  // `.catch(reject)`: each `generatePromisify*` is an async function invoked
  // inside this executor, so a throw of its own would otherwise become an
  // unhandled rejection and leave the dApp's promise unsettled forever (the
  // caller only ever sees the injection script's 5-minute "Request timeout").
  return new Promise((resolve, reject) => {
    generatePromisifyConsumeTransaction(resolve, reject, origin, dApp, req, sessionId).catch(reject);
  });
}

const generatePromisifyConsumeTransaction = async (
  resolve: (value: MidenDAppConsumeResponse | PromiseLike<MidenDAppConsumeResponse>) => void,
  reject: (reason?: any) => void,
  origin: string,
  dApp: MidenDAppSession,
  req: MidenDAppConsumeRequest,
  sessionId?: string
) => {
  const id = nanoid();
  const networkRpc = await getNetworkRPC(dApp.network);

  // Bytes that describe another note are a malformed request, refused before the gate so a locked wallet says so too.
  let carried: ResolvedConsumeNote | null = null;
  try {
    carried = await decodeCarriedConsumeNoteLocked(req.transaction);
  } catch (e) {
    reject(dappReadFailure(e));
    return;
  }
  const prepare = async () => {
    try {
      return await withUnlocked(async () =>
        formatConsumeTransactionPreview(req.transaction, carried, req.sourcePublicKey)
      );
    } catch (e) {
      throw dappReadFailure(e);
    }
  };
  const prepared = await prepareOrReject(prepare, reject);
  if (prepared === undefined) return;

  // On mobile/desktop, use confirmation store to request user approval
  if (!isExtension()) {
    dappDebug('[DApp] Non-extension requesting consume transaction confirmation');
    const waits: UnlockWaits = {};
    const sheetData = await sheetDataOnNonExtension(
      origin,
      req.sourcePublicKey,
      dApp.accountId,
      prepared,
      prepare,
      reject,
      waits
    );
    if (sheetData === undefined) return;
    const { noteId, messages: transactionMessages } = sheetData;

    const result = await requestConfirmationWithWatchdog(waits.deadline, {
      id,
      sessionId,
      type: 'consume',
      origin,
      appMeta: dApp.appMeta,
      network: dApp.network,
      networkRpc,
      privateDataPermission: dApp.privateDataPermission,
      allowedPrivateData: dApp.allowedPrivateData,
      existingPermission: true,
      transactionMessages,
      sourcePublicKey: req.sourcePublicKey
    });

    if (!result.confirmed) {
      reject(new Error(MidenDAppErrorType.NotGranted));
      return;
    }

    try {
      const transactionId = await withUnlocked(async () => {
        // The same re-check send and custom perform: a consume approved for a stale session moves value too (#1415).
        await assertDappSendStillAuthorized(origin, req.sourcePublicKey, dApp.accountId);
        const { noteBytes } = req.transaction;
        if (noteBytes) {
          await importConsumeNoteBytes(req.transaction);
          // The import can run long; the account or session may have changed under it.
          await assertDappSendStillAuthorized(origin, req.sourcePublicKey, dApp.accountId);
        }
        // `manualRetry`: the user just approved THIS consume on the sheet, so it
        // must not be dropped by auto-consume's exponential backoff — which
        // would queue nothing and answer the dApp with the previous attempt's
        // Failed row id. `origin` refuses a note another transaction holds rather
        // than answer with that transaction, and lets this origin wait on the
        // answer (see the callee).
        return await initiateConsumeTransactionFromId(
          req.sourcePublicKey,
          noteId,
          delegateFromConfirmation(result),
          true,
          origin,
          'dapp'
        );
      });
      startDappBackgroundProcessing();
      resolve({
        type: MidenDAppMessageType.ConsumeResponse,
        transactionId
      });
    } catch (e) {
      // A killed note import may have landed and the bytes are queued: not bad params.
      reject(dappRequestFailure(e));
    }
    return;
  }

  const sheet = sheetFor(prepared, origin, req.sourcePublicKey, dApp.accountId, prepare);
  await requestConfirmFor(origin, sheet, reject, {
    id,
    onOwnedAnswerTimeout: () => reject(actionOutlivedApproval()),
    payload: async () => {
      const { noteId, messages } = await sheet.data();
      return {
        type: 'consume',
        origin,
        networkRpc,
        appMeta: dApp.appMeta,
        sourcePublicKey: req.sourcePublicKey,
        transactionMessages: messages,
        noteId
      };
    },
    handleIntercomRequest: async (confirmReq, decline) => {
      if (confirmReq?.type === MidenMessageType.DAppTransactionConfirmationRequest && confirmReq?.id === id) {
        if (confirmReq.confirmed) {
          try {
            const transactionId = await withUnlocked(async () => {
              // See the mobile/desktop arm: same post-approval re-check.
              await assertDappSendStillAuthorized(origin, req.sourcePublicKey, dApp.accountId);
              // The note the popup showed, kept by the sheet: a details commitment resolved to its note id (#1389).
              const { noteId } = await sheet.data();
              const { noteBytes } = req.transaction;
              if (noteBytes) {
                await importConsumeNoteBytes(req.transaction);
                // See the mobile/desktop arm: the import can outlast the approval's check.
                await assertDappSendStillAuthorized(origin, req.sourcePublicKey, dApp.accountId);
              }
              // `manualRetry`: approved on the confirm page — see the
              // non-extension branch above for why the backoff must not apply,
              // and why `origin`.
              return await initiateConsumeTransactionFromId(
                req.sourcePublicKey,
                noteId,
                confirmReq.delegate,
                true,
                origin,
                'dapp'
              );
            });
            startDappBackgroundProcessing();
            resolve({
              type: MidenDAppMessageType.ConsumeResponse,
              transactionId
            });
          } catch (e) {
            // Same mapping as the non-extension branch above.
            reject(dappRequestFailure(e));
          }
        } else {
          decline();
        }

        return {
          type: MidenMessageType.DAppTransactionConfirmationResponse
        };
      }
      return undefined;
    }
  });
};

// Only an origin the wallet answered with this row's id may read its outcome, and only while it holds a session on the
// row's account (#1416). Neither the current account nor the lock matters: the row names the account, and a dApp
// waiting on its own transaction must survive an account switch or an auto-lock. A missing row is refused the same
// way, so the answer never says whether an id exists.
const assertDappMayReadTransaction = async (origin: string, txId: string): Promise<ITransaction> => {
  const row = await Repo.transactions.get(txId);
  if (
    row === undefined ||
    row.restoredFromBackup === true ||
    row.recovered === true ||
    !(row.dappOrigins ?? []).includes(origin)
  ) {
    throw new Error(MidenDAppErrorType.NotGranted);
  }
  const sessions = (await getAllDApps())[origin] ?? [];
  if (!sessions.some(session => sameWalletAccountId(session.accountId, row.accountId))) {
    throw new Error(MidenDAppErrorType.NotGranted);
  }
  return row;
};

export async function waitForTransaction(
  origin: string,
  req: MidenDAppWaitForTxRequest
): Promise<MidenDAppWaitForTxResponse> {
  // A non-string id would reach Dexie's `get` as a where-clause object and match some other row.
  if (typeof req.txId !== 'string' || req.txId === '') {
    throw new Error(MidenDAppErrorType.InvalidParams);
  }
  // Before the wait starts: its answers name the on-chain id and the raw failure text.
  await assertDappMayReadTransaction(origin, req.txId);
  const res = await waitForTransactionCompletion(req.txId);
  // The wait lasts up to five minutes; a disconnect or a restore meanwhile gets no result.
  const row = await assertDappMayReadTransaction(origin, req.txId);
  // The consume dedup can grant a dApp a claim that covers other notes too, and the output notes those emitted are not
  // its to read: it learns the outcome alone.
  const sharedClaim = row.type === 'consume' && (row.noteIds?.length ?? 0) > 1;
  return {
    type: MidenDAppMessageType.WaitForTransactionResponse,
    transactionOutput: sharedClaim && 'outputNotes' in res ? { txHash: res.txHash, outputNotes: [] } : res
  };
}

export async function getAllDApps(): Promise<MidenDAppSessions> {
  const storage = getStorageProvider();
  const items = await storage.get([STORAGE_KEY]);
  const dAppsSessions = (items[STORAGE_KEY] as MidenDAppSessions) || {};
  return dAppsSessions;
}

export async function getDApp(origin: string, accountId: string): Promise<MidenDAppSession | undefined> {
  const sessions: MidenDAppSession[] = (await getAllDApps())[origin] || [];
  return sessions.find(session => session.accountId === accountId);
}

export async function setDApp(origin: string, permissions: MidenDAppSession) {
  const current = await getAllDApps();
  let currentDAppSessions: MidenDAppSession[] = current[origin] || [];
  let currentDAppSessionIdx = currentDAppSessions.findIndex(session => session.accountId === permissions.accountId);
  if (currentDAppSessionIdx >= 0) {
    currentDAppSessions[currentDAppSessionIdx] = permissions;
  } else {
    currentDAppSessions.push(permissions);
  }

  const newDApps = { ...current, [origin]: currentDAppSessions };
  await setDApps(newDApps);
  return newDApps;
}

export async function removeDApp(origin: string, accountId: string) {
  // A native app's Bread Connect session lives under its origin; left in place, the origin's next grant revives it.
  // It ends first, so a failure keeps the permission rather than a session that outlives it.
  await endOriginSessions(origin);
  const { [origin]: permissionsToRemove, ...restDApps } = await getAllDApps();
  const newPermissions = permissionsToRemove?.filter(session => session.accountId !== accountId) ?? [];
  await setDApps({ ...restDApps, [origin]: newPermissions });
  return restDApps;
}

export function cleanDApps() {
  return setDApps({});
}

function setDApps(newDApps: MidenDAppSessions) {
  const storage = getStorageProvider();
  return storage.set({ [STORAGE_KEY]: newDApps });
}

type RequestConfirmParams = {
  id: string;
  // A function is built when the popup first asks for its payload, which it does only once unlocked (#1414).
  payload: MidenDAppPayload | (() => Promise<MidenDAppPayload>);
  onDecline: () => void;
  // Answers the dApp when a built payload fails; the popup then closes.
  onPayloadError?: (error: unknown) => void;
  onClose?: () => void;
  handleIntercomRequest: (req: MidenRequest, decline: () => void) => Promise<any>;
  handleSimulate?: (req: MidenRequest) => Promise<any>;
  // Set by an approval whose action queues a transaction: once that action runs it owns the dApp's answer, and this
  // is the answer if the cap arrives first, since the transaction may still be queued (#1584).
  onOwnedAnswerTimeout?: () => void;
};

const isConfirmationOf = (req: MidenRequest, id: string): boolean =>
  typeof req === 'object' && req !== null && APPROVAL_CONFIRMATION_TYPES.has(req.type) && 'id' in req && req.id === id;

// The last state of each recent approval, so a request no handler answered can say which state it met. The ids stay
// in this worker's memory; only the state crosses the port, as the Not Found error's code.
type ConfirmationState = Exclude<ConfirmationHandlerState, 'unknown'>;
const CONFIRMATION_STATES_KEPT = 64;
const confirmationStates = new Map<string, ConfirmationState>();
let confirmationStatesPruned = false;

function recordConfirmationState(id: string, state: ConfirmationState): void {
  confirmationStates.delete(id);
  confirmationStates.set(id, state);
  for (const oldest of confirmationStates.keys()) {
    if (confirmationStates.size <= CONFIRMATION_STATES_KEPT) return;
    confirmationStates.delete(oldest);
    confirmationStatesPruned = true;
  }
}

function requestShapeOf(req: unknown): ConfirmationRequestShape {
  if (typeof req !== 'object' || req === null || !('id' in req)) return 'missing';
  const sent: unknown = req.id;
  if (typeof sent === 'string') return 'string';
  if (Array.isArray(sent)) return typeof sent[0] === 'string' ? 'array_with_string' : 'array_without_string';
  return 'other';
}

function registryState(): ConfirmationRegistryState {
  if (confirmationStatesPruned) return 'pruned';
  return confirmationStates.size === 0 ? 'empty' : 'holding';
}

/**
 * The "Not Found" for a confirmation request no handler answered, coded with the state its approval reached, the
 * shape of the id the request carried, what this worker remembers of recent approvals and how long it has run.
 */
export function confirmationNotFound(req: unknown): Error & { code: string } {
  const sent: unknown = typeof req === 'object' && req !== null && 'id' in req ? req.id : undefined;
  // The payload request sends the popup's SWR key, an array holding the id.
  const id: unknown = Array.isArray(sent) ? sent[0] : sent;
  const state = typeof id === 'string' ? confirmationStates.get(id) : undefined;
  const labels = [requestShapeOf(req), registryState(), backgroundAgeOf(performance.now())];
  return Object.assign(new Error('Not Found'), { code: [`confirmation_${state ?? 'unknown'}`, ...labels].join(':') });
}

async function requestConfirm({
  id,
  payload,
  onDecline,
  onPayloadError,
  onClose,
  handleIntercomRequest,
  handleSimulate,
  onOwnedAnswerTimeout
}: RequestConfirmParams) {
  /* c8 ignore start */ if (!isExtension())
    throw new Error('DApp confirmation popup is only available in extension context'); /* c8 ignore stop */

  const browser = await getBrowser();

  let closing = false;
  // The approval's running answer: a repeated confirmation the popup sends while it runs gets this same answer
  // instead of running the action again (#1584).
  let answer: Promise<unknown> | undefined;
  let pendingDecline: 'expired' | 'window_closed' | undefined;
  const openedAt = Date.now();
  let payloadServed = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const stopTimeout = () => clearTimeout(timeout);
  const restartTimeout = (ms: number) => {
    stopTimeout();
    timeout = setTimeout(() => declineAndClose('expired'), ms);
  };
  const capLeft = () => LOCKED_PROMPT_CAP_MS - (Date.now() - openedAt);
  const close = async (reason: Exclude<ConfirmationState, 'open'>) => {
    /* c8 ignore start */ if (closing) return; /* c8 ignore stop */
    closing = true;
    recordConfirmationState(id, reason);
    // However the popup closes, a payload build still waiting for the unlock stops here (#1414).
    onClose?.();

    try {
      stopTimeout();
      stopRequestListening();
      stopWinRemovedListening();

      await closeWindow();
    } catch (_err) {}
  };

  const declineAndClose = (reason: 'expired' | 'window_closed') => {
    // An action that may queue a transaction answers the dApp itself once it runs, so the auto-decline and a closed
    // popup wait for it, within the cap. Every other approval keeps #1471's rule: a decline answers at once.
    if (answer && onOwnedAnswerTimeout) {
      if (capLeft() > 0) {
        pendingDecline ??= reason;
        restartTimeout(capLeft());
        return;
      }
      onOwnedAnswerTimeout();
      close('expired');
      return;
    }
    onDecline();
    close(reason);
  };

  const respond = async (req: MidenRequest): Promise<unknown> => {
    const result = await handleIntercomRequest(req, onDecline);
    if (result) close('answered');
    return result;
  };

  const runAnswer = async (req: MidenRequest): Promise<unknown> => {
    try {
      return await respond(req);
    } finally {
      answer = undefined;
      const declined = pendingDecline;
      pendingDecline = undefined;
      if (declined && !closing) declineAndClose(declined);
    }
  };

  let knownPort: Runtime.Port | undefined;
  recordConfirmationState(id, 'open');
  const stopRequestListening = intercom.onRequest(async (req: MidenRequest, port) => {
    if (req?.type === MidenMessageType.DAppGetPayloadRequest && req.id[0] === id) {
      knownPort = port;
      // The first ask can wait out an unlock and a build, which the first window may not cover: until the payload is
      // served only the cap bounds the popup.
      if (!payloadServed && !closing) restartTimeout(capLeft());
      let served: MidenDAppPayload;
      try {
        served = typeof payload === 'function' ? await payload() : payload;
      } catch (error) {
        if (onPayloadError) onPayloadError(error);
        else onDecline();
        close('payload_failed');
        throw error;
      }
      if (!payloadServed && !closing) {
        payloadServed = true;
        // The review gets a full window from the serve, within what the dApp queue can be held.
        restartTimeout(Math.min(AUTODECLINE_AFTER, capLeft()));
      }
      return {
        type: MidenMessageType.DAppGetPayloadResponse,
        payload: served
      };
    }

    if (req?.type === MidenMessageType.DAppSimulateTransactionRequest && (req as any).id === id) {
      if (!handleSimulate) {
        return { type: MidenMessageType.DAppSimulateTransactionResponse, error: 'unsupported' };
      }
      return await handleSimulate(req); // must NOT close() — the popup stays open
    }

    // Any other request from the popup falls through to its own handler.
    if (knownPort !== port || closing || !isConfirmationOf(req, id)) return;
    if (!answer) {
      answer = runAnswer(req);
      return answer;
    }
    // While the action runs a confirmation shares its answer; a decline does too where the action owns the answer,
    // and elsewhere is answered at once (#1471: a refused connect read then saves nothing).
    if (onOwnedAnswerTimeout || !('confirmed' in req) || req.confirmed !== false) return answer;
    return respond(req);
  });

  const isWin = (await browser.runtime.getPlatformInfo()).os === 'win';

  const { confirmWin, position } = await createConfirmWindow(
    browser,
    {
      type: 'popup',
      url: browser.runtime.getURL(`confirm.html#?id=${id}`),
      width: isWin ? CONFIRM_WINDOW_WIDTH + 16 : CONFIRM_WINDOW_WIDTH,
      height: isWin ? CONFIRM_WINDOW_HEIGHT + 17 : CONFIRM_WINDOW_HEIGHT
    },
    await confirmWindowPosition(browser)
  );

  // Ready before any later await: a decline, a close or the autodecline must be able to remove a window that exists.
  const closeWindow = async () => {
    if (confirmWin.id) {
      const win = await browser.windows.get(confirmWin.id);
      if (win.id) {
        await browser.windows.remove(win.id);
      }
    }
  };

  const handleWinRemoved = (winId: number) => {
    if (winId === confirmWin?.id) {
      declineAndClose('window_closed');
    }
  };
  browser.windows.onRemoved.addListener(handleWinRemoved);
  const stopWinRemovedListening = () => browser.windows.onRemoved.removeListener(handleWinRemoved);

  // Firefox currently ignores left/top for create, but it works for update
  if (position && confirmWin.id && confirmWin.left !== position.left && confirmWin.state !== 'fullscreen') {
    try {
      await browser.windows.update(confirmWin.id, position);
    } catch {
      // Chrome checks a move at the window's current size and refuses one that leaves it mostly off-screen; the popup
      // then stays where the browser put it.
    }
  }

  // Decline after timeout, unless a payload request already armed the cap while the window was being created.
  if (!closing && timeout === undefined) restartTimeout(AUTODECLINE_AFTER);
}

type ConfirmWindowPosition = { left: number; top: number };

// Centred on the last-focused browser window. The last-focused window can be another approval popup that is closing or
// that something resized, and a popup centred on it lands off to one side, so any other type gives way to the browser
// windows getAll lists (the polyfill declares a type filter for getAll, not for getLastFocused). The request does not
// say which window the dApp runs in, so a dApp in its own app or popup window gets its confirm on the browser window,
// and with no browser window open the browser places it.
async function confirmWindowPosition(browser: Browser): Promise<ConfirmWindowPosition | undefined> {
  let anchor = await browser.windows.getLastFocused().catch(() => undefined);
  if (anchor?.type !== 'normal') {
    const browserWindows = await browser.windows.getAll({ windowTypes: ['normal'] }).catch((): Windows.Window[] => []);
    anchor = browserWindows.find(win => win.focused) ?? browserWindows[0];
  }
  // The service worker has no `window` to measure instead: with no anchor, the browser places the popup.
  if (!anchor) return undefined;
  const { left, top, width, height } = anchor;
  if (left === undefined || top === undefined || width === undefined || height === undefined) return undefined;
  return {
    left: Math.max(Math.round(left + width / 2 - CONFIRM_WINDOW_WIDTH / 2), 20),
    top: Math.max(Math.round(top + height / 2 - CONFIRM_WINDOW_HEIGHT / 2), 20)
  };
}

// Chrome refuses to create a window mostly off-screen, as one centred on a window dragged away or left on an unplugged
// display would be; given no position, it places the window itself.
async function createConfirmWindow(
  browser: Browser,
  popup: Windows.CreateCreateDataType,
  position: ConfirmWindowPosition | undefined
): Promise<{ confirmWin: Windows.Window; position: ConfirmWindowPosition | undefined }> {
  if (!position) return { confirmWin: await browser.windows.create(popup), position };
  try {
    return { confirmWin: await browser.windows.create({ ...popup, ...position }), position };
  } catch (error) {
    if (!(error instanceof Error && /\bbounds\b/i.test(error.message))) throw error;
    return { confirmWin: await browser.windows.create(popup), position: undefined };
  }
}

export async function getNetworkRPC(net: string | undefined) {
  // When the dApp names no network, use the RPC of the network that the wallet
  // runs on. This is the effective network (the endpoint override, else the
  // build default), not the legacy stored network id: Mainnet invitation
  // onboarding writes only the override (#1655).
  if (!net) {
    return getEffectiveRpcUrl();
  }
  // Only a mainnet wallet takes a mainnet claim. A test-network claim still reaches a mainnet wallet, whose
  // connect sheet warns, because the adapter cannot name mainnet yet.
  if (net === MIDEN_NETWORK_NAME.MAINNET && getEffectiveNetworkName() !== MIDEN_NETWORK_NAME.MAINNET) {
    throw new Error(MidenDAppErrorType.NetworkNotGranted);
  }
  const found = NETWORKS.find(n => n.id === net);
  if (!found) {
    throw new Error(MidenDAppErrorType.NetworkNotGranted);
  }
  return found.rpcBaseURL;

  // if (typeof net === 'string') {
  //   try {
  //     const current = await getCurrentMidenNetwork();
  //     const [currentChainId, targetChainId] = await Promise.all([
  //       loadChainId(current.rpcBaseURL),
  //       loadChainId(targetRpc)
  //     ]);

  //     return targetChainId === null || currentChainId === targetChainId ? current.rpcBaseURL : targetRpc;
  //   } catch {
  //     return targetRpc;
  //   }
  // } else {
  //   return targetRpc;
  // }
}

function isAllowedNetwork() {
  return true;
  //return NETWORKS.some(n => !n.disabled && n.id === net.toString());
}

/**
 * Renders the approval-screen rows for a dApp `requestSend`.
 *
 * The amount is formatted HERE, from the faucet's own decimals, exactly like
 * `formatConsumeTransactionPreview` does. It used to be emitted raw (base
 * units) and divided by a hardcoded `10 ** 6` in the extension's ConfirmPage
 * — which showed the wrong number for any faucet that isn't 6-decimal, showed
 * raw base units on mobile/desktop (whose renderers print the row verbatim),
 * and lost precision above 2^53 because the division went through `Number()`.
 * `formatBigInt` stays in bigint until the last step, so large amounts render
 * exactly.
 */
async function formatSendTransactionPreview(transaction: SendTransaction): Promise<string[]> {
  const tokenMetadata = await getTokenMetadata(transaction.faucetId);
  const amount = formatAmountSafe(
    BigInt(transaction.amount),
    'send',
    tokenMetadata?.decimals,
    hasKnownScale(tokenMetadata)
  );
  // `noteType` was normalized to the persisted 'public'/'private' string by the
  // caller, which also rejected a missing or unrecognized one — so the label
  // below states what will actually be built rather than echoing whatever the
  // page sent. This text is the user's consent surface, and it used to be able
  // to read "Note Type, undefined" for a send that then went out public.
  const tsTexts = [
    'Transfer note from faucet:',
    transaction.faucetId,
    // The paying account must always be on screen. It is dApp-supplied, and while
    // `executingAccountError` now rejects any account other than the connected
    // one, the user still has to be able to SEE which of their accounts is being
    // debited before approving.
    `From, ${transaction.senderAddress}`,
    `Amount, ${amount}`,
    `Recipient, ${transaction.recipientAddress}`,
    `Note Type, ${capitalizeFirstLetter(transaction.noteType)}`
  ];

  if (transaction.recallBlocks) {
    tsTexts.push(`Recall Blocks, ${transaction.recallBlocks}`);
  }

  return tsTexts;
}

/** The note a consume request will actually consume, as resolved by the wallet. */
interface ResolvedConsumeNote {
  noteId: string;
  assets: Asset[];
  nonFungibleAssets: NftAsset[];
  noteType: string;
  restriction?: ConsumeRestriction;
}

/** What a consume sheet shows, and the id of the note it shows, which is the note the approved consume spends. */
interface ConsumePreview {
  noteId: string;
  messages: string[];
}

/**
 * Decodes dApp-carried note bytes (base64) the SAME way the import path does —
 * they may be a serialized `NoteFile` OR a bare `Note`, and the dApp picks which
 * (see `noteIdFromBytes` in note-quarantine.ts). Returns the note's id alongside
 * its real assets and type, or null when neither format parses.
 */
function decodeConsumeNoteBytes(noteBytesB64: string): (ResolvedConsumeNote & { details: NoteDetailsParts }) | null {
  // Never throws for bytes it cannot read: any unreadable byte string just means
  // "the wallet could not decode this", and the caller falls back to reading the
  // note from the store. Refusing the whole request here would break a legitimate
  // dApp that carries a format this build cannot parse but whose note IS resolvable
  // locally. A WebAssembly trap is no such string: it is rethrown for the caller's
  // lock, which retires the client the aborted module belongs to.
  try {
    const bytes = b64ToU8(noteBytesB64);
    let note: Note | undefined;
    try {
      note = NoteFile.deserialize(bytes).note();
    } catch (error) {
      if (error instanceof WebAssembly.RuntimeError) throw error;
      // Not a NoteFile — fall through to a bare Note.
    }
    if (!note) {
      note = Note.deserialize(bytes);
    }
    const metadata = note.metadata();
    return {
      noteId: note.id().toString(),
      details: note,
      noteType: metadata ? toNoteTypeString(metadata.noteType()) : 'unknown',
      restriction: noteConsumeRestriction(note),
      assets: note
        .assets()
        .fungibleAssets()
        .map(asset => ({
          amount: asset.amount().toString(),
          faucetId: getBech32AddressFromAccountId(asset.faucetId())
        })),
      nonFungibleAssets: note.assets().nonFungibleAssets().map(toNft)
    };
  } catch (error) {
    if (error instanceof WebAssembly.RuntimeError) throw error;
    return null;
  }
}

/**
 * The note that carried bytes describe, or null when they do not decode. The request may name the note by its id or
 * its details commitment; bytes matching neither are refused. The returned id is the note's own id for consumption.
 */
function decodeCarriedConsumeNote(transaction: MidenConsumeTransaction): ResolvedConsumeNote | null {
  if (transaction.noteBytes) {
    const decoded = decodeConsumeNoteBytes(transaction.noteBytes);
    if (decoded) {
      if (decoded.noteId !== transaction.noteId) {
        let commitment: string | undefined;
        try {
          commitment = noteDetailsCommitment(decoded.details);
        } catch (error) {
          if (error instanceof WebAssembly.RuntimeError) throw error;
        }
        if (commitment !== normalizedCommitment(transaction.noteId)) {
          throw new Error('noteBytes describe a different note than noteId - refusing to preview it');
        }
      }
      return {
        noteId: decoded.noteId,
        assets: decoded.assets,
        nonFungibleAssets: decoded.nonFungibleAssets,
        noteType: decoded.noteType,
        restriction: decoded.restriction
      };
    }
  }
  return null;
}

/**
 * {@link decodeCarriedConsumeNote} under the WASM lock: a decode that traps rejects the hold, so the lock retires the
 * client before any later call can run on it, and the request is refused rather than read from the store.
 */
async function decodeCarriedConsumeNoteLocked(
  transaction: MidenConsumeTransaction
): Promise<ResolvedConsumeNote | null> {
  if (!transaction.noteBytes) return null;
  return await withWasmClientLock(async () => decodeCarriedConsumeNote(transaction));
}

/**
 * Ground truth for a consume sheet and its approved spend. Carried bytes are checked against the request's id,
 * which may be their note id or details commitment. A note-id match keeps the request's id; a commitment match
 * spends the resolved note's own id. Without decodable bytes, resolve from the store, scoped to this account for
 * commitment matches. Refuse an unresolved note rather than show dApp-declared assets unrelated to the spend.
 */
async function resolveConsumeNote(
  transaction: MidenConsumeTransaction,
  accountId: string
): Promise<ResolvedConsumeNote> {
  const carried = await decodeCarriedConsumeNoteLocked(transaction);
  if (carried) return carried;

  const resolved = await withWasmClientLock(async hold => {
    const [byNoteId] = await midenClientProxy.getInputNoteDetails({ ids: [transaction.noteId] }, () =>
      assertWasmHoldCurrent(hold, 'inside the note-preview read, before the record reach-through')
    );
    // A note found by its id is consumed by the id exactly as the request spells it.
    if (byNoteId) return { details: byNoteId, noteId: transaction.noteId };
    assertWasmHoldCurrent(hold, 'after the note-preview read');
    const byCommitment = await noteOfDetailsCommitment(transaction.noteId, accountId, hold);
    return byCommitment && { details: byCommitment, noteId: byCommitment.noteId };
  });
  if (!resolved) {
    throw new Error(
      `Note ${transaction.noteId} could not be resolved - an imported note resolves once the wallet has synced it`
    );
  }
  const { details, noteId } = resolved;
  return {
    noteId,
    assets: details.assets,
    nonFungibleAssets: details.nonFungibleAssets,
    noteType: details.noteType !== undefined ? toNoteTypeString(details.noteType) : 'unknown',
    restriction: details.restriction
  };
}

/**
 * The note of this account whose details commitment is `commitment`: the id `importPrivateNote` returns for a
 * details-only note file or a bare Note, which no record has as its note id (#1389). Only a note this account can
 * consume is listed and hashed, the same attribution {@link getPrivateNoteDetails} uses, so the id never resolves
 * to another account's note. An uncommitted match remains unresolved until a wallet sync supplies its metadata.
 */
async function noteOfDetailsCommitment(
  commitment: string,
  accountId: string,
  hold: WasmLockHold
): Promise<DetailsCommitmentMatches['notes'][number] | undefined> {
  const consumable = await midenClientProxy.getConsumableNotes(accountId, step =>
    assertWasmHoldCurrent(hold, 'inside the details-commitment consumable-notes read', step)
  );
  assertWasmHoldCurrent(hold, 'after the details-commitment consumable-notes read');
  const own = new Set(consumable.flatMap(note => (note.noteId ? [note.noteId] : [])));
  const [{ notes } = { notes: [] }] = await midenClientProxy.getDetailsCommitmentMatches([commitment], [...own], () =>
    assertWasmHoldCurrent(hold, 'inside the details-commitment read, before the record reach-through')
  );
  if (notes.length > 0) {
    const [note, ...more] = notes.filter(candidate => own.has(candidate.noteId));
    if (more.length > 0) {
      throw new Error(`Note ${commitment} names more than one note this account can consume - refusing to preview it`);
    }
    if (note) return note;
  }
  return undefined;
}

async function formatConsumeTransactionPreview(
  transaction: MidenConsumeTransaction,
  // Decoded before the gate; null makes this decode again, since a service worker that had not loaded the SDK
  // before the unlock could not read the bytes then.
  carried: ResolvedConsumeNote | null,
  accountId: string
): Promise<ConsumePreview> {
  const { noteId, assets, nonFungibleAssets, noteType, restriction } =
    carried ?? (await resolveConsumeNote(transaction, accountId));
  // Refused here, before the sheet: once approved, the consume would fail at execution with
  // ERR_NOTE_ACTIVE_ACCOUNT_IS_NOT_TARGET_ACCOUNT or ERR_RECLAIM_DISABLED, and nothing before execution asks whether the
  // account can consume the note.
  if (!mayConsume(restriction, () => accountRefToSdk(accountId))) {
    throw new Error('This account can never consume this note - refusing it');
  }
  const headlineFaucet = assets[0]?.faucetId ?? nonFungibleAssets[0]?.faucetId;
  const messages = [
    headlineFaucet
      ? `Consuming note from faucet: ${truncateAddress(headlineFaucet, false)}`
      : 'Consuming a note that carries no assets'
  ];
  for (const asset of assets) {
    const tokenMetadata = await getTokenMetadata(asset.faucetId);
    messages.push(
      `Amount, ${formatAmountSafe(BigInt(asset.amount), 'consume', tokenMetadata?.decimals, hasKnownScale(tokenMetadata))}`
    );
  }
  for (const nft of nonFungibleAssets) {
    messages.push(`Receiving, ${describeNft(nft, faucetId => truncateAddress(faucetId, false))}`);
  }
  messages.push(`Note Type, ${capitalizeFirstLetter(noteType)}`);
  const maxFee = await formatMaxNetworkFee();
  if (maxFee) {
    messages.push(`Network fee (max), ${maxFee}`);
  }
  return { noteId, messages };
}

/**
 * Upper bound on what consuming a note will cost, for a sheet with no decoded
 * transaction to read a real fee from.
 *
 * `formatAssetViewRows` prints `view.fee` because a decoded view already carries the
 * charged amount. A consume preview is built BEFORE the transaction exists, so the only
 * honest figure is the bound every review screen quotes: the kernel charges
 * `baseFee x (floor(log2(cycles)) + 1)` and the VM caps cycles at 2^29, which makes
 * `FEE_RESERVE_MULTIPLE` a ceiling no transaction can exceed.
 *
 * `null` -- omit the row -- on a chain that charges nothing, before the fee is
 * discovered, and when the native asset's scale is unknown, matching the house
 * convention everywhere else a fee is shown. The label carries no comma of its own:
 * `ConfirmPage` splits these rows on the first `, `.
 */
async function formatMaxNetworkFee(): Promise<string | null> {
  try {
    const baseFee = await getVerificationBaseFee();
    if (baseFee === null || baseFee <= 0) return null;

    const feeMetadata = await getTokenMetadata(await getNativeAssetId());
    if (!hasKnownScale(feeMetadata)) return null;

    const bound = BigInt(Math.round(baseFee * FEE_RESERVE_MULTIPLE));
    return `${formatAmountSafe(bound, 'send', feeMetadata?.decimals, true)} ${getAssetSymbol(feeMetadata)}`;
  } catch {
    // Discovery is a network call on a path whose job is to render an approval prompt.
    // A prompt missing one row beats a prompt that fails to open.
    return null;
  }
}

/**
 * Shown when the wallet cannot tell the user what a signature authorizes. Same
 * meaning as the extension's `OpaqueSignatureWarning` alert, as a text row: the
 * mobile modal and the desktop overlay render a plain string list.
 */
const OPAQUE_SIGNATURE_WARNING =
  'Warning, this site asked you to sign a value the wallet cannot decode. Only continue if you fully trust this site.';

/**
 * Asset movement of a decoded transaction view, as `Label, value` rows.
 *
 * The extension renders the same `TxAssetView` graphically
 * (`app/confirm/TransactionAssetView`); the mobile modal and the desktop overlay
 * print `transactionMessages` verbatim, so the same numbers have to reach them
 * as strings. Amounts go through the faucet's own decimals, like every other
 * preview row in this file.
 */
const nftFaucetLabel = (faucetId: string) => truncateAddress(faucetId, false);

/**
 * Shown where a summary's vault change counts assets the wallet cannot list (an NFT in a Guardian signing summary,
 * whose vault delta the SDK exposes only as a count). Stands in for the asset rows rather than "No assets move".
 */
const UNLISTED_ASSETS_WARNING =
  'Warning, this transaction also moves an asset the wallet cannot list, such as an NFT. Only continue if you trust it.';

async function formatAssetViewRows(view: TxAssetView): Promise<string[]> {
  const rows: string[] = [];
  for (const asset of view.outgoing) {
    const tokenMetadata = await getTokenMetadata(asset.faucetId);
    rows.push(
      `Sending, ${formatAmountSafe(asset.amount, 'send', tokenMetadata?.decimals, hasKnownScale(tokenMetadata))} ${getAssetSymbol(tokenMetadata)}`
    );
  }
  for (const asset of view.incoming) {
    const tokenMetadata = await getTokenMetadata(asset.faucetId);
    rows.push(
      `Receiving, ${formatAmountSafe(asset.amount, 'consume', tokenMetadata?.decimals, hasKnownScale(tokenMetadata))} ${getAssetSymbol(tokenMetadata)}`
    );
  }
  for (const nft of view.outgoingNfts) rows.push(`Sending, ${describeNft(nft, nftFaucetLabel)}`);
  for (const nft of view.incomingNfts) rows.push(`Receiving, ${describeNft(nft, nftFaucetLabel)}`);
  if (view.unlistedAssets > 0) rows.push(UNLISTED_ASSETS_WARNING);
  if (rows.length === 0) {
    rows.push('Assets, no fungible asset moves');
  }
  rows.push(`Notes, ${view.inputNotesConsumed} consumed / ${view.outputNotesCreated} created`);
  // A cost the user pays, and `outgoing` deliberately excludes it on both decode paths — so
  // if it is not printed here it is not on this sheet at all. Off-extension has no other
  // surface: these rows ARE the approval prompt.
  if (view.fee) {
    const feeMetadata = await getTokenMetadata(view.fee.faucetId);
    rows.push(
      `Network fee, ${formatAmountSafe(view.fee.amount, 'send', feeMetadata?.decimals, hasKnownScale(feeMetadata))} ${getAssetSymbol(feeMetadata)}`
    );
  }
  return rows;
}

/**
 * What the mobile modal / desktop overlay show for `signBytes`.
 *
 * A `signingInputs` payload is a full TRANSACTION authorization — `Vault.signData`
 * runs `wasmSecretKey.signData(SigningInputs.deserialize(...))` on it — so
 * approving one can move the whole balance. The extension decodes it
 * (`SigningInputsPayloadContent` in ConfirmPage) and renders the summary's asset
 * movement; off-extension `signBytes` had no approval sheet at all — it fell into
 * `requestConfirm`'s throw and the dApp's promise never settled (see
 * `confirmOnNonExtension`). These rows are the first thing mobile and desktop show
 * for it, and they are that same decode as text: the summary's real asset movement
 * when the payload carries one, and the explicit opaque-signature warning for the
 * `Arbitrary` / `Blind` variants, for the other `SignKind` (`word`, a raw digest),
 * and for bytes that do not decode at all — mirroring the extension's
 * `OpaqueSignatureWarning`.
 *
 * The summary is ground truth for the signature: it is the very value being
 * signed, not a dApp-declared description of it.
 */
async function formatSignPreview(req: MidenDAppSignRequest): Promise<string[]> {
  const rows = [`Kind, ${req.kind}`, `Account, ${truncateAddress(req.sourcePublicKey)}`];
  if (req.kind !== 'signingInputs') {
    rows.push(OPAQUE_SIGNATURE_WARNING);
    return rows;
  }

  let summary: TransactionSummary | undefined;
  try {
    const signingInputs = SigningInputs.deserialize(b64ToU8(req.payload));
    if (signingInputs.variantType === SigningInputsType.TransactionSummary) {
      summary = signingInputs.transactionSummaryPayload();
    }
  } catch (e) {
    // An undecodable payload is not a reason to refuse — it is a reason to say
    // so. The user still gets the warning row below instead of a bare "Kind".
    console.error('[DApp] Could not decode the signingInputs payload for the approval sheet:', e);
  }

  if (!summary) {
    rows.push(OPAQUE_SIGNATURE_WARNING);
    return rows;
  }

  rows.push('Signing, a transaction that moves these assets');
  rows.push(...(await formatAssetViewRows(summaryToView(summary))));
  return rows;
}

/**
 * What the mobile modal / desktop overlay show for a custom transaction.
 *
 * The two fixed lines plus `From` and `Recipient` used to be the WHOLE sheet
 * off-extension: no amount, no asset, no faucet, and a `Recipient` the dApp
 * simply declared — nothing there was derived from `transactionRequest`, the
 * bytes the wallet then executes. The extension shows the request's own asset movement
 * (`CustomTransactionContent`: the simulated summary, falling back to
 * `declaredRequestToView`), so the same static decode is rendered here as rows.
 *
 * `declared` is that offline decode of the request the wallet will execute,
 * built in the caller's WASM hold (undefined when it could not be summarised).
 * There is no dry run, so it is labelled unverified, exactly as the extension
 * labels its declared view. `recipientAddress` stays dApp-declared and is
 * labelled as such: it is not derived from the request bytes and nothing
 * downstream checks it.
 */
async function formatCustomTransactionPreview(
  payload: MidenCustomTransaction,
  declared: TxAssetView | undefined
): Promise<string[]> {
  const messages = [
    'This dApp is requesting a custom transaction,',
    'please ensure you know the details of the transaction before proceeding.',
    // Executing account first, for the same reason as the send preview.
    `From, ${truncateAddress(payload.address)}`
  ];

  if (declared) {
    messages.push('Declared by the site, the wallet has not verified these amounts');
    messages.push(...(await formatAssetViewRows(declared)));
  } else {
    messages.push('Warning, the wallet could not decode this transaction request — it cannot show what it does');
  }

  if (payload.recipientAddress) {
    messages.push(`Recipient (declared by the site), ${truncateAddress(payload.recipientAddress)}`);
  }

  return messages;
}

/**
 * What a custom transaction will actually do, as lines for an approval sheet.
 *
 * A custom transaction is an opaque base64 `TransactionRequest`, so it can do
 * anything the account can, and the three lines of
 * {@link formatCustomTransactionPreview} describe none of it. The extension's
 * approval page resolves that by running the dry run itself over the intercom
 * (`makeSimulateHandler`) and rendering the asset movements it returns. The
 * mobile and desktop sheets have no route to that call and render only
 * `transactionMessages`, so they asked for consent to an unnamed transfer of an
 * unnamed amount — "please ensure you know the details" and a recipient. Run the
 * same dry run here, on the same account binding checked above, and put its
 * result into the list those sheets already render.
 *
 * A dry run that could not be produced is STATED rather than omitted: no
 * movement lines is otherwise indistinguishable from a transaction that moves
 * nothing, which is the reading most likely to get an approval. Nothing in here
 * throws — a preview that fails must not take down the request that a user could
 * still legitimately decline.
 */
/**
 * Effects of a custom request's dry run: the lines the approval sheet renders, and the per-faucet
 * value LEAVING the account that the spending-limit policy needs.
 *
 * `outgoing` is undefined when the dry run produced NEITHER ground-truth shape. That is "unknown
 * value", not "no value": admitting such a request unassessed would make a deliberately
 * unsimulatable request the way around a configured cap. Decoding only the summary shape put every
 * ordinary single-sig account in that bucket and refused all of their custom transactions.
 *
 * Takes the dry-run result rather than running it, so the request is simulated ONCE.
 *
 * The lines the signer reads are the GROSS legs - what leaves and what enters, stated separately,
 * because that is what a person checking a transaction wants to see. The figure handed to the
 * spending-limit policy is the NET outflow after crediting only what this request brought in, so
 * the two are deliberately not the same number and the sheet is the more conservative of them.
 */
async function formatSimulatedCustomEffects(
  simulated: SimulateCustomTxResult
): Promise<{ messages: string[]; outgoing?: IConsumedAssetTotal[] }> {
  try {
    const view = simulatedBytesToView(simulated);
    if (!view) throw new Error(simulated.error ?? 'no summary was produced');
    // The summary arm reports a NETTED vault delta with no note identity, so it has already
    // credited every consumed note - including ones the wallet already held, which are the user's
    // own value. When it consumed more notes than this request introduced, that figure understates
    // the outflow and cannot be corrected here.
    //
    // This withholds the POLICY's number, not the sheet's. The effect lines are still shown, still
    // gross, and still useful to a person reading them; it is only the automated cap that must not
    // act on a figure it cannot attribute, and it refuses on `outgoing === undefined` already.
    const attributable =
      simulated.summaryBytes === undefined || view.inputNotesConsumed <= (simulated.introducedCount ?? 0);
    const movement = async (asset: AssetAmount, direction: 'send' | 'consume') => {
      const metadata = await getTokenMetadata(asset.faucetId);
      const amount = formatAmountSafe(asset.amount, direction, metadata?.decimals, hasKnownScale(metadata));
      return `${direction === 'send' ? 'Leaves this account' : 'Enters this account'}, ${amount} ${
        metadata?.symbol ?? ''
      }`.trimEnd();
    };

    const effects = [
      ...(await Promise.all(view.outgoing.map(asset => movement(asset, 'send')))),
      ...(await Promise.all(view.incoming.map(asset => movement(asset, 'consume')))),
      ...view.outgoingNfts.map(nft => `Leaves this account, ${describeNft(nft, nftFaucetLabel)}`),
      ...view.incomingNfts.map(nft => `Enters this account, ${describeNft(nft, nftFaucetLabel)}`)
    ];
    if (view.unlistedAssets > 0) effects.push(UNLISTED_ASSETS_WARNING);
    // BEFORE the "nothing moves" check, and separate from it. `summaryToView` subtracts the
    // fee out of `outgoing` so it is not double-counted against the transfer, which means a
    // transaction whose ONLY movement is the fee arrives here with two empty lists -- and
    // "No assets move" is exactly the reading most likely to get an approval for something
    // that does in fact cost the user money.
    if (view.fee) {
      const feeMetadata = await getTokenMetadata(view.fee.faucetId);
      const feeAmount = formatAmountSafe(view.fee.amount, 'send', feeMetadata?.decimals, hasKnownScale(feeMetadata));
      effects.push(`Network fee, ${feeAmount} ${feeMetadata?.symbol ?? ''}`.trimEnd());
    }
    if (effects.length === 0) {
      effects.push('No assets move');
    }
    effects.push(`Notes consumed, ${view.inputNotesConsumed}`, `Notes created, ${view.outputNotesCreated}`);
    if (view.storageChanged) {
      effects.push('Changes this account’s stored data');
    }

    return {
      messages: ['Simulated effects:', ...effects],
      // Netted and folded per faucet: the policy charges what actually leaves, once per asset.
      ...(attributable && {
        outgoing: netOutflowByFaucet(view, simulated.introducedCredit).map(asset => ({
          faucetId: asset.faucetId,
          amount: asset.amount
        }))
      })
    };
  } catch (e: any) {
    console.error('Failed to simulate a custom transaction for approval', e);
    return {
      messages: ['This transaction could not be simulated, so its effects are unknown.', `Reason, ${consentReason(e)}`]
    };
  }
}

/**
 * The one-line reason shown on a signing consent sheet when the dry run failed.
 *
 * An abandonment reaches here as wallet-internal text — "WASM client poisoned
 * (watchdog): held the WASM client lock past its watchdog ceiling" — because the
 * simulation flattens its error to a message string and this sheet interpolates
 * it. That says nothing a signer can act on, and a consent line is the last place
 * to spend on jargon; the real error is already on the console above.
 */
function consentReason(e: unknown): string {
  if (isPipelineKillLink(e)) {
    return 'the simulation was interrupted before it finished';
  }
  return dryRunFailureReason(e instanceof Error ? e.message : String(e));
}

/**
 * A failed dry run's text as the wallet shows it or hands it on. The dry run executes the bytes the write would, so a
 * kernel failure the Failed row would name reads through that row's copy rather than as its hashed code (#1475).
 */
function dryRunFailureReason(text: string): string {
  return deterministicKernelFailureCopy(text) ?? text;
}

// Background-safe helpers (duplicated from UI without UI deps)
/**
 * `scaleIsKnown === false` renders the amount as `?` rather than a number.
 *
 * This text is what a dApp's transaction confirmation shows the user before they
 * approve it. A faucet the wallet could not read has no trustworthy decimals,
 * and printing the placeholder's guess here states a quantity the user is about
 * to authorise on the strength of that guess. A question mark is unhelpful; a
 * confident wrong number is worse.
 */
function formatAmountSafe(
  amount: bigint,
  transactionType: 'send' | 'consume',
  tokenDecimals: number | undefined,
  scaleIsKnown: boolean
) {
  const normalizedAmount = scaleIsKnown ? formatBigInt(amount, tokenDecimals ?? MIDEN_METADATA.decimals) : '?';
  if (transactionType === 'consume') {
    return `+${normalizedAmount}`;
  }
  return transactionType === 'send' ? `-${normalizedAmount}` : normalizedAmount;
}
