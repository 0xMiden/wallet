import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';

import { hashOneClickQuote } from '../../../src/lib/one-click/signature';
import type {
  OneClickAsset,
  OneClickDestinationReceipt,
  OneClickProviderStatus,
  OneClickQuote,
  OneClickQuoteResponse,
  OneClickSignedRequest,
  OneClickSwapDetails
} from '../../../src/lib/one-click/types';

const MAX_REQUEST_BYTES = 32_768;
const TEST_SEED = Uint8Array.from({ length: 32 }, (_, index) => (index * 29 + 17) % 256);
const TEST_PUBLIC_KEY = ed25519.getPublicKey(TEST_SEED);
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

export const FAKE_ONE_CLICK_MANAGER_PUBLIC_KEY = `ed25519:${bs58.encode(TEST_PUBLIC_KEY)}`;

/**
 * Origin tokens on chains that are not EVM chains, as the 1Click token list names them. A suite gives these to the
 * service with the Miden tokens of its document.
 */
export const FAKE_NEAR_INTENTS_ORIGIN_TOKENS: readonly OneClickAsset[] = [
  { assetId: 'nep141:sol.omft.near', blockchain: 'sol', symbol: 'SOL', decimals: 9 },
  { assetId: 'nep141:btc.omft.near', blockchain: 'btc', symbol: 'BTC', decimals: 8 },
  { assetId: 'nep141:wrap.near', blockchain: 'near', symbol: 'NEAR', decimals: 24 }
];

export interface FakeOneClickRequestLog {
  method: string;
  path: string;
  body?: unknown;
}

export interface FakeOneClickServiceOptions {
  port?: number;
  tokens?: OneClickAsset[];
}

/** One deposit address that a wet quote gave, with the request that the quote answered. */
export interface FakeOneClickDeposit {
  depositAddress: string;
  request: OneClickSignedRequest;
}

export type FakeOneClickQuoteBuilder = (
  request: OneClickSignedRequest,
  defaults: OneClickQuote
) => Partial<OneClickQuote>;

export function signFakeOneClickQuote(response: Omit<OneClickQuoteResponse, 'signature'>): OneClickQuoteResponse {
  const unsigned: OneClickQuoteResponse = { ...response, signature: '' };
  const signature = ed25519.sign(new TextEncoder().encode(hashOneClickQuote(unsigned)), TEST_SEED);
  return { ...unsigned, signature: `ed25519:${bs58.encode(signature)}` };
}

export class FakeOneClickService {
  private server?: Server;
  private readonly port: number;
  private tokens: OneClickAsset[];
  private quoteBuilder: FakeOneClickQuoteBuilder = (_request, defaults) => defaults;
  private status: OneClickProviderStatus = 'PENDING_DEPOSIT';
  private statusDetails: Partial<OneClickSwapDetails> = {};
  private readonly depositStatuses = new Map<
    string,
    { status: OneClickProviderStatus; details: Partial<OneClickSwapDetails> }
  >();
  private receipts: OneClickDestinationReceipt[] = [];
  private quoteSequence = 0;
  private readonly quotesByDeposit = new Map<string, OneClickQuoteResponse>();
  readonly requests: FakeOneClickRequestLog[] = [];

  constructor(options: FakeOneClickServiceOptions = {}) {
    this.port = options.port ?? 0;
    this.tokens = options.tokens ? [...options.tokens] : [];
  }

  get baseUrl(): string {
    const address = this.server?.address();
    if (!address || typeof address === 'string') throw new Error('The fake 1Click service is not running');
    return `http://127.0.0.1:${address.port}`;
  }

  setTokens(tokens: OneClickAsset[]): void {
    this.tokens = [...tokens];
  }

  setQuoteBuilder(builder: FakeOneClickQuoteBuilder): void {
    this.quoteBuilder = builder;
  }

  /** Set the status of every deposit that has no status of its own. */
  setStatus(status: OneClickProviderStatus, details: Partial<OneClickSwapDetails> = {}): void {
    this.status = status;
    this.statusDetails = { ...details };
  }

  /**
   * Set the status of one deposit. A suite moves a deposit through `PENDING_DEPOSIT`, `PROCESSING` and `SUCCESS` with
   * this call alone, as the provider does when a user pays from an external wallet: no deposit-submit call is needed.
   */
  setDepositStatus(
    depositAddress: string,
    status: OneClickProviderStatus,
    details: Partial<OneClickSwapDetails> = {}
  ): void {
    if (!this.quotesByDeposit.has(depositAddress)) {
      throw new Error(`The fake 1Click service gave no deposit address ${depositAddress}`);
    }
    this.depositStatuses.set(depositAddress, { status, details: { ...details } });
  }

  /** The deposit addresses that wet quotes gave, oldest first. */
  deposits(): FakeOneClickDeposit[] {
    return Array.from(this.quotesByDeposit, ([depositAddress, quote]) => ({
      depositAddress,
      request: quote.quoteRequest
    }));
  }

  /** The deposit address of the most recent wet quote, or undefined before the first one. */
  latestDeposit(): FakeOneClickDeposit | undefined {
    const all = this.deposits();
    return all[all.length - 1];
  }

  setReceipts(receipts: OneClickDestinationReceipt[]): void {
    this.receipts = receipts.map(receipt => ({ ...receipt, noteIds: [...receipt.noteIds] }));
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, '127.0.0.1', () => resolve());
    }).catch(error => {
      this.server = undefined;
      throw error;
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.addCors(response);
    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', this.baseUrl);
    if (method === 'OPTIONS') {
      response.statusCode = 204;
      response.end();
      return;
    }
    let body: unknown;
    if (method === 'POST') {
      try {
        body = await readJson(request);
      } catch {
        this.writeJson(response, 400, { error: 'invalid_request' });
        return;
      }
    }
    this.requests.push({ method, path: url.pathname, ...(body === undefined ? {} : { body }) });

    if (method === 'GET' && url.pathname === '/v0/tokens' && url.search === '') {
      this.writeJson(response, 200, this.tokens);
      return;
    }
    if (method === 'POST' && url.pathname === '/v0/quote' && isRecord(body)) {
      this.handleQuote(body, response);
      return;
    }
    if (method === 'GET' && url.pathname === '/v0/status') {
      const depositAddress = url.searchParams.get('depositAddress');
      const quote = depositAddress ? this.quotesByDeposit.get(depositAddress) : undefined;
      if (
        !quote ||
        (url.searchParams.has('depositMemo') && url.searchParams.get('depositMemo') !== quote.quote.depositMemo)
      ) {
        this.writeJson(response, 404, { error: 'unknown_deposit' });
        return;
      }
      this.writeJson(response, 200, this.statusResponse(quote));
      return;
    }
    if (method === 'POST' && url.pathname === '/v0/deposit/submit' && isRecord(body)) {
      const depositAddress = body.depositAddress;
      const quote = typeof depositAddress === 'string' ? this.quotesByDeposit.get(depositAddress) : undefined;
      // A transaction hash of any origin chain: an EVM hash, a Solana signature, a Bitcoin or NEAR hash.
      if (!quote || typeof body.txHash !== 'string' || !/^(0x)?[0-9A-Za-z]{32,128}$/.test(body.txHash)) {
        this.writeJson(response, 400, { error: 'invalid_deposit_submission' });
        return;
      }
      this.writeJson(response, 200, this.statusResponse(quote));
      return;
    }
    if (method === 'POST' && url.pathname === '/v1/receipts/resolve' && isRecord(body)) {
      const hashes = body.transactionHashes;
      if (!Array.isArray(hashes) || hashes.length > 20 || hashes.some(hash => typeof hash !== 'string')) {
        this.writeJson(response, 400, { error: 'invalid_receipt_request' });
        return;
      }
      this.writeJson(
        response,
        200,
        this.receipts.filter(receipt => hashes.includes(receipt.transactionHash))
      );
      return;
    }
    this.writeJson(response, 404, { error: 'not_found' });
  }

  private handleQuote(body: Record<string, unknown>, response: ServerResponse): void {
    const request = parseSignedRequest(body);
    if (!request) {
      this.writeJson(response, 400, { error: 'invalid_quote_request' });
      return;
    }
    this.quoteSequence += 1;
    const originAsset = this.tokens.find(asset => asset.assetId === request.originAsset);
    const depositAddress = fakeDepositAddress(originAsset?.blockchain, this.quoteSequence);
    const destinationAsset = this.tokens.find(asset => asset.assetId === request.destinationAsset);
    const amountIn = BigInt(request.amount);
    const decimalsKnown =
      originAsset !== undefined &&
      destinationAsset !== undefined &&
      isValidDecimals(originAsset.decimals) &&
      isValidDecimals(destinationAsset.decimals);
    const amountOut = decimalsKnown
      ? scaleBaseUnits(amountIn, originAsset.decimals, destinationAsset.decimals)
      : amountIn;
    const defaults: OneClickQuote = {
      amountIn: request.amount,
      amountInFormatted:
        originAsset && isValidDecimals(originAsset.decimals)
          ? formatBaseUnits(amountIn, originAsset.decimals)
          : request.amount,
      amountInUsd: '1',
      minAmountIn: request.amount,
      amountOut: amountOut.toString(),
      amountOutFormatted: decimalsKnown ? formatBaseUnits(amountOut, destinationAsset.decimals) : amountOut.toString(),
      amountOutUsd: '1',
      minAmountOut: amountOut.toString(),
      timeEstimate: 1,
      ...(request.dry ? {} : { depositAddress, deadline: request.deadline })
    };
    const quote: OneClickQuote = { ...defaults, ...this.quoteBuilder(request, defaults) };
    const responseBody = signFakeOneClickQuote({
      correlationId: `fake-one-click-${this.quoteSequence}`,
      timestamp: new Date().toISOString(),
      quoteRequest: request,
      quote
    });
    if (!request.dry && quote.depositAddress) this.quotesByDeposit.set(quote.depositAddress, responseBody);
    this.writeJson(response, 200, responseBody);
  }

  private statusResponse(quoteResponse: OneClickQuoteResponse) {
    const depositAddress = quoteResponse.quote.depositAddress;
    const own = depositAddress === undefined ? undefined : this.depositStatuses.get(depositAddress);
    const details: OneClickSwapDetails = {
      intentHashes: [],
      nearTxHashes: [],
      originChainTxHashes: [],
      destinationChainTxHashes: [],
      ...(own?.details ?? this.statusDetails)
    };
    return {
      correlationId: quoteResponse.correlationId,
      quoteResponse,
      status: own?.status ?? this.status,
      updatedAt: new Date().toISOString(),
      swapDetails: details
    };
  }

  private addCors(response: ServerResponse): void {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    response.setHeader('Cache-Control', 'no-store');
  }

  private writeJson(response: ServerResponse, status: number, body: unknown): void {
    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(body));
  }
}

/**
 * A deposit address in the format of the origin chain, the same for the same sequence number. Solana gets a base58
 * public key, Bitcoin a P2WPKH bech32 address, NEAR an implicit account. Any other chain gets an EVM address.
 */
export function fakeDepositAddress(blockchain: string | undefined, sequence: number): string {
  const seed = Uint8Array.from({ length: 32 }, (_, index) => (sequence * 31 + index * 7 + 1) % 256);
  switch (blockchain) {
    case 'sol':
      return bs58.encode(seed);
    case 'btc':
      return bech32Segwit('bc', 0, seed.slice(0, 20));
    case 'near':
      return Buffer.from(seed).toString('hex');
    default:
      return `0x${sequence.toString(16).padStart(40, '0')}`;
  }
}

function bech32Polymod(values: readonly number[]): number {
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    BECH32_GENERATORS.forEach((generator, bit) => {
      if ((top >>> bit) & 1) checksum ^= generator;
    });
  }
  return checksum;
}

function bech32HrpExpand(hrp: string): number[] {
  const codes = Array.from(hrp, character => character.charCodeAt(0));
  return [...codes.map(code => code >>> 5), 0, ...codes.map(code => code & 31)];
}

// Regroup 8-bit bytes into 5-bit groups, with zero padding at the end.
function toFiveBitGroups(bytes: Uint8Array): number[] {
  const groups: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      groups.push((accumulator >>> bits) & 31);
    }
  }
  if (bits > 0) groups.push((accumulator << (5 - bits)) & 31);
  return groups;
}

/** A bech32 (BIP 173) segwit address. The fake uses witness version 0 only. */
export function bech32Segwit(hrp: string, version: number, program: Uint8Array): string {
  const data = [version, ...toFiveBitGroups(program)];
  const polymod = bech32Polymod([...bech32HrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, index) => (polymod >>> (5 * (5 - index))) & 31);
  return `${hrp}1${[...data, ...checksum].map(value => BECH32_CHARSET.charAt(value)).join('')}`;
}

function isValidDecimals(decimals: number): boolean {
  return Number.isSafeInteger(decimals) && decimals >= 0 && decimals <= 38;
}

function formatBaseUnits(amount: bigint, decimals: number): string {
  if (amount === 0n) return '0';
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString();
  const sign = negative ? '-' : '';
  if (decimals === 0) return `${sign}${digits}`;

  const padded = digits.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return `${sign}${whole}${fraction ? `.${fraction}` : ''}`;
}

function scaleBaseUnits(amount: bigint, fromDecimals: number, toDecimals: number): bigint {
  const difference = toDecimals - fromDecimals;
  if (difference === 0) return amount;
  if (difference > 0) return amount * 10n ** BigInt(difference);
  return amount / 10n ** BigInt(-difference);
}

function parseSignedRequest(value: Record<string, unknown>): OneClickSignedRequest | undefined {
  const appFees = value.appFees;
  if (
    typeof value.dry !== 'boolean' ||
    value.swapType !== 'EXACT_INPUT' ||
    typeof value.slippageTolerance !== 'number' ||
    !Number.isSafeInteger(value.slippageTolerance) ||
    typeof value.originAsset !== 'string' ||
    value.depositType !== 'ORIGIN_CHAIN' ||
    typeof value.destinationAsset !== 'string' ||
    typeof value.amount !== 'string' ||
    !/^[0-9]{1,78}$/.test(value.amount) ||
    BigInt(value.amount) <= 0n ||
    typeof value.refundTo !== 'string' ||
    typeof value.refundType !== 'string' ||
    value.refundType !== 'ORIGIN_CHAIN' ||
    typeof value.recipient !== 'string' ||
    value.recipientType !== 'DESTINATION_CHAIN' ||
    typeof value.deadline !== 'string' ||
    !Number.isFinite(Date.parse(value.deadline)) ||
    (appFees !== undefined && (!Array.isArray(appFees) || appFees.length > 3 || !appFees.every(isAppFee)))
  )
    return undefined;
  return {
    dry: value.dry,
    swapType: 'EXACT_INPUT',
    slippageTolerance: value.slippageTolerance,
    originAsset: value.originAsset,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: value.destinationAsset,
    amount: value.amount,
    refundTo: value.refundTo,
    refundType: 'ORIGIN_CHAIN',
    recipient: value.recipient,
    recipientType: 'DESTINATION_CHAIN',
    deadline: value.deadline,
    ...(Array.isArray(appFees) ? { appFees } : {})
  };
}

function isAppFee(value: unknown): value is { recipient: string; fee: number } {
  return (
    isRecord(value) &&
    typeof value.recipient === 'string' &&
    value.recipient.length >= 2 &&
    value.recipient.length <= 128 &&
    Number.isSafeInteger(value.fee) &&
    typeof value.fee === 'number' &&
    value.fee >= 0 &&
    value.fee <= 1000
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    request.on('data', chunk => {
      if (settled) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += data.byteLength;
      if (bytes > MAX_REQUEST_BYTES) {
        settled = true;
        reject(new Error('Request too large'));
        return;
      }
      chunks.push(data);
    });
    request.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    request.on('error', error => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}
