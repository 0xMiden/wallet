import { isRecord } from 'lib/update/guards';

import { assertOneClickDeadline } from './deadline';
import { isOneClickLocalE2EEnabled } from './e2e-gate';
import { assertNearIntentsRoute } from './identity';
import { hashOneClickQuote, verifyOneClickQuoteSignature } from './signature';
import type {
  NearIntentsChainConfig,
  NearIntentsConfig,
  NearIntentsMidenAssetConfig,
  OneClickAsset,
  OneClickDestinationReceipt,
  OneClickOnchainMetadataResolver,
  OneClickProviderStatus,
  OneClickQuote,
  OneClickQuoteRequest,
  OneClickQuoteResponse,
  OneClickSignedRequest,
  OneClickStatusResponse,
  OneClickSwapDetails,
  OneClickTransactionDetails
} from './types';

export function createMidenAssetMetadataResolver(
  resolveFaucet: (faucetId: string) => Promise<{ decimals: number; symbol?: string }>
): OneClickOnchainMetadataResolver {
  return asset => {
    if (!asset.faucetId) throw new Error('Miden asset has no configured faucet id');
    return resolveFaucet(asset.faucetId);
  };
}

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const ISO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;
const BLOCKCHAIN = /^[a-z][a-z0-9-]{0,31}$/;
const ADDRESS_KINDS: ReadonlySet<string> = new Set(['evm', 'solana', 'bitcoin', 'near']);
const MAX_CHAINS = 32;
const MAX_TOKENS_PER_CHAIN = 64;
const MAX_TOKEN_OUTPUTS = 8;

export class OneClickHttpError extends Error {
  constructor(readonly status: number) {
    super(`1Click request failed (${status})`);
    this.name = 'OneClickHttpError';
  }
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isDecimals(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 38;
}

// Check the origin chains. A token asset id is unique in the whole config and is not the asset id of a Miden token,
// and each `miden` entry names a configured Miden token.
function validateChains(
  chains: readonly NearIntentsChainConfig[],
  midenAssets: readonly NearIntentsMidenAssetConfig[]
) {
  if (!Array.isArray(chains) || chains.length > MAX_CHAINS) throw new Error('Invalid 1Click chain configuration');
  const midenIds = new Set<string>();
  for (const asset of midenAssets) {
    if (!isBoundedText(asset.id, 64) || midenIds.has(asset.id)) throw new Error('Invalid 1Click asset configuration');
    midenIds.add(asset.id);
  }
  const assetIds = new Set(midenAssets.map(asset => asset.assetId));
  const chainIds = new Set<string>();
  for (const chain of chains) {
    if (
      !chain ||
      typeof chain.id !== 'string' ||
      !BLOCKCHAIN.test(chain.id) ||
      chain.id === 'miden' ||
      chainIds.has(chain.id) ||
      !isBoundedText(chain.name, 64) ||
      !ADDRESS_KINDS.has(chain.addressKind) ||
      !Array.isArray(chain.tokens) ||
      chain.tokens.length < 1 ||
      chain.tokens.length > MAX_TOKENS_PER_CHAIN
    )
      throw new Error('Invalid 1Click chain configuration');
    chainIds.add(chain.id);
    for (const token of chain.tokens) {
      if (
        !token ||
        !isBoundedText(token.symbol, 32) ||
        !isBoundedText(token.assetId, 256) ||
        assetIds.has(token.assetId) ||
        !isDecimals(token.decimals) ||
        (token.contractAddress !== undefined && !isBoundedText(token.contractAddress, 256)) ||
        !Array.isArray(token.miden) ||
        token.miden.length < 1 ||
        token.miden.length > MAX_TOKEN_OUTPUTS ||
        new Set(token.miden).size !== token.miden.length ||
        token.miden.some((id: string) => !midenIds.has(id))
      )
        throw new Error('Invalid 1Click chain configuration');
      assetIds.add(token.assetId);
    }
  }
}

function validateConfig(config: NearIntentsConfig): string {
  if (!config || typeof config.serviceUrl !== 'string' || config.serviceUrl.length > 512)
    throw new Error('1Click is not configured');
  const url = new URL(config.serviceUrl);
  const localTestService =
    isOneClickLocalE2EEnabled() &&
    ['http:', 'https:'].includes(url.protocol) &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (isOneClickLocalE2EEnabled() && !localTestService) throw new Error('Invalid 1Click test service URL');
  if ((url.protocol !== 'https:' && !localTestService) || url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid 1Click service URL');
  }
  if (!Array.isArray(config.midenAssets) || config.midenAssets.length > 64)
    throw new Error('Invalid 1Click asset configuration');
  const assetIds = new Set<string>();
  const faucetIds = new Set<string>();
  for (const asset of config.midenAssets) {
    if (
      !asset ||
      typeof asset.assetId !== 'string' ||
      asset.assetId.length < 1 ||
      asset.assetId.length > 256 ||
      typeof asset.faucetId !== 'string' ||
      !/^0x[0-9a-f]{30}$/i.test(asset.faucetId) ||
      !Number.isSafeInteger(asset.decimals) ||
      asset.decimals < 0 ||
      asset.decimals > 38 ||
      assetIds.has(asset.assetId) ||
      faucetIds.has(asset.faucetId.toLowerCase())
    )
      throw new Error('Invalid 1Click asset configuration');
    assetIds.add(asset.assetId);
    faucetIds.add(asset.faucetId.toLowerCase());
  }
  // A tracking row written before NEAR Intents moved to the Receive page keeps a config with no `chains`. Its status
  // can still be read; a new quote for it cannot pass `assertOneClickQuoteBinding`, which needs a configured pair.
  if (config.chains !== undefined) validateChains(config.chains, config.midenAssets);
  if (config.appFees !== undefined) {
    if (
      !Array.isArray(config.appFees) ||
      config.appFees.length > 3 ||
      config.appFees.some(
        fee =>
          !fee ||
          typeof fee.recipient !== 'string' ||
          fee.recipient.length < 2 ||
          fee.recipient.length > 128 ||
          !Number.isSafeInteger(fee.fee) ||
          fee.fee < 0 ||
          fee.fee > 1000
      ) ||
      config.appFees.reduce((sum, fee) => sum + fee.fee, 0) > 1000
    )
      throw new Error('Invalid 1Click app fee configuration');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * Send one bounded request to the configured 1Click service: a 12 s timeout and a 1 MB body limit. The config is
 * checked before the request.
 */
export async function requestOneClickJson(
  config: NearIntentsConfig,
  path: string,
  init?: RequestInit,
  fetcher: typeof fetch = fetch
): Promise<unknown> {
  const base = validateConfig(config);
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      void reader?.cancel().catch(() => undefined);
      reject(new Error('1Click request timed out'));
    }, REQUEST_TIMEOUT_MS);
  });
  try {
    const response = await Promise.race([
      fetcher(`${base}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
          ...init?.headers
        }
      }),
      timeout
    ]);
    reader = response.body?.getReader();
    if (!reader) throw new Error('1Click response body is missing');
    const decoder = new TextDecoder();
    let bytes = 0;
    let body = '';
    try {
      while (true) {
        const part = await Promise.race([reader.read(), timeout]);
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw new Error('1Click response is too large');
        body += decoder.decode(part.value, { stream: true });
      }
      body += decoder.decode();
    } catch (error) {
      void reader.cancel().catch(() => undefined);
      throw error;
    }
    if (!response.ok) throw new OneClickHttpError(response.status);
    return JSON.parse(body);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isIso(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ISO_UTC.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString().startsWith(value.slice(0, 19))
  );
}

function isAmount(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]{1,78}$/.test(value) && BigInt(value) > 0n;
}

export function parseOneClickQuoteResponse(value: unknown): OneClickQuoteResponse {
  if (!isRecord(value) || !isRecord(value.quoteRequest) || !isRecord(value.quote))
    throw new Error('Invalid 1Click quote response');
  const request = value.quoteRequest;
  const quote = value.quote;
  if (Object.prototype.hasOwnProperty.call(request, 'appFees') && !Array.isArray(request.appFees)) {
    throw new Error('Invalid 1Click quote response');
  }
  const correlationId = requiredString(value, 'correlationId', 256);
  const timestamp = requiredString(value, 'timestamp', 64);
  const signature = requiredString(value, 'signature', 256);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error('Invalid 1Click quote timestamp');
  const dry = request.dry;
  const slippageTolerance = request.slippageTolerance;
  if (
    typeof dry !== 'boolean' ||
    request.swapType !== 'EXACT_INPUT' ||
    !isSafeNumber(slippageTolerance) ||
    request.depositType !== 'ORIGIN_CHAIN' ||
    request.refundType !== 'ORIGIN_CHAIN' ||
    request.recipientType !== 'DESTINATION_CHAIN'
  ) {
    throw new Error('Invalid 1Click quote request fields');
  }
  const quoteRequest: OneClickSignedRequest = {
    dry,
    swapType: 'EXACT_INPUT',
    slippageTolerance,
    originAsset: requiredString(request, 'originAsset', 256),
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: requiredString(request, 'destinationAsset', 256),
    amount: requiredAmount(request, 'amount'),
    refundTo: requiredString(request, 'refundTo', 256),
    refundType: 'ORIGIN_CHAIN',
    recipient: requiredString(request, 'recipient', 256),
    recipientType: 'DESTINATION_CHAIN',
    deadline: requiredIso(request, 'deadline'),
    ...(isSafeNumber(request.quoteWaitingTimeMs) && request.quoteWaitingTimeMs !== 0
      ? { quoteWaitingTimeMs: request.quoteWaitingTimeMs }
      : {}),
    ...(nonEmptyString(request.referral) ? { referral: request.referral } : {}),
    ...(nonEmptyString(request.virtualChainRecipient) ? { virtualChainRecipient: request.virtualChainRecipient } : {}),
    ...(nonEmptyString(request.virtualChainRefundRecipient)
      ? { virtualChainRefundRecipient: request.virtualChainRefundRecipient }
      : {}),
    ...(nonEmptyString(request.customRecipientMsg) ? { customRecipientMsg: request.customRecipientMsg } : {}),
    ...(Array.isArray(request.appFees) ? { appFees: parseAppFees(request.appFees) } : {})
  };
  for (const key of ['amountIn', 'minAmountIn', 'amountOut', 'minAmountOut']) {
    if (!isAmount(quote[key])) throw new Error(`Invalid 1Click quote ${key}`);
  }
  const parsedQuote: OneClickQuote = {
    amountIn: requiredString(quote, 'amountIn', 78),
    amountInFormatted: requiredString(quote, 'amountInFormatted', 128),
    amountInUsd: requiredString(quote, 'amountInUsd', 128),
    minAmountIn: requiredString(quote, 'minAmountIn', 78),
    amountOut: requiredString(quote, 'amountOut', 78),
    amountOutFormatted: requiredString(quote, 'amountOutFormatted', 128),
    amountOutUsd: requiredString(quote, 'amountOutUsd', 128),
    minAmountOut: requiredString(quote, 'minAmountOut', 78),
    timeEstimate: requiredSafeNumber(quote, 'timeEstimate'),
    ...(optionalBoundedString(quote.depositAddress, 256) ? { depositAddress: quote.depositAddress } : {}),
    ...(optionalBoundedString(quote.depositMemo, 256) ? { depositMemo: quote.depositMemo } : {}),
    ...(optionalIso(quote.deadline) ? { deadline: quote.deadline } : {}),
    ...(optionalIso(quote.timeWhenInactive) ? { timeWhenInactive: quote.timeWhenInactive } : {}),
    ...(optionalString(quote.refundFee) ? { refundFee: quote.refundFee } : {}),
    ...(optionalString(quote.withdrawFee) ? { withdrawFee: quote.withdrawFee } : {}),
    ...(optionalString(quote.virtualChainRecipient) ? { virtualChainRecipient: quote.virtualChainRecipient } : {}),
    ...(optionalString(quote.virtualChainRefundRecipient)
      ? { virtualChainRefundRecipient: quote.virtualChainRefundRecipient }
      : {}),
    ...(optionalString(quote.customRecipientMsg) ? { customRecipientMsg: quote.customRecipientMsg } : {})
  };
  return { correlationId, timestamp, signature, quoteRequest, quote: parsedQuote };
}

function requiredString(record: Record<string, unknown>, key: string, maxLength: number): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength)
    throw new Error(`Invalid 1Click ${key}`);
  return value;
}

function requiredAmount(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (!isAmount(value)) throw new Error(`Invalid 1Click ${key}`);
  return value;
}

function requiredIso(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (!isIso(value)) throw new Error(`Invalid 1Click ${key}`);
  return value;
}

function requiredSafeNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (!isSafeNumber(value) || value < 0) throw new Error(`Invalid 1Click ${key}`);
  return value;
}

function optionalString(value: unknown): value is string {
  return typeof value === 'string';
}

function optionalBoundedString(value: unknown, maxLength: number): value is string {
  if (value === undefined) return false;
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength)
    throw new Error('Invalid 1Click quote string');
  return true;
}

function optionalIso(value: unknown): value is string {
  if (value === undefined) return false;
  if (!isIso(value)) throw new Error('Invalid 1Click quote timestamp');
  return true;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isSafeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function parseAppFees(value: unknown[]): { recipient: string; fee: number }[] {
  if (value.length > 3) throw new Error('Invalid 1Click app fees');
  return value.map(entry => {
    if (!isRecord(entry) || typeof entry.recipient !== 'string' || !isSafeNumber(entry.fee))
      throw new Error('Invalid 1Click app fee');
    return { recipient: entry.recipient, fee: entry.fee };
  });
}

function validateProviderFees(
  actual: { recipient: string; fee: number }[],
  configured: { recipient: string; fee: number }[]
): void {
  if (
    actual.length > 3 ||
    actual.some(
      fee =>
        fee.recipient.length < 2 ||
        fee.recipient.length > 128 ||
        !Number.isSafeInteger(fee.fee) ||
        fee.fee < 0 ||
        fee.fee > 1000
    ) ||
    actual.reduce((sum, fee) => sum + fee.fee, 0) > 1000
  ) {
    throw new Error('1Click provider fees are invalid');
  }
  const remaining = [...actual];
  for (const expected of configured) {
    const matchedIndex = remaining.findIndex(fee => fee.recipient === expected.recipient && fee.fee === expected.fee);
    if (matchedIndex < 0) {
      throw new Error('1Click quote is missing a configured app fee');
    }
    remaining.splice(matchedIndex, 1);
  }
  if (remaining.length > 0) throw new Error('1Click quote is missing a configured app fee');
}

export function assertOneClickQuoteBinding(
  request: OneClickQuoteRequest,
  response: OneClickQuoteResponse,
  dry: boolean,
  config: NearIntentsConfig
): void {
  validateConfig(config);
  if (!verifyOneClickQuoteSignature(response)) throw new Error('1Click quote signature is invalid');
  const signed = response.quoteRequest;
  if (
    signed.dry !== dry ||
    signed.swapType !== 'EXACT_INPUT' ||
    signed.originAsset !== request.originAsset.assetId ||
    signed.depositType !== 'ORIGIN_CHAIN' ||
    signed.destinationAsset !== request.destinationAsset.assetId ||
    signed.amount !== request.amount ||
    signed.refundTo !== request.refundTo ||
    signed.refundType !== 'ORIGIN_CHAIN' ||
    signed.recipient !== request.recipient ||
    signed.recipientType !== 'DESTINATION_CHAIN' ||
    signed.deadline !== request.deadline ||
    signed.slippageTolerance !== request.slippageTolerance
  ) {
    throw new Error('1Click quote does not match the requested route');
  }
  validateProviderFees(signed.appFees ?? [], config.appFees ?? []);
  if (response.quote.amountIn !== request.amount) throw new Error('1Click quote changed the exact input amount');
  if (!dry) {
    assertOneClickDeadline(request.deadline);
    if (
      !response.quote.depositAddress ||
      !response.quote.deadline ||
      !isIso(response.quote.deadline) ||
      Date.parse(response.quote.deadline) <= Date.now()
    ) {
      throw new Error('1Click deposit quote is expired or incomplete');
    }
  }
  // The two assets must be trusted and must be a configured pair: the destination is a `miden` output of the origin.
  assertNearIntentsRoute(config, request.originAsset, request.destinationAsset);
}

export async function requestOneClickQuote(
  config: NearIntentsConfig,
  request: OneClickQuoteRequest,
  dry = true,
  fetcher: typeof fetch = fetch
): Promise<OneClickQuoteResponse> {
  validateRequest(request);
  const body = {
    dry,
    swapType: 'EXACT_INPUT',
    slippageTolerance: request.slippageTolerance,
    originAsset: request.originAsset.assetId,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: request.destinationAsset.assetId,
    amount: request.amount,
    refundTo: request.refundTo,
    refundType: 'ORIGIN_CHAIN',
    recipient: request.recipient,
    recipientType: 'DESTINATION_CHAIN',
    deadline: request.deadline,
    ...(config.appFees ? { appFees: config.appFees } : {})
  };
  const raw = await requestOneClickJson(config, '/v0/quote', { method: 'POST', body: JSON.stringify(body) }, fetcher);
  const response = parseOneClickQuoteResponse(raw);
  assertOneClickQuoteBinding(request, response, dry, config);
  return response;
}

function validateRequest(request: OneClickQuoteRequest): void {
  if (
    !request ||
    !isAmount(request.amount) ||
    !isIso(request.deadline) ||
    Date.parse(request.deadline) <= Date.now() ||
    !Number.isSafeInteger(request.slippageTolerance) ||
    request.slippageTolerance < 0 ||
    request.slippageTolerance > 5000 ||
    !validAsset(request.originAsset) ||
    !validAsset(request.destinationAsset) ||
    !request.refundTo ||
    request.refundTo.length > 256 ||
    !request.recipient ||
    request.recipient.length > 256
  ) {
    throw new Error('Invalid 1Click quote request');
  }
}

function validAsset(asset: OneClickAsset): boolean {
  return (
    !!asset &&
    typeof asset.assetId === 'string' &&
    asset.assetId.length > 0 &&
    asset.assetId.length <= 256 &&
    typeof asset.blockchain === 'string' &&
    /^[a-z][a-z0-9-]{0,31}$/.test(asset.blockchain) &&
    typeof asset.symbol === 'string' &&
    asset.symbol.length > 0 &&
    Number.isSafeInteger(asset.decimals) &&
    asset.decimals >= 0 &&
    asset.decimals <= 38
  );
}

const PROVIDER_STATUS_SET: ReadonlySet<string> = new Set([
  'KNOWN_DEPOSIT_TX',
  'PENDING_DEPOSIT',
  'INCOMPLETE_DEPOSIT',
  'PROCESSING',
  'SUCCESS',
  'REFUNDED',
  'FAILED'
]);

function isProviderStatus(value: unknown): value is OneClickProviderStatus {
  return typeof value === 'string' && PROVIDER_STATUS_SET.has(value);
}

function parseStatus(value: unknown): OneClickStatusResponse {
  if (
    !isRecord(value) ||
    typeof value.correlationId !== 'string' ||
    !isIso(value.updatedAt) ||
    !isProviderStatus(value.status) ||
    !isRecord(value.swapDetails) ||
    !Array.isArray(value.swapDetails.originChainTxHashes) ||
    !Array.isArray(value.swapDetails.destinationChainTxHashes) ||
    !Array.isArray(value.swapDetails.intentHashes) ||
    !Array.isArray(value.swapDetails.nearTxHashes)
  )
    throw new Error('Invalid 1Click status response');
  const quoteResponse = parseOneClickQuoteResponse(value.quoteResponse);
  if (!verifyOneClickQuoteSignature(quoteResponse)) throw new Error('1Click status quote signature is invalid');
  return {
    correlationId: value.correlationId,
    quoteResponse,
    status: value.status,
    updatedAt: value.updatedAt,
    swapDetails: parseSwapDetails(value.swapDetails)
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function parseSwapDetails(value: Record<string, unknown>): OneClickSwapDetails {
  const transactions = (input: unknown): OneClickTransactionDetails[] => {
    if (!Array.isArray(input)) throw new Error('Invalid 1Click transaction details');
    return input.map(item => {
      if (!isRecord(item) || typeof item.hash !== 'string' || typeof item.explorerUrl !== 'string')
        throw new Error('Invalid 1Click transaction details');
      return { hash: item.hash, explorerUrl: item.explorerUrl };
    });
  };
  const strings = (input: unknown): string[] => {
    if (!isStringArray(input)) throw new Error('Invalid 1Click status details');
    return input;
  };
  return {
    intentHashes: strings(value.intentHashes),
    nearTxHashes: strings(value.nearTxHashes),
    originChainTxHashes: transactions(value.originChainTxHashes),
    destinationChainTxHashes: transactions(value.destinationChainTxHashes),
    ...(optionalString(value.depositedAmount) ? { depositedAmount: value.depositedAmount } : {}),
    ...(optionalString(value.amountIn) ? { amountIn: value.amountIn } : {}),
    ...(optionalString(value.amountOut) ? { amountOut: value.amountOut } : {}),
    ...(optionalString(value.refundedAmount) ? { refundedAmount: value.refundedAmount } : {}),
    ...(optionalString(value.refundReason) ? { refundReason: value.refundReason } : {})
  };
}

export async function fetchOneClickStatus(
  config: NearIntentsConfig,
  depositAddress: string,
  depositMemo?: string,
  expectedQuote?: OneClickQuoteResponse
): Promise<OneClickStatusResponse> {
  if (!depositAddress || depositAddress.length > 256 || (depositMemo && depositMemo.length > 256))
    throw new Error('Invalid deposit reference');
  const query = new URLSearchParams({ depositAddress, ...(depositMemo ? { depositMemo } : {}) });
  const raw = await requestOneClickJson(config, `/v0/status?${query.toString()}`);
  const status = parseStatus(raw);
  validateProviderFees(status.quoteResponse.quoteRequest.appFees ?? [], config.appFees ?? []);
  if (
    status.quoteResponse.quote.depositAddress !== depositAddress ||
    status.quoteResponse.quote.depositMemo !== depositMemo ||
    (expectedQuote && hashOneClickQuote(status.quoteResponse) !== hashOneClickQuote(expectedQuote))
  ) {
    throw new Error('1Click status belongs to a different deposit');
  }
  return status;
}

export async function submitOneClickDeposit(
  config: NearIntentsConfig,
  depositAddress: string,
  transactionHash: string,
  memo?: string,
  expectedQuote?: OneClickQuoteResponse
): Promise<OneClickStatusResponse> {
  if (
    !depositAddress ||
    depositAddress.length > 256 ||
    !/^0x[0-9a-fA-F]{64}$/.test(transactionHash) ||
    (memo && memo.length > 256)
  ) {
    throw new Error('Invalid deposit submission');
  }
  const raw = await requestOneClickJson(config, '/v0/deposit/submit', {
    method: 'POST',
    body: JSON.stringify({ depositAddress, txHash: transactionHash, ...(memo ? { memo } : {}) })
  });
  const status = parseStatus(raw);
  validateProviderFees(status.quoteResponse.quoteRequest.appFees ?? [], config.appFees ?? []);
  if (
    status.quoteResponse.quote.depositAddress !== depositAddress ||
    (expectedQuote && hashOneClickQuote(status.quoteResponse) !== hashOneClickQuote(expectedQuote))
  )
    throw new Error('1Click submit response belongs to a different deposit');
  return status;
}

export async function resolveOneClickDestinationReceipts(
  config: NearIntentsConfig,
  transactionHashes: string[]
): Promise<OneClickDestinationReceipt[]> {
  validateConfig(config);
  if (
    !Array.isArray(transactionHashes) ||
    transactionHashes.length < 1 ||
    transactionHashes.length > 20 ||
    transactionHashes.some(hash => typeof hash !== 'string' || hash.length > 256)
  )
    throw new Error('Invalid destination transaction hashes');
  const raw = await requestOneClickJson(config, '/v1/receipts/resolve', {
    method: 'POST',
    body: JSON.stringify({ transactionHashes })
  });
  if (!Array.isArray(raw) || raw.length > 20) throw new Error('Invalid destination receipt response');
  return raw.map(entry => {
    if (
      !isRecord(entry) ||
      typeof entry.transactionHash !== 'string' ||
      !Array.isArray(entry.noteIds) ||
      !entry.noteIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 256)
    )
      throw new Error('Invalid destination receipt');
    return { transactionHash: entry.transactionHash, noteIds: entry.noteIds };
  });
}
