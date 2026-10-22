import { ed25519 } from '@noble/curves/ed25519';
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
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const TEST_SEED = Uint8Array.from({ length: 32 }, (_, index) => (index * 29 + 17) % 256);
const TEST_PUBLIC_KEY = ed25519.getPublicKey(TEST_SEED);

export const FAKE_ONE_CLICK_MANAGER_PUBLIC_KEY = `ed25519:${base58Encode(TEST_PUBLIC_KEY)}`;

export interface FakeOneClickRequestLog {
  method: string;
  path: string;
  body?: unknown;
}

export interface FakeOneClickServiceOptions {
  port?: number;
  tokens?: OneClickAsset[];
}

export type FakeOneClickQuoteBuilder = (
  request: OneClickSignedRequest,
  defaults: OneClickQuote
) => Partial<OneClickQuote>;

export function signFakeOneClickQuote(response: Omit<OneClickQuoteResponse, 'signature'>): OneClickQuoteResponse {
  const unsigned: OneClickQuoteResponse = { ...response, signature: '' };
  const signature = ed25519.sign(new TextEncoder().encode(hashOneClickQuote(unsigned)), TEST_SEED);
  return { ...unsigned, signature: `ed25519:${base58Encode(signature)}` };
}

export class FakeOneClickService {
  private server?: Server;
  private readonly port: number;
  private tokens: OneClickAsset[];
  private quoteBuilder: FakeOneClickQuoteBuilder = (_request, defaults) => defaults;
  private status: OneClickProviderStatus = 'PENDING_DEPOSIT';
  private statusDetails: Partial<OneClickSwapDetails> = {};
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

  setStatus(status: OneClickProviderStatus, details: Partial<OneClickSwapDetails> = {}): void {
    this.status = status;
    this.statusDetails = { ...details };
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
      server.close(error => error ? reject(error) : resolve());
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
      if (!quote || (url.searchParams.has('depositMemo') && url.searchParams.get('depositMemo') !== quote.quote.depositMemo)) {
        this.writeJson(response, 404, { error: 'unknown_deposit' });
        return;
      }
      this.writeJson(response, 200, this.statusResponse(quote));
      return;
    }
    if (method === 'POST' && url.pathname === '/v0/deposit/submit' && isRecord(body)) {
      const depositAddress = body.depositAddress;
      const quote = typeof depositAddress === 'string' ? this.quotesByDeposit.get(depositAddress) : undefined;
      if (!quote || typeof body.txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(body.txHash)) {
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
      this.writeJson(response, 200, this.receipts.filter(receipt => hashes.includes(receipt.transactionHash)));
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
    const depositAddress = `0x${this.quoteSequence.toString(16).padStart(40, '0')}`;
    const defaults: OneClickQuote = {
      amountIn: request.amount,
      amountInFormatted: request.amount,
      amountInUsd: '1',
      minAmountIn: request.amount,
      amountOut: request.amount,
      amountOutFormatted: request.amount,
      amountOutUsd: '1',
      minAmountOut: request.amount,
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
    const details: OneClickSwapDetails = {
      intentHashes: [],
      nearTxHashes: [],
      originChainTxHashes: [],
      destinationChainTxHashes: [],
      ...this.statusDetails
    };
    return {
      correlationId: quoteResponse.correlationId,
      quoteResponse,
      status: this.status,
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

function parseSignedRequest(value: Record<string, unknown>): OneClickSignedRequest | undefined {
  const appFees = value.appFees;
  if (typeof value.dry !== 'boolean' || value.swapType !== 'EXACT_INPUT' ||
      typeof value.slippageTolerance !== 'number' || !Number.isSafeInteger(value.slippageTolerance) ||
      typeof value.originAsset !== 'string' ||
      value.depositType !== 'ORIGIN_CHAIN' || typeof value.destinationAsset !== 'string' ||
      typeof value.amount !== 'string' || !/^[0-9]{1,78}$/.test(value.amount) || BigInt(value.amount) <= 0n ||
      typeof value.refundTo !== 'string' || typeof value.refundType !== 'string' || value.refundType !== 'ORIGIN_CHAIN' ||
      typeof value.recipient !== 'string' || value.recipientType !== 'DESTINATION_CHAIN' ||
      typeof value.deadline !== 'string' || !Number.isFinite(Date.parse(value.deadline)) ||
      (appFees !== undefined && (!Array.isArray(appFees) || appFees.length > 3 || !appFees.every(isAppFee)))) return undefined;
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
  return isRecord(value) && typeof value.recipient === 'string' && value.recipient.length >= 2 &&
    value.recipient.length <= 128 && Number.isSafeInteger(value.fee) &&
    typeof value.fee === 'number' && value.fee >= 0 && value.fee <= 1000;
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

function base58Encode(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let output = '';
  while (value > 0n) {
    const digit = Number(value % 58n);
    output = `${BASE58[digit]}${output}`;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    output = `1${output}`;
  }
  return output;
}
