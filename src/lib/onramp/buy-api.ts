/**
 * Client for the buy order routes of the wallet backend. Every response goes through a zod schema, so the callers
 * read typed values only. The schemas check the shape. `buy-signer.ts` checks the values before it signs.
 */
import { isAddress, isHex, type Address, type Hex } from 'viem';
import { z } from 'zod';

const REQUEST_TIMEOUT_MS = 15_000;

export class BuyApiError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'BuyApiError';
    this.status = status;
  }
}

const addressSchema = z.custom<Address>(value => typeof value === 'string' && isAddress(value, { strict: false }));
const hexSchema = (bytes: number) =>
  z.custom<Hex>(value => typeof value === 'string' && isHex(value, { strict: true }) && value.length === 2 + bytes * 2);
const baseUnitsSchema = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);

/**
 * `deposited` is terminal on the backend: the relay transaction (approve and `bridgeAsset`) is mined. The wallet then
 * follows the Agglayer bridge itself.
 */
const stateSchema = z.enum([
  'checkout',
  'awaiting_signature',
  'signed',
  'relay_sent',
  'deposited',
  'failed',
  'expired',
  'cancelled'
]);

export type BuyOrderState = z.infer<typeof stateSchema>;

const prepareSchema = z.object({
  chainId: z.number().int(),
  calibur: addressSchema,
  evmAddress: addressSchema,
  midenAccountHex: z.string(),
  executor: addressSchema,
  batchNonce: baseUnitsSchema,
  salt: hexSchema(32),
  deadline: z.number().int(),
  needsAuthorization: z.boolean(),
  authorizationNonce: z.number().int().min(0),
  tokenAmount: baseUnitsSchema
});

export type BuyOrderPrepare = z.infer<typeof prepareSchema>;

const orderSchema = z.object({
  id: z.string(),
  state: stateSchema,
  transakStatus: z.string().nullable(),
  tokenAddress: addressSchema,
  tokenDecimals: z.number().int().min(0).max(36),
  tokenAmount: baseUnitsSchema.nullable(),
  relayTxHash: hexSchema(32).nullable(),
  error: z.string().nullable(),
  prepare: prepareSchema.nullable()
});

export type BuyOrder = z.infer<typeof orderSchema>;

const signatureResponseSchema = z.object({ state: stateSchema });

const errorSchema = z.object({ error: z.string() });

export interface BuyAuthorization {
  address: Address;
  chainId: number;
  nonce: number;
  r: Hex;
  s: Hex;
  yParity: number;
}

export interface BuySignatureBody {
  batchNonce: string;
  salt: Hex;
  deadline: number;
  tokenAmount: string;
  signature: Hex;
  authorization?: BuyAuthorization;
}

/** The backend base URL, from the same build variable as the Transak checkout. Empty when it is not set. */
export function buyBackendUrl(): string {
  return (process.env.BACKEND_URL ?? '').replace(/\/$/, '');
}

function orderUrl(orderId: string, suffix = ''): string {
  const baseUrl = buyBackendUrl();
  if (!baseUrl) throw new BuyApiError('Buy backend URL is not set');
  return `${baseUrl}/orders/${encodeURIComponent(orderId)}${suffix}`;
}

async function requestJson<T>(url: string, init: RequestInit, schema: z.ZodType<T>): Promise<T> {
  // A plain controller and timer, because older WebViews do not have `AbortSignal.timeout`.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: controller.signal });
  } catch {
    throw new BuyApiError('Buy backend is not reachable');
  } finally {
    clearTimeout(timer);
  }
  const json = await response.json().catch(() => {
    throw new BuyApiError(`Buy backend HTTP ${response.status}`, response.status);
  });
  if (!response.ok) {
    const failure = errorSchema.safeParse(json);
    throw new BuyApiError(
      failure.success ? failure.data.error : `Buy backend HTTP ${response.status}`,
      response.status
    );
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new BuyApiError('Buy backend sent an invalid response', response.status);
  return parsed.data;
}

export function getBuyOrder(orderId: string): Promise<BuyOrder> {
  return requestJson(orderUrl(orderId), { method: 'GET' }, orderSchema);
}

export function postBuySignature(orderId: string, body: BuySignatureBody): Promise<{ state: BuyOrderState }> {
  return requestJson(
    orderUrl(orderId, '/signature'),
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    signatureResponseSchema
  );
}
