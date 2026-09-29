import { z } from 'zod';

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
}

const envSchema = z.object({
  TRANSAK_API_KEY: z.string().trim().min(1),
  TRANSAK_API_SECRET: z.string().trim().min(1),
  TRANSAK_ENV: z.enum(['staging', 'production']).default('staging'),
  // A native app sends its bundle ID or package name, not a web domain.
  TRANSAK_REFERRER_DOMAIN: z.string().trim().min(1).default('com.miden.bread'),
  PORT: z.coerce.number().int().min(0).max(65535).default(8787),
  ALLOWED_ORIGINS: z.string().trim().default(''),
  MAX_FIAT_AMOUNT_USD: z.coerce.number().positive().default(10000)
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
    maxFiatAmountUsd: parsed.MAX_FIAT_AMOUNT_USD
  };
}
