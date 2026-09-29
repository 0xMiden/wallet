import express, { type ErrorRequestHandler, type Express, type Request, type RequestHandler } from 'express';
import { getAddress, isAddress, type Hex } from 'viem';
import { z } from 'zod';

import { ChallengeStore, verifyChallenge } from './challenge.js';
import type { Config } from './config.js';
import { createRateLimit } from './rate-limit.js';
import { buildWidgetParams, TransakError, type TransakClient } from './transak.js';
import type { UserIpResolver } from './user-ip.js';

export interface AppDeps {
  config: Pick<Config, 'referrerDomain' | 'allowedOrigins' | 'maxFiatAmountUsd'>;
  transak: TransakClient;
  /** Maps the caller IP to the IP that Transak pins the session to. */
  resolveUserIp: UserIpResolver;
  /** Returns the time in milliseconds. */
  now: () => number;
}

/** An error with a fixed HTTP status and a message that is safe to send to the client. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

const FIAT_AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;
const NONCE_PATTERN = /^[0-9a-f]{32}$/;
const SIGNATURE_PATTERN = /^0x[0-9a-fA-F]+$/;

const signatureSchema = z.custom<Hex>(
  value => typeof value === 'string' && SIGNATURE_PATTERN.test(value),
  'signature is not valid'
);

function challengeBodySchema(maxFiatAmountUsd: number) {
  return z.object({
    evmAddress: z.string().refine(value => isAddress(value), 'evmAddress is not a valid EVM address'),
    fiatAmount: z
      .string()
      .regex(FIAT_AMOUNT_PATTERN, 'fiatAmount must be a decimal string with at most 2 decimals')
      .refine(value => Number(value) > 0, 'fiatAmount must be more than 0')
      .refine(value => Number(value) <= maxFiatAmountUsd, `fiatAmount must be at most ${maxFiatAmountUsd}`)
  });
}

const sessionBodySchema = z.object({
  nonce: z.string().regex(NONCE_PATTERN, 'nonce is not valid'),
  signature: signatureSchema
});

function isBodyParserError(error: unknown): error is { status: number; type: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number' &&
    'type' in error &&
    typeof error.type === 'string'
  );
}

function describeError(error: unknown): { status: number; message: string } {
  switch (true) {
    case error instanceof z.ZodError:
      return { status: 400, message: error.issues.map(issue => issue.message).join('; ') };
    case error instanceof HttpError:
      return { status: error.status, message: error.message };
    case error instanceof TransakError:
      console.error(`[transak] ${error.detail}`);
      return { status: 502, message: 'Checkout provider is not available. Try again later.' };
    case isBodyParserError(error) && error.status >= 400 && error.status < 500:
      return { status: error.status, message: 'Request body is not valid' };
    default:
      console.error('[server] Unexpected error', error);
      return { status: 500, message: 'Internal error' };
  }
}

/** The IP of the caller, with the IPv4-mapped IPv6 prefix removed. Behind a proxy, set `trust proxy`. */
function clientIp(req: Request): string {
  const ip = req.ip ?? req.socket.remoteAddress;
  if (ip === undefined) {
    throw new HttpError(400, 'Client IP is not known');
  }
  return ip.replace(/^::ffff:/, '');
}

function cors(allowedOrigins: Config['allowedOrigins']): RequestHandler {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (allowedOrigins === '*') {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else {
      res.setHeader('Vary', 'Origin');
      if (origin !== undefined && allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
      }
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  };
}

export function createApp({ config, transak, resolveUserIp, now }: AppDeps): Express {
  const challenges = new ChallengeStore(now);
  const challengeSchema = challengeBodySchema(config.maxFiatAmountUsd);
  const rateLimit = () => createRateLimit({ capacity: 10, refillPerMinute: 10, now });

  const app = express();
  app.disable('x-powered-by');
  app.use(cors(config.allowedOrigins));
  app.use(express.json({ limit: '8kb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.post('/transak/challenge', rateLimit(), async (req, res) => {
    const body = challengeSchema.parse(req.body);
    const address = getAddress(body.evmAddress);
    res.json(challenges.issue(address, body.fiatAmount));
  });

  app.post('/transak/session', rateLimit(), async (req, res) => {
    const { nonce, signature } = sessionBodySchema.parse(req.body);
    // Take the entry first, so a nonce is single use even when the check fails.
    const entry = challenges.take(nonce);
    if (entry === null) {
      throw new HttpError(401, 'Challenge is missing or expired');
    }
    if (!(await verifyChallenge(entry, nonce, signature))) {
      throw new HttpError(401, 'Signature is not valid');
    }
    // Build the params once. The same object goes to Transak and back to the wallet.
    const widgetParams = buildWidgetParams({
      referrerDomain: config.referrerDomain,
      walletAddress: entry.address,
      fiatAmount: entry.fiatAmount,
      partnerOrderId: nonce
    });
    const userIp = await resolveUserIp(clientIp(req));
    const widgetUrl = await transak.createWidgetSession(widgetParams, userIp);
    res.json({ widgetUrl, widgetParams });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  const onError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    const { status, message } = describeError(error);
    res.status(status).json({ error: message });
  };
  app.use(onError);

  return app;
}
