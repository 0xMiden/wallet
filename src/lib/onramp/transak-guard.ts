/**
 * Check the events that the Transak widget sends against the values the wallet expects.
 *
 * A hacked backend can create a Transak session for the address of an attacker, and it can fake every check that
 * goes through it. The widget events come from a `*.transak.com` page that the backend cannot touch, so the wallet
 * checks them. Field names come from the Transak order payload (webhook and websocket docs): `id`, `walletAddress`,
 * `status`, `fiatCurrency`, `cryptoCurrency`, `isBuyOrSell`, `fiatAmount`, `cryptoAmount`, `network`,
 * `partnerOrderId`.
 */
import { isAddress, isAddressEqual } from 'viem';
import { z } from 'zod';

export const TRANSAK_ORDER_CREATED = 'TRANSAK_ORDER_CREATED';

export interface TransakEventData {
  walletAddress?: string;
  fiatAmount?: number;
  fiatCurrency?: string;
  cryptoCurrency?: string;
  cryptoCurrencyCode?: string;
  network?: string;
  partnerOrderId?: string;
  /** Some events put the order object under `status`. The guard checks it too. */
  order?: TransakEventData;
}

export interface TransakEvent {
  eventName: string;
  data: TransakEventData | null;
}

export interface TransakExpectation {
  evmAddress: `0x${string}`;
  fiatAmount: string;
}

/** What the WebView bridge can deliver: a JSON string or an object. */
export type TransakBridgePayload = string | object | null | undefined;

const isStringOrObject = (value: string | object | null | undefined): value is string | object =>
  typeof value === 'string' || (typeof value === 'object' && value !== null);

const isObject = (value: string | object | null | undefined): value is object =>
  typeof value === 'object' && value !== null;

const wrapperSchema = z.object({ transak: z.union([z.string(), z.looseObject({})]) });

// Data that is not an object becomes null.
const envelopeSchema = z.object({
  eventName: z.string().optional(),
  event_id: z.string().optional(),
  data: z.looseObject({}).nullable().optional().catch(null)
});

// A number or a numeric string, as the order payload can send either.
const numericStringSchema = z.string().regex(/^\d+(\.\d+)?$/);
const amountSchema = z.union([z.number(), numericStringSchema.transform(Number)]);

const orderSchema = z.object({
  walletAddress: z.string().optional(),
  fiatAmount: amountSchema.optional(),
  fiatCurrency: z.string().optional(),
  cryptoCurrency: z.string().optional(),
  cryptoCurrencyCode: z.string().optional(),
  network: z.string().optional(),
  partnerOrderId: z.string().optional()
});

const statusSchema = z.object({ status: z.looseObject({}) });

function parseOrder(value: object): TransakEventData | null {
  const parsed = orderSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseNestedOrder(value: object): TransakEventData | null {
  const parsed = statusSchema.safeParse(value);
  return parsed.success ? parseOrder(parsed.data.status) : null;
}

function parseData(value: object): TransakEventData | null {
  const data = parseOrder(value);
  if (data === null) return null;
  // A nested order that does not parse is dropped; the checks on the outer object still run.
  const order = parseNestedOrder(value);
  return order === null ? data : { ...data, order };
}

function parseJson(raw: string): object | null {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

function parseEnvelope(raw: string | object): TransakEvent | null {
  const value = typeof raw === 'string' ? parseJson(raw) : raw;
  if (value === null) return null;
  const parsed = envelopeSchema.safeParse(value);
  if (!parsed.success) return null;
  const { eventName = parsed.data.event_id, data } = parsed.data;
  if (eventName === undefined || !eventName.startsWith('TRANSAK_')) return null;
  return { eventName, data: data === null || data === undefined ? null : parseData(data) };
}

/**
 * Accept the shapes the Transak widget sends: a JSON string `{ eventName | event_id, data }` (the native bridges
 * `Android.postMessage` and `IosWebview`), an object `{ event_id, data }` (window `postMessage`), and each of them
 * wrapped as `{ transak: … }` (what the injected script forwards). Return null for all other shapes.
 */
export function parseTransakEvent(raw: TransakBridgePayload): TransakEvent | null {
  if (!isStringOrObject(raw)) return null;
  const wrapped = isObject(raw) ? wrapperSchema.safeParse(raw) : null;
  return parseEnvelope(wrapped?.success ? wrapped.data.transak : raw);
}

function sameText(actual: string, expected: string): boolean {
  return actual.toLowerCase() === expected.toLowerCase();
}

function checkOrder(data: TransakEventData, expected: TransakExpectation): 'ok' | 'mismatch' {
  const { walletAddress, fiatAmount, cryptoCurrency, cryptoCurrencyCode, network } = data;
  if (walletAddress !== undefined) {
    if (!isAddress(walletAddress, { strict: false })) return 'mismatch';
    if (!isAddressEqual(walletAddress, expected.evmAddress)) return 'mismatch';
  }
  if (fiatAmount !== undefined && fiatAmount !== Number(expected.fiatAmount)) return 'mismatch';
  if (cryptoCurrency !== undefined && !sameText(cryptoCurrency, 'USDC')) return 'mismatch';
  if (cryptoCurrencyCode !== undefined && !sameText(cryptoCurrencyCode, 'USDC')) return 'mismatch';
  if (network !== undefined && !sameText(network, 'ethereum')) return 'mismatch';
  if (data.order !== undefined) return checkOrder(data.order, expected);
  return 'ok';
}

function hasWalletAddress(data: TransakEventData | null): boolean {
  if (data === null) return false;
  return data.walletAddress !== undefined || data.order?.walletAddress !== undefined;
}

export function checkTransakEvent(event: TransakEvent, expected: TransakExpectation): 'ok' | 'mismatch' {
  // The order is created before the user pays, so this event must name the wallet.
  if (event.eventName === TRANSAK_ORDER_CREATED && !hasWalletAddress(event.data)) return 'mismatch';
  if (event.data === null) return 'ok';
  return checkOrder(event.data, expected);
}
