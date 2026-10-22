export type OneClickBlockchain =
  | 'eth'
  | 'base'
  | 'arb'
  | 'op'
  | 'arc'
  | 'miden'
  | (string & {});

export interface OneClickAsset {
  assetId: string;
  blockchain: OneClickBlockchain;
  symbol: string;
  decimals: number;
  coingeckoId?: string;
  contractAddress?: string;
  faucetId?: string;
  chainId?: number;
}

export interface OneClickMidenAssetConfig {
  assetId: string;
  faucetId: string;
  decimals: number;
}

export interface OneClickAppFee {
  recipient: string;
  fee: number;
}

export interface OneClickConfig {
  serviceUrl: string;
  midenAssets: OneClickMidenAssetConfig[];
  appFees?: OneClickAppFee[];
}

export interface OneClickQuoteRequest {
  amount: string;
  originAsset: OneClickAsset;
  destinationAsset: OneClickAsset;
  refundTo: string;
  recipient: string;
  deadline: string;
  slippageTolerance: number;
}

export interface OneClickSignedRequest {
  dry: boolean;
  swapType: 'EXACT_INPUT';
  slippageTolerance: number;
  originAsset: string;
  depositType: 'ORIGIN_CHAIN';
  destinationAsset: string;
  amount: string;
  refundTo: string;
  refundType: 'ORIGIN_CHAIN';
  recipient: string;
  recipientType: 'DESTINATION_CHAIN';
  deadline: string;
  quoteWaitingTimeMs?: number;
  referral?: string;
  virtualChainRecipient?: string;
  virtualChainRefundRecipient?: string;
  customRecipientMsg?: string;
  sessionId?: string;
  connectedWallets?: string[];
  correlationId?: string;
  appFees?: OneClickAppFee[];
  confidentiality?: 'public' | 'basic' | 'advanced';
  insured?: boolean;
  partnerId?: string;
  userAccountId?: string;
  depositMode?: 'SIMPLE' | 'MEMO';
}

export interface OneClickQuote {
  depositAddress?: string;
  depositMemo?: string;
  amountIn: string;
  amountInFormatted: string;
  amountInUsd: string;
  minAmountIn: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd: string;
  minAmountOut: string;
  deadline?: string;
  timeWhenInactive?: string;
  timeEstimate: number;
  refundFee?: string;
  withdrawFee?: string;
  virtualChainRecipient?: string;
  virtualChainRefundRecipient?: string;
  customRecipientMsg?: string;
}

export interface OneClickQuoteResponse {
  correlationId: string;
  timestamp: string;
  signature: string;
  quoteRequest: OneClickSignedRequest;
  quote: OneClickQuote;
}

export type OneClickProviderStatus =
  | 'KNOWN_DEPOSIT_TX'
  | 'PENDING_DEPOSIT'
  | 'INCOMPLETE_DEPOSIT'
  | 'PROCESSING'
  | 'SUCCESS'
  | 'REFUNDED'
  | 'FAILED';

export interface OneClickTransactionDetails {
  hash: string;
  explorerUrl: string;
}

export interface OneClickSwapDetails {
  intentHashes: string[];
  nearTxHashes: string[];
  amountIn?: string;
  amountOut?: string;
  originChainTxHashes: OneClickTransactionDetails[];
  destinationChainTxHashes: OneClickTransactionDetails[];
  refundedAmount?: string;
  refundReason?: string;
  depositedAmount?: string;
}

export interface OneClickStatusResponse {
  correlationId: string;
  quoteResponse: OneClickQuoteResponse;
  status: OneClickProviderStatus;
  updatedAt: string;
  swapDetails: OneClickSwapDetails;
}

export type OneClickOnchainMetadataResolver = (
  asset: OneClickAsset,
) => Promise<{ decimals: number; symbol?: string }>;

export interface OneClickQuoteBinding {
  request: OneClickQuoteRequest;
  quote: OneClickQuoteResponse;
}

export interface OneClickDestinationReceipt {
  transactionHash: string;
  noteIds: string[];
}

export interface OneClickDepositResult {
  transactionHash: string;
}

export interface OneClickReceiptAdapterConfig {
  enabled: boolean;
}
