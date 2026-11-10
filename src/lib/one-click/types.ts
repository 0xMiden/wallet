export type OneClickBlockchain = 'eth' | 'base' | 'arb' | 'op' | 'arc' | 'miden' | (string & {});

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

export interface OneClickAppFee {
  recipient: string;
  fee: number;
}

/** The address format of an origin chain. The wallet uses it to check a refund address. */
export type NearIntentsAddressKind = 'evm' | 'solana' | 'bitcoin' | 'near';

/** One Miden token that a deposit can deliver. `id` is the short name that a chain token refers to. */
export interface NearIntentsMidenAssetConfig {
  id: string;
  assetId: string;
  faucetId: string;
  decimals: number;
}

/** One token on an origin chain. `miden` lists the `id` of each Miden token that it can become. */
export interface NearIntentsTokenConfig {
  symbol: string;
  assetId: string;
  decimals: number;
  contractAddress?: string;
  miden: string[];
}

/** One origin chain. `id` is the 1Click `blockchain` name. `tokens` keeps the order of the document. */
export interface NearIntentsChainConfig {
  id: string;
  name: string;
  addressKind: NearIntentsAddressKind;
  tokens: NearIntentsTokenConfig[];
}

/** The parsed `nearIntents` section of the wallet-config document. `chains` keeps the order of the document. */
export interface NearIntentsConfig {
  serviceUrl: string;
  appFees?: OneClickAppFee[];
  chains: NearIntentsChainConfig[];
  midenAssets: NearIntentsMidenAssetConfig[];
}

/** One configured token that the live 1Click token list confirms, with the Miden tokens it can become. */
export interface NearIntentsCatalogToken {
  symbol: string;
  asset: OneClickAsset;
  outputs: OneClickAsset[];
}

export interface NearIntentsCatalogChain {
  id: string;
  name: string;
  addressKind: NearIntentsAddressKind;
  tokens: NearIntentsCatalogToken[];
}

/** The configured pairs that the live 1Click token list confirms. A chain with no confirmed token is not included. */
export interface NearIntentsCatalog {
  chains: NearIntentsCatalogChain[];
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

export type OneClickOnchainMetadataResolver = (asset: OneClickAsset) => Promise<{ decimals: number; symbol?: string }>;

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
