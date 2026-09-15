import type { CompactResponse } from '@epoch-protocol/epoch-intents-sdk';

export interface MidenAccount {
  id: string;
  label: string;
  type: 'wallet' | 'faucet';
}

export interface MidenFaucetInfo extends MidenAccount {
  type: 'faucet';
  symbol: string;
  maxSupply: string;
}

export interface VaultAsset {
  faucetId: string;
  amount: string;
}

export interface CrossChainIntentParams {
  midenAccountId: string;
  midenFaucetId: string;
  /**
   * Miden input amount in base units (matches `minTokenOut` convention).
   * Omit / pass "0" to use reverse-quote route.
   */
  midenAmount?: string;
  /**
   * REQUIRED. Absolute Miden block number at which the P2IDE note becomes
   * reclaimable. Must be `currentMidenBlock + delta` (delta ≥ MIDEN_MIN_RECLAIM_BLOCKS,
   * default 1000). Passing a stale block fails the intent because the note
   * is already reclaimable at creation time.
   */
  midenReclaimHeight: number;
  evmRecipient: string;
  destinationChainId: number;
  outputTokenAddress: string;
  outputTokenDecimals?: number;
  minTokenOut: string;
}

export interface EVMToMidenIntentParams {
  /** EVM chain where `evmTokenAddress` is deployed (align with wallet; mirrors deposit tab chain id). */
  sourceChainId: number;
  /**
   * Intent output chain: must be `MIDEN_DESTINATION_CHAIN_ID` (currently `999999999`) for Miden credit in this stack.
   * Maps to mandate `destinationChainId` in task data (SIO `tokenOut.chainId`); not the EVM `sourceChainId`.
   */
  destinationChainId: number;
  evmSourceAddress: string;
  evmTokenAddress: string;
  evmTokenDecimals?: number;
  midenRecipientId: string;
  midenFaucetId: string;
  /**
   * Miden-side output to receive, in faucet base units. EVM→Miden is reverse-quoted:
   * task data pairs this with `tokenInAmount: "0"` and SIO derives the EVM `tokenIn`.
   */
  minTokenOut: string;
}

export interface IntentResult {
  taskTypeString: string;
  intentData: Record<string, unknown>;
  solveResult?: {
    resourceLockRequired?: boolean;
    transactions?: Array<{
      to: string;
      data: string;
      value?: string;
    }>;
    compact?: CompactResponse;
    hash?: string;
    nonce?: string;
    /**
     * Client-side EVM deposit into The Compact contract (depositERC20AndRegister
     * / depositNativeAndRegister). Populated by the SDK after the user's wallet
     * signs the deposit tx; only present for EVM-collateral flows.
     */
    depositResult?: {
      success?: boolean;
      transactionHash?: string;
    };
  };
  error?: string;
  /** The intent nonce used for status tracking (userAddress:intentNonce in SIO) */
  intentNonce?: string;
  /** Chain id the compact deposit landed on (= source EVM chain). */
  depositChainId?: number;
}
