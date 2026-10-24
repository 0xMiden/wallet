import { isRecord } from 'lib/update/guards';

import { assertOneClickDeadline } from './deadline';
import { isOneClickLocalE2EEnabled } from './e2e-gate';
import {
  assertOneClickAssetIdentity,
  isOneClickNativeAssetId,
  ONE_CLICK_EVM_CHAIN_IDS,
  parseOneClickEvmAssets
} from './identity';
import { hashOneClickQuote, verifyOneClickQuoteSignature } from './signature';
import type {
  OneClickAsset,
  OneClickConfig,
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

export { ONE_CLICK_EVM_CHAIN_IDS } from './identity';

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const ONE_CLICK_METADATA_READS_AT_ONCE = 4;
const ISO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export class OneClickHttpError extends Error {
  constructor(readonly status: number) {
    super(`1Click request failed (${status})`);
    this.name = 'OneClickHttpError';
  }
}

function validateConfig(config: OneClickConfig): string {
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
  parseOneClickEvmAssets(config.evmAssets, assetIds);
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

async function requestJson(
  config: OneClickConfig,
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
  config: OneClickConfig
): void {
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
  const trustedEvmAssets = parseOneClickEvmAssets(
    config.evmAssets,
    new Set(config.midenAssets.map(asset => asset.assetId))
  );
  assertOneClickAssetIdentity(request.originAsset, trustedEvmAssets);
  assertOneClickAssetIdentity(request.destinationAsset, trustedEvmAssets);
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
}

export async function fetchOneClickAssets(
  config: OneClickConfig,
  resolveMetadata: OneClickOnchainMetadataResolver,
  fetcher: typeof fetch = fetch
): Promise<OneClickAsset[]> {
  const raw = await requestJson(config, '/v0/tokens', undefined, fetcher);
  if (!Array.isArray(raw) || raw.length > 5000) throw new Error('Invalid 1Click token response');
  const trustedEvmAssets = parseOneClickEvmAssets(
    config.evmAssets,
    new Set(config.midenAssets.map(asset => asset.assetId))
  );
  const assets: OneClickAsset[] = [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const item of raw) {
    if (
      !isRecord(item) ||
      typeof item.assetId !== 'string' ||
      item.assetId.length > 256 ||
      typeof item.blockchain !== 'string' ||
      !/^[a-z][a-z0-9-]{0,31}$/.test(item.blockchain) ||
      typeof item.symbol !== 'string' ||
      item.symbol.length < 1 ||
      item.symbol.length > 32 ||
      (item.coingeckoId !== undefined &&
        (typeof item.coingeckoId !== 'string' || item.coingeckoId.length < 1 || item.coingeckoId.length > 128)) ||
      !isSafeNumber(item.decimals) ||
      item.decimals < 0 ||
      item.decimals > 38 ||
      byId.has(item.assetId)
    )
      continue;
    const decimals = item.decimals;
    byId.set(item.assetId, item);
    const isSupportedEvm = Object.prototype.hasOwnProperty.call(ONE_CLICK_EVM_CHAIN_IDS, item.blockchain);
    const chainId = ONE_CLICK_EVM_CHAIN_IDS[item.blockchain];
    const pinnedNative = isOneClickNativeAssetId(item.assetId);
    if (pinnedNative && item.contractAddress !== undefined && item.contractAddress !== 'native') continue;
    if (
      item.contractAddress !== undefined &&
      (typeof item.contractAddress !== 'string' ||
        item.contractAddress.length > 256 ||
        (isSupportedEvm && item.contractAddress !== 'native' && !EVM_ADDRESS.test(item.contractAddress)))
    )
      continue;
    const candidate: OneClickAsset = {
      assetId: item.assetId,
      blockchain: item.blockchain,
      symbol: item.symbol,
      decimals,
      ...(typeof item.coingeckoId === 'string' ? { coingeckoId: item.coingeckoId } : {}),
      ...(pinnedNative || item.contractAddress === 'native'
        ? { contractAddress: 'native' }
        : typeof item.contractAddress === 'string'
          ? { contractAddress: isSupportedEvm ? item.contractAddress.toLowerCase() : item.contractAddress }
          : {}),
      ...(chainId ? { chainId } : {})
    };
    try {
      assertOneClickAssetIdentity(candidate, trustedEvmAssets);
    } catch {
      continue;
    }
    if (item.contractAddress === 'native' && !pinnedNative) continue;
    if (item.blockchain === 'miden') continue;
    assets.push(candidate);
  }
  const candidates = config.midenAssets.flatMap(configured => {
    const listed = byId.get(configured.assetId);
    if (!listed || listed.blockchain !== 'miden' || listed.decimals !== configured.decimals) return [];
    const candidate: OneClickAsset = {
      assetId: configured.assetId,
      blockchain: 'miden',
      symbol: typeof listed.symbol === 'string' ? listed.symbol : '',
      decimals: configured.decimals,
      faucetId: configured.faucetId,
      ...(typeof listed.coingeckoId === 'string' ? { coingeckoId: listed.coingeckoId } : {})
    };
    return [{ configured, candidate }];
  });
  for (let start = 0; start < candidates.length; start += ONE_CLICK_METADATA_READS_AT_ONCE) {
    const metadataResults = await Promise.all(
      candidates.slice(start, start + ONE_CLICK_METADATA_READS_AT_ONCE).map(async ({ configured, candidate }) => {
        try {
          const metadata = await resolveMetadata(candidate);
          if (
            !Number.isSafeInteger(metadata.decimals) ||
            metadata.decimals !== configured.decimals ||
            typeof metadata.symbol !== 'string' ||
            !metadata.symbol.trim()
          )
            return undefined;
          return { ...candidate, symbol: metadata.symbol };
        } catch {
          return undefined;
        }
      })
    );
    assets.push(...metadataResults.filter((asset): asset is OneClickAsset => asset !== undefined));
  }
  return assets;
}

export function isSameOneClickUnderlyingAsset(left: OneClickAsset, right: OneClickAsset): boolean {
  if (left.assetId === right.assetId) return true;
  return typeof left.coingeckoId === 'string' && left.coingeckoId.length > 0 && left.coingeckoId === right.coingeckoId;
}

export async function requestOneClickQuote(
  config: OneClickConfig,
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
  const raw = await requestJson(config, '/v0/quote', { method: 'POST', body: JSON.stringify(body) }, fetcher);
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
  config: OneClickConfig,
  depositAddress: string,
  depositMemo?: string,
  expectedQuote?: OneClickQuoteResponse
): Promise<OneClickStatusResponse> {
  if (!depositAddress || depositAddress.length > 256 || (depositMemo && depositMemo.length > 256))
    throw new Error('Invalid deposit reference');
  const query = new URLSearchParams({ depositAddress, ...(depositMemo ? { depositMemo } : {}) });
  const raw = await requestJson(config, `/v0/status?${query.toString()}`);
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
  config: OneClickConfig,
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
  const raw = await requestJson(config, '/v0/deposit/submit', {
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
  config: OneClickConfig,
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
  const raw = await requestJson(config, '/v1/receipts/resolve', {
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
