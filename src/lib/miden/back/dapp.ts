import {
  AllowedPrivateData,
  Asset,
  InputNoteDetails,
  MidenConsumeTransaction,
  MidenCustomTransaction,
  PrivateDataPermission,
  SendTransaction
} from '@demox-labs/miden-wallet-adapter-base';
import {
  Note,
  NoteFile,
  NoteFilterTypes,
  NoteType,
  SigningInputs,
  SigningInputsType,
  type NoteQuery,
  type TransactionSummary
} from '@miden-sdk/miden-sdk/lazy';
import { nanoid } from 'nanoid';
import type { Runtime } from 'webextension-polyfill';

import {
  declaredRequestToView,
  summaryBytesToView,
  summaryToView,
  type AssetAmount,
  type TxAssetView
} from 'app/confirm/decode';
import {
  MidenDAppDisconnectRequest,
  MidenDAppDisconnectResponse,
  MidenDAppErrorType,
  MidenDAppGetCurrentPermissionResponse,
  MidenDAppGuardianInfoRequest,
  MidenDAppGuardianInfoResponse,
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
import {
  dappConfirmationStore,
  type DAppConfirmationRequest,
  type DAppConfirmationResult
} from 'lib/dapp-browser/confirmation-store';
import { formatBigInt } from 'lib/i18n/numbers';
import { intercom } from 'lib/miden/back/defaults';
import { Vault } from 'lib/miden/back/vault';
import { guardianProviderFromEndpoint, resolveGuardianEndpoint } from 'lib/miden/guardian/account';
import { MIDEN_METADATA } from 'lib/miden/metadata';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { getAssetSymbol, getTokenMetadata } from 'lib/miden/metadata/utils';
import { NETWORKS } from 'lib/miden/networks';
import { importedNoteIds, releaseNoteIds } from 'lib/miden/note-quarantine';
import {
  DappMetadata,
  MidenDAppPayload,
  MidenDAppSession,
  MidenDAppSessions,
  MidenDAppTransactionPayload,
  MidenMessageType,
  MidenRequest
} from 'lib/miden/types';
import { isDesktop, isExtension } from 'lib/platform';
import { getStorageProvider } from 'lib/platform/storage-adapter';
import { DEFAULT_DELEGATE_PROOF } from 'lib/settings/constants';
import { b64ToU8, bytesToHex, u8ToB64 } from 'lib/shared/helpers';
import { GuardianInfo, WalletStatus } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';
import { capitalizeFirstLetter, truncateAddress } from 'utils/string';

import { queueNoteImport } from '../activity';
import { isLikelyNetworkError } from '../activity/connectivity-classify';
import { assertValidRecallBlocks, toNoteTypeString, toPersistedNoteType } from '../helpers';
import { midenClientProxy } from './miden-client-proxy';
import { isOperationAbortedError } from './offscreen-codec';
import { getCurrentMidenNetwork } from './safe-network';
import { simulateCustomTransaction } from './simulate-custom-tx';
import { store, withUnlocked } from './store';
import { startTransactionProcessing } from './transaction-processor';
import { getBech32AddressFromAccountId, sameWalletAccountId } from '../sdk/helpers';
import { withWasmClientLock } from '../sdk/miden-client';
import { resolvePublicKeyCommitments } from '../sdk/resolve-public-key-commitments';
import { isWasmClientPoisonedError } from '../sdk/wasm-client-poison';
import {
  initiateSendTransaction,
  requestCustomTransaction,
  initiateConsumeTransactionFromId,
  waitForTransactionCompletion
} from '../transaction';

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

async function getAccountPublicKeyB64(accountId: string): Promise<string> {
  const account = await midenClientProxy.getAccount(accountId);
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
 * The 32 bytes a signer-commitment string denotes, whatever form it arrived in,
 * as lowercase hex — or undefined if it denotes none.
 *
 * Both forms are in circulation for the same commitment, and a comparison that
 * knew only one would be worse than none: it would refuse legitimate signing
 * while looking like a working check. `connect` hands the page b64 of
 * `Word.serialize()`; the vault stores its key blobs under `Word.toHex()` with
 * the `0x` dropped, which is the form `signData` looks up by. Those two encode
 * the identical 32 bytes (verified against @miden-sdk/miden-sdk: `toHex()` sans
 * prefix is byte-for-byte `serialize()`), so normalizing to bytes is what makes
 * them comparable rather than merely similar.
 */
function commitmentToHex(value: string): string | undefined {
  const unprefixed = value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value;
  if (/^[0-9a-fA-F]{64}$/.test(unprefixed)) {
    return unprefixed.toLowerCase();
  }
  try {
    const bytes = b64ToU8(value);
    if (bytes.length !== 32) return undefined;
    return Buffer.from(bytes).toString('hex');
  } catch {
    return undefined;
  }
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
async function publicKeyBelongsToAccount(accountId: string, suppliedPublicKey: string): Promise<boolean> {
  const supplied = commitmentToHex(suppliedPublicKey);
  if (supplied === undefined) return false;
  const account = await midenClientProxy.getAccount(accountId);
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

const CONFIRM_WINDOW_WIDTH = 380;
const CONFIRM_WINDOW_HEIGHT = 632;
const AUTODECLINE_AFTER = 120_000;
const STORAGE_KEY = 'dapp_sessions';

export async function getCurrentPermission(origin: string): Promise<MidenDAppGetCurrentPermissionResponse> {
  const currentAccountPubKey = await Vault.getCurrentAccountPublicKey();
  const dApp = currentAccountPubKey ? await getDApp(origin, currentAccountPubKey) : undefined;
  const permission = dApp
    ? {
        rpc: await getNetworkRPC(dApp.network),
        address: dApp.accountId,
        privateDataPermission: dApp.privateDataPermission,
        allowedPrivateData: dApp.allowedPrivateData
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
  sessionId?: string
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
    !!dApp,
    req.privateDataPermission,
    req.allowedPrivateData,
    sessionId
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
  sessionId?: string
): Promise<MidenDAppPermissionResponse> {
  dappDebug('[generatePromisifyRequestPermission] Called, isExtension:', isExtension());
  // On mobile/desktop, use confirmation store to request user approval
  if (!isExtension()) {
    const id = nanoid();
    dappLog(`[DApp] Non-extension requesting confirmation for: ${origin} id: ${id} sessionId: ${sessionId}`);
    dappLog(`[DApp] Calling dappConfirmationStore.requestConfirmation...`);

    // Request confirmation from the user via the confirmation store
    dappLog(`[DApp] About to call requestConfirmation, store instance: ${dappConfirmationStore.getInstanceId()}`);
    const result = await dappConfirmationStore.requestConfirmation({
      id,
      sessionId,
      type: 'connect',
      origin,
      appMeta,
      network,
      networkRpc,
      privateDataPermission: privateDataPermission || PrivateDataPermission.UponRequest,
      allowedPrivateData: allowedPrivateData || AllowedPrivateData.None,
      existingPermission
    });
    dappLog(`[DApp] requestConfirmation returned! confirmed: ${result.confirmed}`);

    if (!result.confirmed || !result.accountPublicKey) {
      throw new Error(MidenDAppErrorType.NotGranted);
    }

    const accountPublicKey = result.accountPublicKey;
    let publicKey: string | null = null;

    try {
      publicKey = await withUnlocked(async () => {
        return await withWasmClientLock(async () => {
          return await getAccountPublicKeyB64(accountPublicKey);
        });
      });
    } catch (e) {
      console.error('[DApp] Error fetching account public key:', e);
      // A lock-recovery eviction is a retryable internal failure, not a
      // permissions verdict (issue #775).
      if (isWasmClientPoisonedError(e)) throw e;
      throw new Error(MidenDAppErrorType.NotGranted);
    }

    if (!existingPermission) {
      await setDApp(origin, {
        network,
        appMeta,
        accountId: accountPublicKey,
        privateDataPermission: result.privateDataPermission || PrivateDataPermission.UponRequest,
        allowedPrivateData: allowedPrivateData || AllowedPrivateData.None,
        publicKey: publicKey!
      });
    }

    dappDebug('[DApp] Non-extension approved connection for:', origin);
    return {
      type: MidenDAppMessageType.PermissionResponse,
      accountId: accountPublicKey,
      network,
      privateDataPermission: result.privateDataPermission || PrivateDataPermission.UponRequest,
      allowedPrivateData: allowedPrivateData || AllowedPrivateData.None,
      publicKey: publicKey!
    };
  }

  return new Promise(async (resolve, reject) => {
    const id = nanoid();

    await requestConfirm({
      id,
      payload: {
        type: 'connect',
        origin,
        networkRpc,
        appMeta,
        privateDataPermission: privateDataPermission || PrivateDataPermission.UponRequest,
        allowedPrivateData: allowedPrivateData || AllowedPrivateData.None,
        existingPermission
      },
      onDecline: () => {
        reject(new Error(MidenDAppErrorType.NotGranted));
      },
      handleIntercomRequest: async (confirmReq, decline) => {
        if (confirmReq?.type === MidenMessageType.DAppPermConfirmationRequest && confirmReq?.id === id) {
          const { confirmed, accountPublicKey, privateDataPermission } = confirmReq;
          if (confirmed && accountPublicKey) {
            let publicKey: string | null = null;
            try {
              publicKey = await withUnlocked(async () => {
                // Wrap WASM client operations in a lock to prevent concurrent access
                return await withWasmClientLock(async () => {
                  return await getAccountPublicKeyB64(accountPublicKey);
                });
              });
            } catch (e) {
              console.error('Error fetching account public key:', e);
            }
            if (publicKey == null) {
              // A failed public-key fetch must fail the connect, not persist a
              // session with publicKey: null. The direct-return path hands that
              // null pubkey back verbatim on every later connect, wedging the
              // dApp at "Connecting…" until the session is cleared. Mirrors the
              // non-extension branch, which throws NotGranted on the same failure.
              decline();
            } else {
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
            }
          } else {
            decline();
          }

          return {
            type: MidenMessageType.DAppPermConfirmationResponse
          };
        }
        return undefined;
      }
    });
  });
}

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
  type: DAppConfirmationRequest['type'],
  origin: string,
  dApp: MidenDAppSession,
  networkRpc: string,
  detailMessages: string[],
  sessionId?: string
): Promise<boolean> {
  const id = nanoid();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      dappConfirmationStore.requestConfirmation({
        id,
        sessionId,
        type,
        origin,
        appMeta: dApp.appMeta,
        network: dApp.network,
        networkRpc,
        privateDataPermission: dApp.privateDataPermission,
        allowedPrivateData: dApp.allowedPrivateData,
        existingPermission: true,
        transactionMessages: detailMessages,
        sourcePublicKey: dApp.accountId
      }),
      // Backstop watchdog, mirroring `requestConfirm`'s AUTODECLINE_AFTER on the
      // extension popup path. Without it a prompt that never reaches a renderer
      // — a routing bug, a session closed before its modal mounted — leaves this
      // promise pending forever, and because `processDApp` runs every request
      // through ONE `PQueue({concurrency: 1})` shared by every origin, that
      // wedges dApp handling process-wide until a full restart.
      new Promise<DAppConfirmationResult>(resolve => {
        timer = setTimeout(() => {
          // Only cancel OUR entry: the slot is keyed by session, and a later
          // request may already have replaced it.
          if (dappConfirmationStore.getPendingRequest(sessionId)?.id === id) {
            dappConfirmationStore.resolveConfirmation(sessionId, { confirmed: false });
          }
          resolve({ confirmed: false });
        }, AUTODECLINE_AFTER);
      })
    ]);
    return result.confirmed;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
      const confirmed = await confirmOnNonExtension(
        'sign',
        origin,
        dApp,
        networkRpc,
        await formatSignPreview(req),
        sessionId
      );
      if (!confirmed) {
        reject(new Error(MidenDAppErrorType.NotGranted));
        return;
      }
      const signature = await withUnlocked(async ({ vault }) =>
        vault.signData(req.sourcePublicKey, req.payload, req.kind, req.sourceAccountId)
      );
      resolve({ type: MidenDAppMessageType.SignResponse, signature });
    } catch (e) {
      reject(new Error(`${MidenDAppErrorType.InvalidParams}: ${e}`));
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
            withWasmClientLock(() => publicKeyBelongsToAccount(dApp.accountId, req.sourcePublicKey))
          ).catch(err => (isWasmClientPoisonedError(err) ? err : false));
          if (authorized !== true) {
            // A lock-recovery eviction (issue #775) is not an authorization
            // verdict — reject an APPROVED request with the real, retryable
            // failure rather than a false NotGranted.
            reject(isWasmClientPoisonedError(authorized) ? authorized : new Error(MidenDAppErrorType.NotGranted));
            return {
              type: MidenMessageType.DAppSignConfirmationResponse
            };
          }
          try {
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
            reject(new Error(`${MidenDAppErrorType.InvalidParams}: ${e}`));
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

  // `.catch(reject)`: each `generatePromisify*` is an async function invoked
  // inside this executor, so a throw of its own would otherwise become an
  // unhandled rejection and leave the dApp's promise unsettled forever (the
  // caller only ever sees the injection script's 5-minute "Request timeout").
  return new Promise((resolve, reject) => {
    generatePromisifyRequestPrivateNotes(resolve, reject, origin, dApp, req, sessionId).catch(reject);
  });
}

const generatePromisifyRequestPrivateNotes = async (
  resolve: (value: MidenDAppPrivateNotesResponse | PromiseLike<MidenDAppPrivateNotesResponse>) => void,
  reject: (reason?: any) => void,
  origin: string,
  dApp: MidenDAppSession,
  req: MidenDAppPrivateNotesRequest,
  sessionId?: string
) => {
  let privateNotes: InputNoteDetails[] = [];
  if (
    dApp.privateDataPermission === PrivateDataPermission.Auto &&
    (dApp.allowedPrivateData & AllowedPrivateData.Notes) !== 0
  ) {
    try {
      privateNotes = await getPrivateNoteDetails(dApp.accountId, req.notefilterType, req.noteIds);
      resolve({
        type: MidenDAppMessageType.PrivateNotesResponse,
        privateNotes: privateNotes
      });
    } catch (e) {
      reject(e);
    }
  } else {
    const id = nanoid();
    const networkRpc = await getNetworkRPC(dApp.network);

    try {
      privateNotes = await getPrivateNoteDetails(dApp.accountId, req.notefilterType, req.noteIds);
    } catch (e) {
      reject(e);
      return;
    }

    if (!isExtension()) {
      const confirmed = await confirmOnNonExtension(
        'privateData',
        origin,
        dApp,
        networkRpc,
        ['This app is requesting your private notes.', `Notes, ${privateNotes.length}`],
        sessionId
      );
      if (!confirmed) {
        reject(new Error(MidenDAppErrorType.NotGranted));
        return;
      }
      resolve({ type: MidenDAppMessageType.PrivateNotesResponse, privateNotes });
      return;
    }

    await requestConfirm({
      id,
      payload: {
        type: 'privateNotes',
        origin,
        networkRpc,
        appMeta: dApp.appMeta,
        sourcePublicKey: req.sourcePublicKey,
        privateNotes: privateNotes,
        preview: null
      },
      onDecline: () => {
        reject(new Error(MidenDAppErrorType.NotGranted));
      },
      handleIntercomRequest: async (confirmReq, decline) => {
        if (confirmReq?.type === MidenMessageType.DAppPrivateNotesConfirmationRequest && confirmReq?.id === id) {
          if (confirmReq.confirmed) {
            try {
              resolve({
                type: MidenDAppMessageType.PrivateNotesResponse,
                privateNotes
              } as any);
            } catch (e) {
              reject(new Error(`${MidenDAppErrorType.InvalidParams}: ${e}`));
            }
          } else {
            decline();
          }

          return {
            type: MidenMessageType.DAppPrivateNotesConfirmationResponse
          };
        }
        return undefined;
      }
    });
  }
};

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
 */
async function getPrivateNoteDetails(
  accountId: string,
  notefilterType: NoteFilterTypes,
  noteIds?: string[]
): Promise<InputNoteDetails[]> {
  let privateNotes: InputNoteDetails[] = [];
  try {
    privateNotes = await withUnlocked(async () => {
      return await withWasmClientLock(async () => {
        const query = noteFilterTypeToQuery(notefilterType, noteIds);
        const allNotes = await midenClientProxy.getInputNoteDetails(query);
        const ownNoteIds = new Set(
          (await midenClientProxy.getConsumableNotes(accountId)).flatMap(note => (note.noteId ? [note.noteId] : []))
        );
        return allNotes.filter(note => note.noteType === NoteType.Private && ownNoteIds.has(note.noteId));
      });
    });
    return privateNotes;
  } catch (e) {
    // A lock-recovery eviction is a retryable internal failure, not a
    // parameter problem (issue #775).
    if (isWasmClientPoisonedError(e)) throw e;
    throw new Error(`${MidenDAppErrorType.InvalidParams}: ${e}`);
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

  // `.catch(reject)`: each `generatePromisify*` is an async function invoked
  // inside this executor, so a throw of its own would otherwise become an
  // unhandled rejection and leave the dApp's promise unsettled forever (the
  // caller only ever sees the injection script's 5-minute "Request timeout").
  return new Promise((resolve, reject) => {
    generatePromisifyRequestConsumableNotes(resolve, reject, origin, dApp, req, sessionId).catch(reject);
  });
}

export const generatePromisifyRequestConsumableNotes = async (
  resolve: (value: MidenDAppConsumableNotesResponse | PromiseLike<MidenDAppConsumableNotesResponse>) => void,
  reject: (reason?: any) => void,
  origin: string,
  dApp: MidenDAppSession,
  req: MidenDAppConsumableNotesRequest,
  sessionId?: string
) => {
  let consumableNotes: InputNoteDetails[] = [];
  if (
    dApp.privateDataPermission === PrivateDataPermission.Auto &&
    (dApp.allowedPrivateData & AllowedPrivateData.Notes) !== 0
  ) {
    try {
      consumableNotes = await getConsumableNotes(dApp.accountId);
      resolve({
        type: MidenDAppMessageType.ConsumableNotesResponse,
        consumableNotes
      });
    } catch (e) {
      reject(e);
    }
  } else {
    const id = nanoid();
    const networkRpc = await getNetworkRPC(dApp.network);

    try {
      consumableNotes = await getConsumableNotes(dApp.accountId);
    } catch (e) {
      reject(e);
      return;
    }

    if (!isExtension()) {
      const confirmed = await confirmOnNonExtension(
        'privateData',
        origin,
        dApp,
        networkRpc,
        ['This app is requesting your consumable notes.', `Notes, ${consumableNotes.length}`],
        sessionId
      );
      if (!confirmed) {
        reject(new Error(MidenDAppErrorType.NotGranted));
        return;
      }
      resolve({ type: MidenDAppMessageType.ConsumableNotesResponse, consumableNotes });
      return;
    }

    await requestConfirm({
      id,
      payload: {
        type: 'consumableNotes',
        origin,
        networkRpc,
        appMeta: dApp.appMeta,
        sourcePublicKey: req.sourcePublicKey,
        consumableNotes,
        preview: null
      },
      onDecline: () => {
        reject(new Error(MidenDAppErrorType.NotGranted));
      },
      handleIntercomRequest: async (confirmReq, decline) => {
        if (confirmReq?.type === MidenMessageType.DAppConsumableNotesConfirmationRequest && confirmReq?.id === id) {
          if (confirmReq.confirmed) {
            try {
              resolve({
                type: MidenDAppMessageType.ConsumableNotesResponse,
                consumableNotes
              } as any);
            } catch (e) {
              reject(new Error(`${MidenDAppErrorType.InvalidParams}: ${e}`));
            }
          } else {
            decline();
          }

          return {
            type: MidenMessageType.DAppConsumableNotesConfirmationResponse
          };
        }
        return undefined;
      }
    });
  }
};

async function getConsumableNotes(accountId: string): Promise<InputNoteDetails[]> {
  let consumableNotes: InputNoteDetails[] = [];
  try {
    consumableNotes = await withUnlocked(async () => {
      // Wrap WASM client operations in a lock to prevent concurrent access
      return await withWasmClientLock(async () => {
        await midenClientProxy.syncState();
        // Consumable notes as DTOs (issue #260, slice 4). The reclaim gate + the
        // reduction ran in the client's realm (offscreen when the flag is on, so
        // it uses the same realm that just ran syncState above — no stale height).
        // The DTO is a strict superset of InputNoteDetails; map it 1:1.
        const notes = await midenClientProxy.getConsumableNotes(accountId);
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
    // A lock-recovery eviction is a retryable internal failure, not a
    // parameter problem (issue #775).
    if (isWasmClientPoisonedError(e)) throw e;
    throw new Error(`${MidenDAppErrorType.InvalidParams}: ${e}`);
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

  // `.catch(reject)`: each `generatePromisify*` is an async function invoked
  // inside this executor, so a throw of its own would otherwise become an
  // unhandled rejection and leave the dApp's promise unsettled forever (the
  // caller only ever sees the injection script's 5-minute "Request timeout").
  return new Promise((resolve, reject) => {
    generatePromisifyRequestAssets(resolve, reject, origin, dApp, req, sessionId).catch(reject);
  });
}

export const generatePromisifyRequestAssets = async (
  resolve: (value: MidenDAppAssetsResponse | PromiseLike<MidenDAppAssetsResponse>) => void,
  reject: (reason?: any) => void,
  origin: string,
  dApp: MidenDAppSession,
  req: MidenDAppAssetsRequest,
  sessionId?: string
) => {
  if (
    dApp.privateDataPermission === PrivateDataPermission.Auto &&
    (dApp.allowedPrivateData & AllowedPrivateData.Assets) !== 0
  ) {
    let assets: Asset[] = [];
    try {
      assets = await getAssets(dApp.accountId);
      resolve({
        type: MidenDAppMessageType.AssetsResponse,
        assets
      });
    } catch (e) {
      reject(e);
    }
  } else {
    const id = nanoid();
    const networkRpc = await getNetworkRPC(dApp.network);

    let assets: Asset[] = [];
    try {
      assets = await getAssets(dApp.accountId);
    } catch (e) {
      reject(e);
      return;
    }

    if (!isExtension()) {
      const confirmed = await confirmOnNonExtension(
        'privateData',
        origin,
        dApp,
        networkRpc,
        ['This app is requesting your account balances.', `Assets, ${assets.length}`],
        sessionId
      );
      if (!confirmed) {
        reject(new Error(MidenDAppErrorType.NotGranted));
        return;
      }
      resolve({ type: MidenDAppMessageType.AssetsResponse, assets });
      return;
    }

    await requestConfirm({
      id,
      payload: {
        type: 'assets',
        origin,
        networkRpc,
        appMeta: dApp.appMeta,
        sourcePublicKey: req.sourcePublicKey,
        assets,
        preview: null
      },
      onDecline: () => {
        reject(new Error(MidenDAppErrorType.NotGranted));
      },
      handleIntercomRequest: async (confirmReq, decline) => {
        if (confirmReq?.type === MidenMessageType.DAppAssetsConfirmationRequest && confirmReq?.id === id) {
          if (confirmReq.confirmed) {
            try {
              resolve({
                type: MidenDAppMessageType.AssetsResponse,
                assets
              } as any);
            } catch (e) {
              reject(new Error(`${MidenDAppErrorType.InvalidParams}: ${e}`));
            }
          } else {
            decline();
          }

          return {
            type: MidenMessageType.DAppAssetsConfirmationResponse
          };
        }
        return undefined;
      }
    });
  }
};

async function getAssets(accountId: string): Promise<Asset[]> {
  let assets: Asset[] = [];
  try {
    assets = await withUnlocked(async () => {
      // Wrap WASM client operations in a lock to prevent concurrent access
      return await withWasmClientLock(async () => {
        const account = await midenClientProxy.getAccount(accountId);
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
    // A lock-recovery eviction is a retryable internal failure, not a
    // parameter problem (issue #775).
    if (isWasmClientPoisonedError(e)) throw e;
    throw new Error(`${MidenDAppErrorType.InvalidParams}: ${e}`);
  }
}

// Direct-return handler (mirrors getCurrentPermission) — guardian info is
// non-sensitive, so it skips the requestConfirm popup that gated Assets.
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

  const guardianInfo = await getGuardianInfoData(dApp.accountId);
  return {
    type: MidenDAppMessageType.GuardianInfoResponse,
    guardianInfo
  };
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

    const guardianEndpoint = await resolveGuardianEndpoint(account);
    const status = account.guardianSyncStatus ?? 'in-sync';
    return {
      isGuardianAccount: true,
      guardianEndpoint: guardianEndpoint || null,
      guardianProvider: guardianProviderFromEndpoint(guardianEndpoint || null),
      guardianSyncStatus: status === 'in-sync' ? 'in-sync' : 'out-of-sync'
    };
  });
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
      withWasmClientLock(async () => {
        const noteAsUint8Array = b64ToU8(note);
        const noteId = await midenClientProxy.importNoteBytes(noteAsUint8Array);
        await midenClientProxy.syncState();
        return noteId;
      })
    );
  } catch (e) {
    // Both abandonment shapes, for the reason the same gate in `back/main.ts` gives: an
    // eviction or a deadline kill leaves it unknown whether the note landed, so the note
    // has to be preserved. This is the sharper of the two sites — the dApp is the only
    // other holder of these bytes.
    //
    // Of the two, only the poison shape is one `isLikelyNetworkError` genuinely misses
    // (its message is closed wallet-authored text). The abort shape reaches the classifier
    // as a match today purely because its message contains 'aborted', which is a
    // coincidence of transport-text heuristics rather than a contract — so it is named
    // here too, and the clause stays load-bearing the moment that token list is re-tuned.
    if (isLikelyNetworkError(e) || isWasmClientPoisonedError(e) || isOperationAbortedError(e)) {
      await queueNoteImport(note).catch(queueError =>
        console.error('[importDAppPrivateNote] failed to queue the note for background retry', queueError)
      );
    }
    throw e;
  }
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
      const confirmed = await confirmOnNonExtension(
        'importPrivateNote',
        origin,
        dApp,
        networkRpc,
        [`Account, ${truncateAddress(dApp.accountId)}`],
        sessionId
      );
      if (!confirmed) {
        reject(new Error(MidenDAppErrorType.NotGranted));
        return;
      }
      const noteId = await importDAppPrivateNote(req.note);
      resolve({ type: MidenDAppMessageType.ImportPrivateNoteResponse, noteId });
    } catch (e) {
      reject(new Error(`${MidenDAppErrorType.InvalidParams}: ${e}`));
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
            const noteId = await importDAppPrivateNote(req.note);
            resolve({
              type: MidenDAppMessageType.ImportPrivateNoteResponse,
              // Hex string: the note ID for metadata-bearing files, or the
              // details commitment for details-only imports (the common
              // dApp `noteBytes` path).
              noteId
            });
          } catch (e) {
            reject(new Error(`${MidenDAppErrorType.InvalidParams}: ${e}`));
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
export function makeSimulateHandler(id: string, tx: MidenCustomTransaction) {
  return async (req: MidenRequest): Promise<any | undefined> => {
    if (req?.type !== MidenMessageType.DAppSimulateTransactionRequest || (req as any).id !== id) {
      return undefined;
    }
    const { summaryBytes, executedBytes, error } = await simulateCustomTransaction({
      address: tx.address,
      transactionRequest: tx.transactionRequest,
      importNotes: tx.importNotes
    });
    return { type: MidenMessageType.DAppSimulateTransactionResponse, summaryBytes, executedBytes, error };
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

  let transactionMessages: string[] = [];
  try {
    transactionMessages = await withUnlocked(async () => {
      if (!customTransaction.address || !customTransaction.transactionRequest) {
        throw new Error(`${MidenDAppErrorType.InvalidParams}: Invalid CustomTransaction payload`);
      }

      return await formatCustomTransactionPreview(customTransaction);
    });
  } catch (e) {
    reject(new Error(`${MidenDAppErrorType.InvalidParams}: ${e}`));
    return;
  }

  // On mobile/desktop, use confirmation store to request user approval
  if (!isExtension()) {
    dappDebug('[DApp] Non-extension requesting transaction confirmation');

    // The effects go in front of the user BEFORE the sheet is raised, because
    // this sheet cannot ask for them itself — see `formatSimulatedCustomEffects`.
    const simulatedEffects = await withUnlocked(async () => formatSimulatedCustomEffects(customTransaction));

    const result = await dappConfirmationStore.requestConfirmation({
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
      transactionMessages: [...transactionMessages, ...simulatedEffects],
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
        return await requestCustomTransaction(
          address,
          transactionRequest,
          inputNoteIds,
          importNotes,
          delegateFromConfirmation(result),
          recipientAddress || undefined
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
      reject(new Error(`${MidenDAppErrorType.InvalidParams}: ${e}`));
    }
    return;
  }

  await requestConfirm({
    id,
    payload: buildCustomTxConfirmPayload({
      origin,
      networkRpc,
      appMeta: dApp.appMeta,
      sourcePublicKey: req.sourcePublicKey,
      transactionMessages,
      customTransaction
    }),
    handleSimulate: makeSimulateHandler(id, customTransaction),
    onDecline: () => {
      reject(new Error(MidenDAppErrorType.NotGranted));
    },
    handleIntercomRequest: async (confirmReq, decline) => {
      if (confirmReq?.type === MidenMessageType.DAppTransactionConfirmationRequest && confirmReq?.id === id) {
        if (confirmReq.confirmed) {
          try {
            const transactionId = await withUnlocked(async () => {
              const { payload } = req.transaction;
              const { address, recipientAddress, transactionRequest, inputNoteIds, importNotes } =
                payload as MidenCustomTransaction;
              return await requestCustomTransaction(
                address,
                transactionRequest,
                inputNoteIds,
                importNotes,
                confirmReq.delegate,
                recipientAddress || undefined
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
            reject(new Error(`${MidenDAppErrorType.InvalidParams}: ${e}`));
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

  let transactionMessages: string[] = [];
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
    transactionMessages = await withUnlocked(async () => {
      return await formatSendTransactionPreview(req.transaction);
    });
  } catch (e) {
    reject(new Error(`${MidenDAppErrorType.InvalidParams}: ${e}`));
    return;
  }

  // On mobile/desktop, use confirmation store to request user approval
  if (!isExtension()) {
    dappDebug('[DApp] Non-extension requesting send transaction confirmation');

    const result = await dappConfirmationStore.requestConfirmation({
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
      sourcePublicKey: req.sourcePublicKey
    });

    if (!result.confirmed) {
      reject(new Error(MidenDAppErrorType.NotGranted));
      return;
    }

    try {
      const transactionId = await withUnlocked(async () => {
        const { senderAddress, recipientAddress, faucetId, noteType, amount, recallBlocks } = req.transaction;
        return await initiateSendTransaction(
          senderAddress,
          recipientAddress,
          faucetId,
          noteType as any,
          BigInt(amount),
          recallBlocks,
          delegateFromConfirmation(result)
        );
      });
      startDappBackgroundProcessing();
      resolve({
        type: MidenDAppMessageType.SendTransactionResponse,
        transactionId
      } as any);
    } catch (e) {
      reject(new Error(`${MidenDAppErrorType.InvalidParams}: ${e}`));
    }
    return;
  }

  await requestConfirm({
    id,
    payload: {
      type: 'transaction',
      origin,
      networkRpc,
      appMeta: dApp.appMeta,
      sourcePublicKey: req.sourcePublicKey,
      transactionMessages,
      preview: null
    },
    onDecline: () => {
      reject(new Error(MidenDAppErrorType.NotGranted));
    },
    handleIntercomRequest: async (confirmReq, decline) => {
      if (confirmReq?.type === MidenMessageType.DAppTransactionConfirmationRequest && confirmReq?.id === id) {
        if (confirmReq.confirmed) {
          try {
            const transactionId = await withUnlocked(async () => {
              const { senderAddress, recipientAddress, faucetId, noteType, amount, recallBlocks } = req.transaction;
              return await initiateSendTransaction(
                senderAddress,
                recipientAddress,
                faucetId,
                noteType as any,
                BigInt(amount),
                recallBlocks,
                confirmReq.delegate
              );
            });
            startDappBackgroundProcessing();
            resolve({
              type: MidenDAppMessageType.SendTransactionResponse,
              transactionId
            } as any);
          } catch (e) {
            reject(new Error(`${MidenDAppErrorType.InvalidParams}: ${e}`));
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

  let transactionMessages: string[] = [];
  try {
    transactionMessages = await withUnlocked(async () => {
      return await formatConsumeTransactionPreview(req.transaction);
    });
  } catch (e) {
    reject(new Error(`${MidenDAppErrorType.InvalidParams}: ${e}`));
    return;
  }

  // On mobile/desktop, use confirmation store to request user approval
  if (!isExtension()) {
    dappDebug('[DApp] Non-extension requesting consume transaction confirmation');

    const result = await dappConfirmationStore.requestConfirmation({
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
        const { noteId, noteBytes } = req.transaction;
        if (noteBytes) {
          await queueNoteImport(noteBytes);
        }
        // `manualRetry`: the user just approved THIS consume on the sheet, so it
        // must not be dropped by auto-consume's exponential backoff — which
        // would queue nothing and answer the dApp with the previous attempt's
        // Failed row id.
        return await initiateConsumeTransactionFromId(
          req.sourcePublicKey,
          noteId,
          delegateFromConfirmation(result),
          true
        );
      });
      startDappBackgroundProcessing();
      resolve({
        type: MidenDAppMessageType.ConsumeResponse,
        transactionId
      });
    } catch (e) {
      reject(new Error(`${MidenDAppErrorType.InvalidParams}: ${e}`));
    }
    return;
  }

  await requestConfirm({
    id,
    payload: {
      type: 'consume',
      origin,
      networkRpc,
      appMeta: dApp.appMeta,
      sourcePublicKey: req.sourcePublicKey,
      transactionMessages,
      noteId: req.transaction.noteId
    },
    onDecline: () => {
      reject(new Error(MidenDAppErrorType.NotGranted));
    },
    handleIntercomRequest: async (confirmReq, decline) => {
      if (confirmReq?.type === MidenMessageType.DAppTransactionConfirmationRequest && confirmReq?.id === id) {
        if (confirmReq.confirmed) {
          try {
            const transactionId = await withUnlocked(async () => {
              const { noteId, noteBytes } = req.transaction;
              if (noteBytes) {
                await queueNoteImport(noteBytes);
              }
              // `manualRetry`: approved on the confirm page — see the
              // non-extension branch above for why the backoff must not apply.
              return await initiateConsumeTransactionFromId(req.sourcePublicKey, noteId, confirmReq.delegate, true);
            });
            startDappBackgroundProcessing();
            resolve({
              type: MidenDAppMessageType.ConsumeResponse,
              transactionId
            });
          } catch (e) {
            reject(new Error(`${MidenDAppErrorType.InvalidParams}: ${e}`));
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

export async function waitForTransaction(req: MidenDAppWaitForTxRequest): Promise<MidenDAppWaitForTxResponse> {
  if (!req.txId) {
    throw new Error(MidenDAppErrorType.InvalidParams);
  }
  const res = await waitForTransactionCompletion(req.txId);
  return {
    type: MidenDAppMessageType.WaitForTransactionResponse,
    transactionOutput: res
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
  payload: MidenDAppPayload;
  onDecline: () => void;
  handleIntercomRequest: (req: MidenRequest, decline: () => void) => Promise<any>;
  handleSimulate?: (req: MidenRequest) => Promise<any>;
};

async function requestConfirm({ id, payload, onDecline, handleIntercomRequest, handleSimulate }: RequestConfirmParams) {
  /* c8 ignore start */ if (!isExtension())
    throw new Error('DApp confirmation popup is only available in extension context'); /* c8 ignore stop */

  const browser = await getBrowser();

  let closing = false;
  const close = async () => {
    /* c8 ignore start */ if (closing) return; /* c8 ignore stop */
    closing = true;

    try {
      stopTimeout();
      stopRequestListening();
      stopWinRemovedListening();

      await closeWindow();
    } catch (_err) {}
  };

  const declineAndClose = () => {
    onDecline();
    close();
  };

  let knownPort: Runtime.Port | undefined;
  const stopRequestListening = intercom.onRequest(async (req: MidenRequest, port) => {
    if (req?.type === MidenMessageType.DAppGetPayloadRequest && req.id[0] === id) {
      knownPort = port;

      return {
        type: MidenMessageType.DAppGetPayloadResponse,
        payload
      };
    }

    if (req?.type === MidenMessageType.DAppSimulateTransactionRequest && (req as any).id === id) {
      if (!handleSimulate) {
        return { type: MidenMessageType.DAppSimulateTransactionResponse, error: 'unsupported' };
      }
      return await handleSimulate(req); // must NOT close() — the popup stays open
    }

    if (knownPort !== port) return;

    const result = await handleIntercomRequest(req, onDecline);
    if (result) {
      close();
      return result;
    }
  });

  const isWin = (await browser.runtime.getPlatformInfo()).os === 'win';

  let left = 0;
  let top = 0;
  try {
    const lastFocused = await browser.windows.getLastFocused();
    // Position window in top right corner of lastFocused window.

    top = Math.round(lastFocused.top! + lastFocused.height! / 2 - CONFIRM_WINDOW_HEIGHT / 2);
    left = Math.round(lastFocused.left! + lastFocused.width! / 2 - CONFIRM_WINDOW_WIDTH / 2);
  } catch {
    // The following properties are more than likely 0, due to being
    // opened from the background chrome process for the extension that
    // has no physical dimensions
    const { screenX, screenY, outerWidth, outerHeight } = window;
    top = Math.round(screenY + outerHeight / 2 - CONFIRM_WINDOW_HEIGHT / 2);
    left = Math.round(screenX + outerWidth / 2 - CONFIRM_WINDOW_WIDTH / 2);
  }

  const confirmWin = await browser.windows.create({
    type: 'popup',
    url: browser.runtime.getURL(`confirm.html#?id=${id}`),
    width: isWin ? CONFIRM_WINDOW_WIDTH + 16 : CONFIRM_WINDOW_WIDTH,
    height: isWin ? CONFIRM_WINDOW_HEIGHT + 17 : CONFIRM_WINDOW_HEIGHT,
    top: Math.max(top, 20),
    left: Math.max(left, 20)
  });

  // Firefox currently ignores left/top for create, but it works for update
  if (confirmWin.id && confirmWin.left !== left && confirmWin.state !== 'fullscreen') {
    await browser.windows.update(confirmWin.id, { left, top });
  }

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
      declineAndClose();
    }
  };
  browser.windows.onRemoved.addListener(handleWinRemoved);
  const stopWinRemovedListening = () => browser.windows.onRemoved.removeListener(handleWinRemoved);

  // Decline after timeout
  const t = setTimeout(declineAndClose, AUTODECLINE_AFTER);
  const stopTimeout = () => clearTimeout(t);
}

export async function getNetworkRPC(net: string | undefined) {
  // dApp didn't specify a network — fall back to the wallet's currently
  // selected one. Prevents an immediate connect() failure for dApps that
  // (legitimately) just want to use whatever the user is on.
  if (!net) {
    const current = await getCurrentMidenNetwork();
    if (!current) {
      throw new Error(MidenDAppErrorType.NetworkNotGranted);
    }
    return current.rpcBaseURL;
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
  assets: Asset[];
  noteType: string;
}

/**
 * Decodes dApp-carried note bytes (base64) the SAME way the import path does —
 * they may be a serialized `NoteFile` OR a bare `Note`, and the dApp picks which
 * (see `noteIdFromBytes` in note-quarantine.ts). Returns the note's id alongside
 * its real assets and type, or null when neither format parses.
 */
function decodeConsumeNoteBytes(noteBytesB64: string): (ResolvedConsumeNote & { noteId: string }) | null {
  // Never throws: any unreadable byte string just means "the wallet could not
  // decode this", and the caller falls back to reading the note from the store.
  // Refusing the whole request here would break a legitimate dApp that carries a
  // format this build cannot parse but whose note IS resolvable locally.
  try {
    const bytes = b64ToU8(noteBytesB64);
    let note: Note | undefined;
    try {
      note = NoteFile.deserialize(bytes).note();
    } catch {
      // Not a NoteFile — fall through to a bare Note.
    }
    if (!note) {
      note = Note.deserialize(bytes);
    }
    const metadata = note.metadata();
    return {
      noteId: note.id().toString(),
      noteType: metadata ? toNoteTypeString(metadata.noteType()) : 'unknown',
      assets: note
        .assets()
        .fungibleAssets()
        .map(asset => ({
          amount: asset.amount().toString(),
          faucetId: getBech32AddressFromAccountId(asset.faucetId())
        }))
    };
  } catch {
    return null;
  }
}

/**
 * Ground truth for a consume request: what the note the wallet will consume
 * actually holds.
 *
 * Execution uses ONLY `transaction.noteId` — `initiateConsumeTransactionFromId`
 * loads the note from the store and explicitly blanks the request's declared
 * `faucetId`/`amount`/`senderAddress` (transaction/initiate.ts). So the
 * dApp-declared faucet, amount and note type provably cannot influence the
 * transaction, and rendering them on the approval screen shows the user numbers
 * with no causal relationship to what they are authorizing (e.g. "+500 USDC" over
 * an attacker's asset-less note). Resolve the note instead — from the carried
 * bytes when they are supplied (rejecting bytes whose id is not the id that will
 * be consumed), else from the local store — and refuse the request when it cannot
 * be resolved at all, rather than prompting with unverifiable numbers.
 */
async function resolveConsumeNote(transaction: MidenConsumeTransaction): Promise<ResolvedConsumeNote> {
  if (transaction.noteBytes) {
    const decoded = decodeConsumeNoteBytes(transaction.noteBytes);
    if (decoded) {
      if (decoded.noteId !== transaction.noteId) {
        throw new Error('noteBytes describe a different note than noteId — refusing to preview it');
      }
      return { assets: decoded.assets, noteType: decoded.noteType };
    }
  }

  const [details] = await withWasmClientLock(async () =>
    midenClientProxy.getInputNoteDetails({ ids: [transaction.noteId] })
  );
  if (!details) {
    throw new Error(`Note ${transaction.noteId} could not be resolved — refusing to preview it`);
  }
  return {
    assets: details.assets,
    noteType: details.noteType !== undefined ? toNoteTypeString(details.noteType) : 'unknown'
  };
}

async function formatConsumeTransactionPreview(transaction: MidenConsumeTransaction): Promise<string[]> {
  const { assets, noteType } = await resolveConsumeNote(transaction);
  const headlineFaucet = assets[0]?.faucetId;
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
  messages.push(`Note Type, ${capitalizeFirstLetter(noteType)}`);
  return messages;
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
  if (rows.length === 0) {
    rows.push('Assets, no fungible asset moves');
  }
  rows.push(`Notes, ${view.inputNotesConsumed} consumed / ${view.outputNotesCreated} created`);
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
 * `declaredRequestToView` is an offline decode of the request the wallet will
 * execute — no dry run, so it is labelled unverified, exactly as the extension
 * labels its declared view. `recipientAddress` stays dApp-declared and is
 * labelled as such: it is not derived from the request bytes and nothing
 * downstream checks it.
 */
async function formatCustomTransactionPreview(payload: MidenCustomTransaction): Promise<string[]> {
  const messages = [
    'This dApp is requesting a custom transaction,',
    'please ensure you know the details of the transaction before proceeding.',
    // Executing account first, for the same reason as the send preview.
    `From, ${truncateAddress(payload.address)}`
  ];

  let declared: TxAssetView | undefined;
  try {
    declared = declaredRequestToView(payload.transactionRequest, payload.importNotes ?? []);
  } catch (e) {
    console.error('[DApp] Could not decode the custom transaction request for the approval sheet:', e);
  }

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
async function formatSimulatedCustomEffects(payload: MidenCustomTransaction): Promise<string[]> {
  try {
    const { summaryBytes, error } = await simulateCustomTransaction({
      address: payload.address,
      transactionRequest: payload.transactionRequest,
      importNotes: payload.importNotes
    });
    if (!summaryBytes) throw new Error(error ?? 'no summary was produced');

    const view = summaryBytesToView(summaryBytes);
    const movement = async (asset: AssetAmount, direction: 'send' | 'consume') => {
      const metadata = await getTokenMetadata(asset.faucetId);
      const amount = formatAmountSafe(asset.amount, direction, metadata?.decimals, hasKnownScale(metadata));
      return `${direction === 'send' ? 'Leaves this account' : 'Enters this account'}, ${amount} ${
        metadata?.symbol ?? ''
      }`.trimEnd();
    };

    const effects = [
      ...(await Promise.all(view.outgoing.map(asset => movement(asset, 'send')))),
      ...(await Promise.all(view.incoming.map(asset => movement(asset, 'consume'))))
    ];
    if (effects.length === 0) {
      effects.push('No assets move');
    }
    effects.push(`Notes consumed, ${view.inputNotesConsumed}`, `Notes created, ${view.outputNotesCreated}`);
    if (view.storageChanged) {
      effects.push('Changes this account’s stored data');
    }

    return ['Simulated effects:', ...effects];
  } catch (e: any) {
    console.error('Failed to simulate a custom transaction for approval', e);
    return [
      'This transaction could not be simulated, so its effects are unknown.',
      `Reason, ${e?.message ?? String(e)}`
    ];
  }
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
