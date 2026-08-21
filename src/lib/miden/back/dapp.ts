import {
  AllowedPrivateData,
  Asset,
  InputNoteDetails,
  MidenConsumeTransaction,
  MidenCustomTransaction,
  PrivateDataPermission,
  SendTransaction
} from '@demox-labs/miden-wallet-adapter-base';
import { NoteFilterTypes, NoteType, type NoteQuery } from '@miden-sdk/miden-sdk/lazy';
import { nanoid } from 'nanoid';
import type { Runtime } from 'webextension-polyfill';

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
import { dappConfirmationStore } from 'lib/dapp-browser/confirmation-store';
import { formatBigInt } from 'lib/i18n/numbers';
import { intercom } from 'lib/miden/back/defaults';
import { Vault } from 'lib/miden/back/vault';
import { guardianProviderFromEndpoint, resolveGuardianEndpoint } from 'lib/miden/guardian/account';
import { MIDEN_METADATA } from 'lib/miden/metadata';
import { getTokenMetadata } from 'lib/miden/metadata/utils';
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
import { b64ToU8, u8ToB64 } from 'lib/shared/helpers';
import { GuardianInfo, WalletStatus } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';
import { capitalizeFirstLetter, truncateAddress } from 'utils/string';

import { queueNoteImport } from '../activity';
import { midenClientProxy } from './miden-client-proxy';
import { getCurrentMidenNetwork } from './safe-network';
import { simulateCustomTransaction } from './simulate-custom-tx';
import { store, withUnlocked } from './store';
import { startTransactionProcessing } from './transaction-processor';
import { isLikelyNetworkError } from '../activity/connectivity-classify';
import { assertValidRecallBlocks, toPersistedNoteType } from '../helpers';
import { getBech32AddressFromAccountId, sameWalletAccountId } from '../sdk/helpers';
import { withWasmClientLock } from '../sdk/miden-client';
import { resolvePublicKeyCommitments } from '../sdk/resolve-public-key-commitments';
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

export async function requestSign(origin: string, req: MidenDAppSignRequest): Promise<MidenDAppSignResponse> {
  if (!req?.sourcePublicKey) {
    throw new Error(MidenDAppErrorType.InvalidParams);
  }

  const dApp = await getDApp(origin, req.sourceAccountId);
  if (!dApp) {
    throw new Error(MidenDAppErrorType.NotGranted);
  }

  return new Promise((resolve, reject) => generatePromisifySign(resolve, reject, origin, dApp, req));
}

const generatePromisifySign = async (
  resolve: (value: MidenDAppSignResponse | PromiseLike<MidenDAppSignResponse>) => void,
  reject: (reason?: any) => void,
  origin: string,
  dApp: MidenDAppSession,
  req: MidenDAppSignRequest
) => {
  const id = nanoid();
  const networkRpc = await getNetworkRPC(dApp.network);

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
          ).catch(() => false);
          if (!authorized) {
            reject(new Error(MidenDAppErrorType.NotGranted));
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
  req: MidenDAppPrivateNotesRequest
): Promise<MidenDAppPrivateNotesResponse> {
  if (!req?.sourcePublicKey) {
    throw new Error(MidenDAppErrorType.InvalidParams);
  }

  const dApp = await getDApp(origin, req.sourcePublicKey);
  if (!dApp) {
    throw new Error(MidenDAppErrorType.NotGranted);
  }

  return new Promise((resolve, reject) => generatePromisifyRequestPrivateNotes(resolve, reject, origin, dApp, req));
}

const generatePromisifyRequestPrivateNotes = async (
  resolve: (value: MidenDAppPrivateNotesResponse | PromiseLike<MidenDAppPrivateNotesResponse>) => void,
  reject: (reason?: any) => void,
  origin: string,
  dApp: MidenDAppSession,
  req: MidenDAppPrivateNotesRequest
) => {
  let privateNotes: InputNoteDetails[] = [];
  if (
    dApp.privateDataPermission === PrivateDataPermission.Auto &&
    (dApp.allowedPrivateData & AllowedPrivateData.Notes) !== 0
  ) {
    try {
      privateNotes = await getPrivateNoteDetails(req.notefilterType, req.noteIds);
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
      privateNotes = await getPrivateNoteDetails(req.notefilterType, req.noteIds);
    } catch (e) {
      reject(e);
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

async function getPrivateNoteDetails(notefilterType: NoteFilterTypes, noteIds?: string[]): Promise<InputNoteDetails[]> {
  let privateNotes: InputNoteDetails[] = [];
  try {
    privateNotes = await withUnlocked(async () => {
      return await withWasmClientLock(async () => {
        const query = noteFilterTypeToQuery(notefilterType, noteIds);
        let allNotes = await midenClientProxy.getInputNoteDetails(query);
        let privateNotes = allNotes.filter(note => note.noteType === NoteType.Private);
        return privateNotes;
      });
    });
    return privateNotes;
  } catch (e) {
    throw new Error(`${MidenDAppErrorType.InvalidParams}: ${e}`);
  }
}

export async function requestConsumableNotes(
  origin: string,
  req: MidenDAppConsumableNotesRequest
): Promise<MidenDAppConsumableNotesResponse> {
  if (!req?.sourcePublicKey) {
    throw new Error(MidenDAppErrorType.InvalidParams);
  }

  const dApp = await getDApp(origin, req.sourcePublicKey);
  if (!dApp) {
    throw new Error(MidenDAppErrorType.NotGranted);
  }

  return new Promise((resolve, reject) => generatePromisifyRequestConsumableNotes(resolve, reject, origin, dApp, req));
}

export const generatePromisifyRequestConsumableNotes = async (
  resolve: (value: MidenDAppConsumableNotesResponse | PromiseLike<MidenDAppConsumableNotesResponse>) => void,
  reject: (reason?: any) => void,
  origin: string,
  dApp: MidenDAppSession,
  req: MidenDAppConsumableNotesRequest
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
    throw new Error(`${MidenDAppErrorType.InvalidParams}: ${e}`);
  }
}

export async function requestAssets(origin: string, req: MidenDAppAssetsRequest): Promise<MidenDAppAssetsResponse> {
  if (!req?.sourcePublicKey) {
    throw new Error(MidenDAppErrorType.InvalidParams);
  }

  const dApp = await getDApp(origin, req.sourcePublicKey);
  if (!dApp) {
    throw new Error(MidenDAppErrorType.NotGranted);
  }

  return new Promise((resolve, reject) => generatePromisifyRequestAssets(resolve, reject, origin, dApp, req));
}

export const generatePromisifyRequestAssets = async (
  resolve: (value: MidenDAppAssetsResponse | PromiseLike<MidenDAppAssetsResponse>) => void,
  reject: (reason?: any) => void,
  origin: string,
  dApp: MidenDAppSession,
  req: MidenDAppAssetsRequest
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
  req: MidenDAppImportPrivateNoteRequest
): Promise<MidenDAppImportPrivateNoteResponse> {
  if (!req?.sourcePublicKey || !req?.note) {
    throw new Error(MidenDAppErrorType.InvalidParams);
  }

  const dApp = await getDApp(origin, req.sourcePublicKey);
  if (!dApp) {
    throw new Error(MidenDAppErrorType.NotGranted);
  }

  return new Promise((resolve, reject) => generatePromisifyImportPrivateNote(resolve, reject, origin, dApp, req));
}

export const generatePromisifyImportPrivateNote = async (
  resolve: (value: MidenDAppImportPrivateNoteResponse | PromiseLike<MidenDAppImportPrivateNoteResponse>) => void,
  reject: (reason?: any) => void,
  origin: string,
  dApp: MidenDAppSession,
  req: MidenDAppImportPrivateNoteRequest
) => {
  const id = nanoid();
  const networkRpc = await getNetworkRPC(dApp.network);

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
            let noteId = await withUnlocked(async () => {
              // Wrap WASM client operations in a lock to prevent concurrent access.
              // Route through the offscreen proxy (issue #260, slice 7c): this is a
              // STORE WRITE (a claimable private note imported by a dApp flow). Flag-ON
              // the note MUST land in the OFFSCREEN client's store — the realm that
              // syncs and consumes — else it would import into the dormant SW store and
              // be unclaimable. Flag-OFF each proxy method is byte-identical to the
              // former inline `getMidenClient().importNoteBytes()` / `.syncState()`
              // (verbatim getMidenClient path under this caller's lock).
              return await withWasmClientLock(async () => {
                const noteAsUint8Array = b64ToU8(req.note);
                const noteId = await midenClientProxy.importNoteBytes(noteAsUint8Array);
                await midenClientProxy.syncState();
                return noteId;
              });
            });
            resolve({
              type: MidenDAppMessageType.ImportPrivateNoteResponse,
              // Hex string: the note ID for metadata-bearing files, or the
              // details commitment for details-only imports (the common
              // dApp `noteBytes` path).
              noteId
            });
          } catch (e) {
            // Don't lose the note on a transient blip (resilience gap 1): a
            // private note's bytes can be its only copy. Queue it for the
            // background import loop (wall-clock retry + backoff, dead-letter on
            // give-up) before surfacing the error. Only transient failures are
            // re-queued — a genuinely malformed note would just dead-letter.
            if (isLikelyNetworkError(e)) {
              await queueNoteImport(req.note).catch(() => {});
            }
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

  return new Promise((resolve, reject) => generatePromisifyTransaction(resolve, reject, origin, dApp, req, sessionId));
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
    const { summaryBytes, error } = await simulateCustomTransaction({
      address: tx.address,
      transactionRequest: tx.transactionRequest,
      importNotes: tx.importNotes
    });
    return { type: MidenMessageType.DAppSimulateTransactionResponse, summaryBytes, error };
  };
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

  // Authorization for the custom path, and it belongs here — above the preview,
  // the simulate handler and both confirm branches — because every one of those
  // reads the same `payload.address` and there is no later point all of them
  // pass through.
  //
  // A session authorizes exactly one account, but the account this executes
  // against is `payload.address`, taken from the request. `requestCustomTransaction`
  // stores it verbatim as the row's `accountId` and the transaction loop signs
  // for whatever it finds there, so without this a page connected to A names B
  // and spends from B. This is the broadest of the dApp entrypoints — the
  // request is an opaque base64 `TransactionRequest`, so it can do anything the
  // account can, and the approval sheet renders that blob's own description
  // without naming the account being debited. Nothing on screen gives it away.
  const customAddress = (req.transaction.payload as MidenCustomTransaction | undefined)?.address;
  if (typeof customAddress !== 'string' || customAddress === '') {
    // Before the comparison, which would otherwise hand the page a raw
    // TypeError instead of the documented error.
    reject(new Error(`${MidenDAppErrorType.InvalidParams}: Invalid CustomTransaction payload`));
    return;
  }
  if (!sameWalletAccountId(customAddress, dApp.accountId)) {
    reject(new Error(MidenDAppErrorType.NotGranted));
    return;
  }

  const id = nanoid();
  const networkRpc = await getNetworkRPC(dApp.network);

  let transactionMessages: string[] = [];
  try {
    transactionMessages = await withUnlocked(async () => {
      const { payload } = req.transaction;
      const customTransaction = payload as MidenCustomTransaction;
      if (!customTransaction.address || !customTransaction.transactionRequest) {
        throw new Error(`${MidenDAppErrorType.InvalidParams}: Invalid CustomTransaction payload`);
      }

      return formatCustomTransactionPreview(customTransaction);
    });
  } catch (e) {
    reject(new Error(`${MidenDAppErrorType.InvalidParams}: ${e}`));
    return;
  }

  // On mobile/desktop, use confirmation store to request user approval
  if (!isExtension()) {
    dappDebug('[DApp] Non-extension requesting transaction confirmation');

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
        const { payload } = req.transaction;
        const { address, recipientAddress, transactionRequest, inputNoteIds, importNotes } =
          payload as MidenCustomTransaction;
        // On mobile/desktop, always delegate transactions to avoid memory issues with local proving
        return await requestCustomTransaction(
          address,
          transactionRequest,
          inputNoteIds,
          importNotes,
          true,
          recipientAddress || undefined
        );
      });
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

  const customTransaction = req.transaction.payload as MidenCustomTransaction;

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

  // A session authorizes exactly ONE account — `getDApp` selects it by the
  // public key the page connected with — but `senderAddress` rides in the
  // request body, and until now nothing tied the two together. A page granted
  // access to account A could name account B as the sender and debit it, and
  // the approval sheet renders amount, recipient, faucet and note type but not
  // the sender, so the swap was invisible at the one point the user could have
  // caught it. Compare through the canonicalizing comparator rather than `===`:
  // the wallet hands the dApp `dApp.accountId` as its address at connect time,
  // and the same account can legitimately come back in composite, bech32, or
  // hex form.
  return new Promise((resolve, reject) =>
    generatePromisifySendTransaction(resolve, reject, origin, dApp, req, sessionId)
  );
}

const generatePromisifySendTransaction = async (
  resolve: (value: MidenDAppSendTransactionResponse | PromiseLike<MidenDAppSendTransactionResponse>) => void,
  reject: (reason?: any) => void,
  origin: string,
  dApp: MidenDAppSession,
  req: MidenDAppSendTransactionRequest,
  sessionId?: string
) => {
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
        // On mobile/desktop, always delegate transactions to avoid memory issues with local proving
        return await initiateSendTransaction(
          senderAddress,
          recipientAddress,
          faucetId,
          noteType as any,
          BigInt(amount),
          recallBlocks,
          true
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

  return new Promise((resolve, reject) =>
    generatePromisifyConsumeTransaction(resolve, reject, origin, dApp, req, sessionId)
  );
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
        // On mobile/desktop, always delegate transactions to avoid memory issues with local proving
        return await initiateConsumeTransactionFromId(req.sourcePublicKey, noteId, true);
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
              return await initiateConsumeTransactionFromId(req.sourcePublicKey, noteId, confirmReq.delegate);
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
  const amount = formatAmountSafe(BigInt(transaction.amount), 'send', tokenMetadata?.decimals);
  // `noteType` was normalized to the persisted 'public'/'private' string by the
  // caller, which also rejected a missing or unrecognized one — so the label
  // below states what will actually be built rather than echoing whatever the
  // page sent. This text is the user's consent surface, and it used to be able
  // to read "Note Type, undefined" for a send that then went out public.
  const tsTexts = [
    'Transfer note from faucet:',
    transaction.faucetId,
    `Amount, ${amount}`,
    `Recipient, ${transaction.recipientAddress}`,
    `Note Type, ${capitalizeFirstLetter(transaction.noteType)}`
  ];

  if (transaction.recallBlocks) {
    tsTexts.push(`Recall Blocks, ${transaction.recallBlocks}`);
  }

  return tsTexts;
}

async function formatConsumeTransactionPreview(transaction: MidenConsumeTransaction): Promise<string[]> {
  const faucetId = transaction.faucetId;
  const tokenMetadata = await getTokenMetadata(faucetId);
  const amount = formatAmountSafe(BigInt(transaction.amount), 'consume', tokenMetadata?.decimals);
  return [
    `Consuming note from faucet: ${truncateAddress(transaction.faucetId, false)}`,
    `Amount, ${amount}`,
    `Note Type, ${capitalizeFirstLetter(transaction.noteType)}`
  ];
}

function formatCustomTransactionPreview(payload: MidenCustomTransaction): string[] {
  return [
    'This dApp is requesting a custom transaction,',
    'please ensure you know the details of the transaction before proceeding.',
    `Recipient, ${truncateAddress(payload.recipientAddress)}`
  ];
}

// Background-safe helpers (duplicated from UI without UI deps)
function formatAmountSafe(amount: bigint, transactionType: 'send' | 'consume', tokenDecimals: number | undefined) {
  const normalizedAmount = formatBigInt(amount, tokenDecimals ?? MIDEN_METADATA.decimals);
  if (transactionType === 'consume') {
    return `+${normalizedAmount}`;
  }
  return transactionType === 'send' ? `-${normalizedAmount}` : normalizedAmount;
}
