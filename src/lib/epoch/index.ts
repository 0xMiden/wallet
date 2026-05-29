export { EPOCH_ALLOCATOR_URL, MIDEN_DESTINATION_CHAIN_ID } from './config';
export { MIDEN_MIN_RECLAIM_BLOCKS, getCurrentMidenBlock } from './chain';
export { buildEpochWalletClient } from './client';
export { createBridgeP2IDNote } from './miden-note';
export type { BridgeNoteDeps } from './miden-note';
export { getEpochSdk, resetEpochSdk, useEpochSdk } from './sdk';
export { useEpochStore } from './store';
export type { EpochFlow, EpochStatus } from './store';
export {
  buildEpochTaskDataParams,
  buildEVMToMidenTaskDataParams,
  buildCrossChainIntent,
  buildEVMToMidenIntent,
  formatQuoteTokenIn,
  getCrossChainQuote,
  getEVMToMidenQuote,
  normalizeMidenIdToHex
} from './bridge';
export type { CrossChainQuote, EVMToMidenQuote } from './bridge';
export type {
  CrossChainIntentParams,
  EVMToMidenIntentParams,
  IntentResult,
  MidenAccount,
  MidenFaucetInfo,
  VaultAsset
} from './types';
