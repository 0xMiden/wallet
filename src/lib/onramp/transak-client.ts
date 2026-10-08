/**
 * Get a Transak Buy widget URL from the wallet backend.
 *
 * The Transak URL has only `apiKey` and `sessionId`. Transak keeps the locked params (wallet, amount, token) in its
 * session, so the wallet cannot read them from the URL. The backend returns the exact `widgetParams` it sent to
 * Transak, and this module compares every field with the values of the user (the mirror check). The mirror check
 * catches bugs and wrong configuration in the backend. It does not catch a hacked backend, because a hacked backend
 * can send a false mirror. The event guard in `transak-webview.ts` covers that case.
 *
 * sessionId probe pending: decode a real staging sessionId; if it is a JWT with walletAddress, also compare it.
 */
import { getAddress, isAddress, isAddressEqual } from 'viem';
import { z } from 'zod';

import { buildVaultEvmWalletClient } from 'lib/epoch/evm-account';

import { buildChallengeMessage } from './transak-message';

export type TransakSessionFailure = 'request-failed' | 'mismatch';

export class TransakSessionError extends Error {
  readonly reason: TransakSessionFailure;

  constructor(reason: TransakSessionFailure, message: string) {
    super(message);
    this.name = 'TransakSessionError';
    this.reason = reason;
  }
}

export interface TransakBuySession {
  widgetUrl: string;
  partnerOrderId: string;
}

export interface CreateTransakBuySessionInput {
  apiUrl: string;
  midenAccountPublicKey: string;
  evmAddress: `0x${string}`;
  /** The Miden account that receives the bridged funds, from `midenAccountIdToHex` in `buy-batch.ts`. */
  midenAccountHex: string;
  fiatAmount: string;
}

const MIDEN_ACCOUNT_HEX = /^0x[0-9a-f]{30}$/;

/** The latest `expiresAt` the wallet accepts, in seconds after now. The backend gives 5 min. */
const MAX_CHALLENGE_TTL_SECONDS = 10 * 60;

const challengeSchema = z.object({
  nonce: z.string().regex(/^[0-9a-f]{32}$/),
  expiresAt: z.number().int(),
  message: z.string()
});

// The params stay loose here. `checkWidgetParams` reads them, so a bad field is a mismatch, not a failed request.
const sessionSchema = z.object({
  widgetUrl: z.string(),
  widgetParams: z.looseObject({})
});

// All fields are optional here: a missing field is a mismatch, not a failed request.
const widgetParamsSchema = z.object({
  walletAddress: z.string().optional(),
  disableWalletAddressForm: z.boolean().optional(),
  fiatAmount: z.number().optional(),
  fiatCurrency: z.string().optional(),
  cryptoCurrencyCode: z.string().optional(),
  network: z.string().optional(),
  productsAvailed: z.string().optional(),
  partnerOrderId: z.string().optional()
});

const errorSchema = z.object({ error: z.string() });

function requestFailed(message: string): TransakSessionError {
  return new TransakSessionError('request-failed', message);
}

function mismatch(message: string): TransakSessionError {
  return new TransakSessionError('mismatch', message);
}

async function postJson<T>(url: string, body: object, schema: z.ZodType<T>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch {
    throw requestFailed('Transak backend is not reachable');
  }

  const json = await response.json().catch(() => {
    throw requestFailed(`Transak backend HTTP ${response.status}`);
  });

  if (!response.ok) {
    const failure = errorSchema.safeParse(json);
    throw requestFailed(failure.success ? failure.data.error : `Transak backend HTTP ${response.status}`);
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw requestFailed('Transak backend sent an invalid response');
  }
  return parsed.data;
}

function isTransakHost(hostname: string): boolean {
  return hostname === 'transak.com' || hostname.endsWith('.transak.com');
}

function checkWidgetUrl(widgetUrl: string): void {
  let url: URL;
  try {
    url = new URL(widgetUrl);
  } catch {
    throw mismatch('Transak widget URL is not valid');
  }
  if (url.protocol !== 'https:' || !isTransakHost(url.hostname)) {
    throw mismatch('Transak widget URL is not on transak.com');
  }
}

function parseWidgetParams(widgetParams: object) {
  const parsed = widgetParamsSchema.safeParse(widgetParams);
  if (!parsed.success) {
    throw mismatch('Transak widget params have a wrong type');
  }
  return parsed.data;
}

function checkWidgetParams(
  widgetParams: object,
  expected: { evmAddress: `0x${string}`; fiatAmount: string; nonce: string }
): void {
  const params = parseWidgetParams(widgetParams);

  const walletAddress = params.walletAddress;
  const walletMatches =
    walletAddress !== undefined && isAddress(walletAddress) && isAddressEqual(walletAddress, expected.evmAddress);

  const checks: readonly [string, boolean][] = [
    ['walletAddress', walletMatches],
    ['disableWalletAddressForm', params.disableWalletAddressForm === true],
    ['fiatAmount', params.fiatAmount === Number(expected.fiatAmount)],
    ['fiatCurrency', params.fiatCurrency === 'USD'],
    ['cryptoCurrencyCode', params.cryptoCurrencyCode === 'USDC'],
    ['network', params.network === 'ethereum'],
    ['productsAvailed', params.productsAvailed === 'BUY'],
    ['partnerOrderId', params.partnerOrderId === expected.nonce]
  ];
  const failed = checks.find(([, ok]) => !ok);
  if (failed) {
    throw mismatch(`Transak widget param ${failed[0]} does not match`);
  }
}

export async function createTransakBuySession(input: CreateTransakBuySessionInput): Promise<TransakBuySession> {
  const baseUrl = input.apiUrl.replace(/\/$/, '');
  const address = getAddress(input.evmAddress);
  const midenAccountHex = input.midenAccountHex.toLowerCase();
  if (!MIDEN_ACCOUNT_HEX.test(midenAccountHex)) {
    throw requestFailed('Miden account ID is not valid');
  }

  const challenge = await postJson(
    `${baseUrl}/transak/challenge`,
    { evmAddress: address, midenAccountHex, fiatAmount: input.fiatAmount },
    challengeSchema
  );

  // Sign only text that names this wallet, this Miden account and this amount.
  const expectedMessage = buildChallengeMessage({
    fiatAmount: input.fiatAmount,
    address,
    midenAccountHex,
    nonce: challenge.nonce,
    expiresAt: challenge.expiresAt
  });
  if (challenge.message !== expectedMessage) {
    throw mismatch('Transak challenge message does not match');
  }
  const now = Math.floor(Date.now() / 1000);
  if (challenge.expiresAt <= now || challenge.expiresAt > now + MAX_CHALLENGE_TTL_SECONDS) {
    throw mismatch('Transak challenge expiry is not valid');
  }

  const client = buildVaultEvmWalletClient(input.midenAccountPublicKey, address);
  if (!client.account) {
    throw requestFailed('EVM signing account unavailable');
  }
  const signature = await client.signMessage({ account: client.account, message: expectedMessage });

  const session = await postJson(`${baseUrl}/transak/session`, { nonce: challenge.nonce, signature }, sessionSchema);

  checkWidgetUrl(session.widgetUrl);
  checkWidgetParams(session.widgetParams, {
    evmAddress: address,
    fiatAmount: input.fiatAmount,
    nonce: challenge.nonce
  });

  return { widgetUrl: session.widgetUrl, partnerOrderId: challenge.nonce };
}
