import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';

/** The Transak Pusher app. Transak publishes these values in its WebSocket docs. */
export const DEFAULT_TRANSAK_PUSHER_KEY = '1d9ffac87de599c61283';
export const DEFAULT_TRANSAK_PUSHER_CLUSTER = 'ap2';

export type TransakEnv = 'staging' | 'production';

/** '*' allows all origins. A list allows only the origins in it. */
export type AllowedOrigins = '*' | readonly string[];

export interface Config {
  transakApiKey: string;
  transakApiSecret: string;
  transakEnv: TransakEnv;
  referrerDomain: string;
  port: number;
  allowedOrigins: AllowedOrigins;
  maxFiatAmountUsd: number;
  /** The key of the account that pays gas for the relayed bridge batch. */
  relayerPrivateKey: Hex;
  sepoliaRpcUrl: string;
  /** The ERC-20 that Transak delivers on Sepolia. */
  onrampTokenAddress: Address;
  onrampTokenDecimals: number;
  dbPath: string;
  workerIntervalMs: number;
  /** The Pusher app of the Transak order feed. */
  transakPusherKey: string;
  transakPusherCluster: string;
  /** The minimum time between two Transak API calls for one order, when no feed event comes. */
  transakPollIntervalMs: number;
}

/** Transak staging delivers TRNSK on Sepolia for a "USDC on ethereum" buy. */
export const DEFAULT_ONRAMP_TOKEN_ADDRESS: Address = '0x0c86a754a29714c4fe9c6f1359fa7099ed174c0b';

const privateKeySchema = z.custom<Hex>(
  value => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value),
  'RELAYER_PRIVATE_KEY must be a 32-byte hex key with 0x'
);

const addressSchema = z.custom<Address>(value => typeof value === 'string' && isAddress(value), 'not an EVM address');

const envSchema = z.object({
  TRANSAK_API_KEY: z.string().trim().min(1),
  TRANSAK_API_SECRET: z.string().trim().min(1),
  TRANSAK_ENV: z.enum(['staging', 'production']).default('staging'),
  // A native app sends its bundle ID or package name, not a web domain.
  TRANSAK_REFERRER_DOMAIN: z.string().trim().min(1).default('com.miden.bread'),
  PORT: z.coerce.number().int().min(0).max(65535).default(8787),
  ALLOWED_ORIGINS: z.string().trim().default(''),
  MAX_FIAT_AMOUNT_USD: z.coerce.number().positive().default(10000),
  RELAYER_PRIVATE_KEY: privateKeySchema,
  SEPOLIA_RPC_URL: z.url().default('https://ethereum-sepolia-rpc.publicnode.com'),
  ONRAMP_TOKEN_ADDRESS: addressSchema.default(DEFAULT_ONRAMP_TOKEN_ADDRESS),
  ONRAMP_TOKEN_DECIMALS: z.coerce.number().int().min(0).max(36).default(18),
  DB_PATH: z.string().trim().min(1).default('./data/onramp.sqlite'),
  WORKER_INTERVAL_MS: z.coerce.number().int().min(1000).default(10000),
  TRANSAK_PUSHER_KEY: z.string().trim().min(1).default(DEFAULT_TRANSAK_PUSHER_KEY),
  TRANSAK_PUSHER_CLUSTER: z.string().trim().min(1).default(DEFAULT_TRANSAK_PUSHER_CLUSTER),
  TRANSAK_POLL_INTERVAL_MS: z.coerce.number().int().min(10000).default(60000)
});

/** An empty list allows all origins. */
function parseAllowedOrigins(raw: string): AllowedOrigins {
  const origins = raw
    .split(',')
    .map(origin => origin.trim())
    .filter(origin => origin.length > 0);
  return origins.length > 0 ? origins : '*';
}

/** Parse the environment. Throw at start when a value is missing or not valid. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  // An empty value is the same as an unset value, so the defaults apply.
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value !== ''));
  const parsed = envSchema.parse(present);
  return {
    transakApiKey: parsed.TRANSAK_API_KEY,
    transakApiSecret: parsed.TRANSAK_API_SECRET,
    transakEnv: parsed.TRANSAK_ENV,
    referrerDomain: parsed.TRANSAK_REFERRER_DOMAIN,
    port: parsed.PORT,
    allowedOrigins: parseAllowedOrigins(parsed.ALLOWED_ORIGINS),
    maxFiatAmountUsd: parsed.MAX_FIAT_AMOUNT_USD,
    relayerPrivateKey: parsed.RELAYER_PRIVATE_KEY,
    sepoliaRpcUrl: parsed.SEPOLIA_RPC_URL,
    onrampTokenAddress: getAddress(parsed.ONRAMP_TOKEN_ADDRESS),
    onrampTokenDecimals: parsed.ONRAMP_TOKEN_DECIMALS,
    dbPath: parsed.DB_PATH,
    workerIntervalMs: parsed.WORKER_INTERVAL_MS,
    transakPusherKey: parsed.TRANSAK_PUSHER_KEY,
    transakPusherCluster: parsed.TRANSAK_PUSHER_CLUSTER,
    transakPollIntervalMs: parsed.TRANSAK_POLL_INTERVAL_MS
  };
}
