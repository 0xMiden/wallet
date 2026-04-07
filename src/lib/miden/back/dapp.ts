import {
  AllowedPrivateData,
  Asset,
  InputNoteDetails,
  MidenConsumeTransaction,
  MidenCustomTransaction,
  PrivateDataPermission,
  SendTransaction
} from '@demox-labs/miden-wallet-adapter-base';
import { AccountInterface, NetworkId, NoteFilter, NoteFilterTypes, NoteId, NoteType } from '@miden-sdk/miden-sdk';
import { nanoid } from 'nanoid';
import type { Runtime } from 'webextension-polyfill';

import {
  MidenDAppDisconnectRequest,
  MidenDAppDisconnectResponse,
  MidenDAppErrorType,
  MidenDAppGetCurrentPermissionResponse,
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
import { MIDEN_METADATA } from 'lib/miden/metadata';
import { getTokenMetadata } from 'lib/miden/metadata/utils';
import { NETWORKS } from 'lib/miden/networks';
import {
  DappMetadata,
  MidenDAppPayload,
  MidenDAppSession,
  MidenDAppSessions,
  MidenMessageType,
  MidenRequest
} from 'lib/miden/types';
import { isDesktop, isExtension } from 'lib/platform';
import { getStorageProvider } from 'lib/platform/storage-adapter';
import { b64ToU8, u8ToB64 } from 'lib/shared/helpers';
import { WalletStatus } from 'lib/shared/types';
import { capitalizeFirstLetter, truncateAddress } from 'utils/string';

import { queueNoteImport } from '../activity';
import {
  initiateSendTransaction,
  requestCustomTransaction,
  initiateConsumeTransactionFromId,
  waitForTransactionCompletion
} from '../activity/transactions';
import { getBech32AddressFromAccountId } from '../sdk/helpers';
import { getMidenClient, withWasmClientLock } from '../sdk/miden-client';
import { store, withUnlocked } from './store';
import { startTransactionProcessing } from './transaction-processor';

/** Starts background transaction processing using the unified SW transaction processor. */
function startDappBackgroundProcessing() {
  startTransactionProcessing().catch(err => console.error('[DApp] Transaction processing error:', err));
}

// Log to Rust stdout for desktop debugging
async function dappLog(message: string): Promise<void> {
  if (isDesktop()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      invoke('js_log', { message }).catch(() => {});
    } catch {
      // Not in Tauri context
    }
  }
}

async function getAccountPublicKeyB64(accountId: string): Promise<string> {
  const midenClient = await getMidenClient();
  const account = await midenClient.getAccount(accountId);
  if (!account) {
    throw new Error('Account not found');
  }
  const publicKeyCommitments = account.getPublicKeyCommitments();
  if (publicKeyCommitments.length === 0) {
    throw new Error('Account has no public key commitments');
  }
  return u8ToB64(publicKeyCommitments[0].serialize());
}

// Lazy-loaded browser polyfill (only in extension context)
type Browser = import('webextension-polyfill').Browser;
let browserInstance: Browser | null = null;
async function getBrowser(): Promise<Browser> {
  if (!isExtension()) {
    throw new Error('Browser extension APIs only available in extension context');
  }
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
    const dApp = currentAccountPubKey ? await getDApp(origin, currentAccountPubKey) : undefined;
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
  console.log('[requestPermission] Called with origin:', origin);
  console.log('[requestPermission] Request:', JSON.stringify(req));
  console.log('[requestPermission] isExtension():', isExtension());
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
  console.log('[generatePromisifyRequestPermission] Called, isExtension:', isExtension());
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

    console.log('[DApp] Non-extension approved connection for:', origin);
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
            let publicKey = null;
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
            if (!existingPermission)
              await setDApp(origin, {
                network,
                appMeta,
                accountId: accountPublicKey,
                privateDataPermission: privateDataPermission || PrivateDataPermission.UponRequest,
                allowedPrivateData: allowedPrivateData || AllowedPrivateData.None,
                publicKey: publicKey!
              });
            resolve({
              type: MidenDAppMessageType.PermissionResponse,
              accountId: accountPublicKey,
              network,
              privateDataPermission: privateDataPermission || PrivateDataPermission.UponRequest,
              allowedPrivateData: allowedPrivateData || AllowedPrivateData.None,
              publicKey: publicKey!
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

  if (req.sourceAccountId !== dApp.accountId) {
    throw new Error(MidenDAppErrorType.NotFound);
  }

  return new Promise((resolve, reject) => generatePromisifySign(resolve, reject, dApp, req));
}

const generatePromisifySign = async (
  resolve: (value: MidenDAppSignResponse | PromiseLike<MidenDAppSignResponse>) => void,
  reject: (reason?: any) => void,
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
          try {
            let signature = await withUnlocked(async ({ vault }) => {
              const signDataResult = await vault.signData(req.sourcePublicKey, req.payload, req.kind);
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

  if (req.sourcePublicKey !== dApp.accountId) {
    throw new Error(MidenDAppErrorType.NotFound);
  }

  return new Promise((resolve, reject) => generatePromisifyRequestPrivateNotes(resolve, reject, dApp, req));
}

const generatePromisifyRequestPrivateNotes = async (
  resolve: (value: MidenDAppPrivateNotesResponse | PromiseLike<MidenDAppPrivateNotesResponse>) => void,
  reject: (reason?: any) => void,
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

async function getPrivateNoteDetails(notefilterType: NoteFilterTypes, noteIds?: string[]): Promise<InputNoteDetails[]> {
  let privateNotes: InputNoteDetails[] = [];
  try {
    privateNotes = await withUnlocked(async () => {
      // Wrap WASM client operations in a lock to prevent concurrent access
      return await withWasmClientLock(async () => {
        const midenClient = await getMidenClient();
        const midenNoteIds = noteIds ? noteIds.map(id => NoteId.fromHex(id)) : undefined;
        const noteFilter = new NoteFilter(notefilterType, midenNoteIds);
        let allNotes = await midenClient.getInputNoteDetails(noteFilter);
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

  if (req.sourcePublicKey !== dApp.accountId) {
    throw new Error(MidenDAppErrorType.NotFound);
  }

  return new Promise((resolve, reject) => generatePromisifyRequestConsumableNotes(resolve, reject, dApp, req));
}

export const generatePromisifyRequestConsumableNotes = async (
  resolve: (value: MidenDAppConsumableNotesResponse | PromiseLike<MidenDAppConsumableNotesResponse>) => void,
  reject: (reason?: any) => void,
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
        const midenClient = await getMidenClient();
        await midenClient.syncState();
        const consumableNotes = await midenClient.getConsumableNotes(accountId);
        const consumableNotesDetails = consumableNotes.map(note => {
          const assets = note
            .inputNoteRecord()
            .details()
            .assets()
            .fungibleAssets()
            .map(asset => ({
              amount: asset.amount().toString(),
              faucetId: asset.faucetId().toBech32(NetworkId.testnet(), AccountInterface.BasicWallet)
            }));
          const inputNoteRecord = note.inputNoteRecord();
          return {
            noteId: inputNoteRecord.id().toString(),
            noteType: inputNoteRecord.metadata()?.noteType(),
            senderAccountId:
              inputNoteRecord.metadata()?.sender()?.toBech32(NetworkId.testnet(), AccountInterface.BasicWallet) ||
              undefined,
            nullifier: inputNoteRecord.nullifier(),
            state: inputNoteRecord.state(),
            assets: assets
          };
        });
        return consumableNotesDetails;
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

  if (req.sourcePublicKey !== dApp.accountId) {
    throw new Error(MidenDAppErrorType.NotFound);
  }

  return new Promise((resolve, reject) => generatePromisifyRequestAssets(resolve, reject, dApp, req));
}

export const generatePromisifyRequestAssets = async (
  resolve: (value: MidenDAppAssetsResponse | PromiseLike<MidenDAppAssetsResponse>) => void,
  reject: (reason?: any) => void,
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
        const midenClient = await getMidenClient();
        const account = await midenClient.getAccount(accountId);
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

  if (req.sourcePublicKey !== dApp.accountId) {
    throw new Error(MidenDAppErrorType.NotFound);
  }

  return new Promise((resolve, reject) => generatePromisifyImportPrivateNote(resolve, reject, dApp, req));
}

export const generatePromisifyImportPrivateNote = async (
  resolve: (value: MidenDAppImportPrivateNoteResponse | PromiseLike<MidenDAppImportPrivateNoteResponse>) => void,
  reject: (reason?: any) => void,
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
              // Wrap WASM client operations in a lock to prevent concurrent access
              return await withWasmClientLock(async () => {
                const midenClient = await getMidenClient();
                const noteAsUint8Array = b64ToU8(req.note);
                const noteId = await midenClient.importNoteBytes(noteAsUint8Array);
                await midenClient.syncState();
                return noteId;
              });
            });
            resolve({
              type: MidenDAppMessageType.ImportPrivateNoteResponse,
              noteId: noteId.toString()
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
  console.log(req, 'requestTransaction, dapp.ts');
  if (!req?.sourcePublicKey || !req?.transaction) {
    throw new Error(MidenDAppErrorType.InvalidParams);
  }

  const dApp = await getDApp(origin, req.sourcePublicKey);

  if (!dApp) {
    throw new Error(MidenDAppErrorType.NotGranted);
  }

  if (req.sourcePublicKey !== dApp.accountId) {
    throw new Error(MidenDAppErrorType.NotFound);
  }

  return new Promise((resolve, reject) => generatePromisifyTransaction(resolve, reject, dApp, req, sessionId));
}

const generatePromisifyTransaction = async (
  resolve: (value: MidenDAppTransactionResponse | PromiseLike<MidenDAppTransactionResponse>) => void,
  reject: (reason?: any) => void,
  dApp: MidenDAppSession,
  req: MidenDAppTransactionRequest,
  sessionId?: string
) => {
  const id = nanoid();
  const networkRpc = await getNetworkRPC(dApp.network);

  let transactionMessages: string[] = [];
  try {
    transactionMessages = await withUnlocked(async () => {
      const { payload } = req.transaction;
      const customTransaction = payload as MidenCustomTransaction;
      if (!customTransaction.address || !customTransaction.transactionRequest) {
        reject(new Error(`${MidenDAppErrorType.InvalidParams}: Invalid CustomTransaction payload`));
      }

      return formatCustomTransactionPreview(customTransaction);
    });
  } catch (e) {
    reject(new Error(`${MidenDAppErrorType.InvalidParams}: ${e}`));
  }

  // On mobile/desktop, use confirmation store to request user approval
  if (!isExtension()) {
    console.log('[DApp] Non-extension requesting transaction confirmation');

    const result = await dappConfirmationStore.requestConfirmation({
      id,
      sessionId,
      type: 'transaction',
      origin: dApp.appMeta.name,
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

  if (req.sourcePublicKey !== dApp.accountId) {
    throw new Error(MidenDAppErrorType.NotFound);
  }

  return new Promise((resolve, reject) => generatePromisifySendTransaction(resolve, reject, dApp, req, sessionId));
}

const generatePromisifySendTransaction = async (
  resolve: (value: MidenDAppSendTransactionResponse | PromiseLike<MidenDAppSendTransactionResponse>) => void,
  reject: (reason?: any) => void,
  dApp: MidenDAppSession,
  req: MidenDAppSendTransactionRequest,
  sessionId?: string
) => {
  const id = nanoid();
  const networkRpc = await getNetworkRPC(dApp.network);

  let transactionMessages: string[] = [];
  try {
    transactionMessages = await withUnlocked(async () => {
      return formatSendTransactionPreview(req.transaction);
    });
  } catch (e) {
    reject(new Error(`${MidenDAppErrorType.InvalidParams}: ${e}`));
  }

  // On mobile/desktop, use confirmation store to request user approval
  if (!isExtension()) {
    console.log('[DApp] Non-extension requesting send transaction confirmation');

    const result = await dappConfirmationStore.requestConfirmation({
      id,
      sessionId,
      type: 'transaction',
      origin: dApp.appMeta.name,
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

  if (req.sourcePublicKey !== dApp.accountId) {
    throw new Error(MidenDAppErrorType.NotFound);
  }

  return new Promise((resolve, reject) => generatePromisifyConsumeTransaction(resolve, reject, dApp, req, sessionId));
}

const generatePromisifyConsumeTransaction = async (
  resolve: (value: MidenDAppConsumeResponse | PromiseLike<MidenDAppConsumeResponse>) => void,
  reject: (reason?: any) => void,
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
  }

  // On mobile/desktop, use confirmation store to request user approval
  if (!isExtension()) {
    console.log('[DApp] Non-extension requesting consume transaction confirmation');

    const result = await dappConfirmationStore.requestConfirmation({
      id,
      sessionId,
      type: 'consume',
      origin: dApp.appMeta.name,
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
  const newPermissions = permissionsToRemove.filter(session => session.accountId !== accountId);
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
};

async function requestConfirm({ id, payload, onDecline, handleIntercomRequest }: RequestConfirmParams) {
  // DApp confirmation windows only available in extension context
  if (!isExtension()) {
    throw new Error('DApp confirmation popup is only available in extension context');
  }

  const browser = await getBrowser();

  let closing = false;
  const close = async () => {
    if (closing) return;
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
    } else {
      if (knownPort !== port) return;

      const result = await handleIntercomRequest(req, onDecline);
      if (result) {
        close();
        return result;
      }
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

export async function getNetworkRPC(net: string) {
  const targetRpc = NETWORKS.find(n => n.id === net)!.rpcBaseURL;
  return targetRpc;

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

function formatSendTransactionPreview(transaction: SendTransaction): string[] {
  const tsTexts = [
    'Transfer note from faucet:',
    transaction.faucetId,
    `Amount, ${transaction.amount}`,
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
  if (transactionType === 'send') {
    return `-${normalizedAmount}`;
  } else if (transactionType === 'consume') {
    return `+${normalizedAmount}`;
  }
  return normalizedAmount;
}
