import { Router } from 'express';
import { getAddress, isAddress, type Hex } from 'viem';
import { z } from 'zod';

import { clientIp } from './client-ip.js';
import { HttpError } from './errors.js';
import { createRateLimit } from './rate-limit.js';
import type { AppDeps } from '../app.js';
import { errorText, logEvent } from '../log.js';
import { MIDEN_ACCOUNT_HEX_PATTERN } from '../miden-account.js';
import { ChallengeStore, verifyChallenge } from '../transak/challenge.js';
import { buildWidgetParams } from '../transak/client.js';

const FIAT_AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;
/** The challenge nonce. It is also the order ID. */
export const NONCE_PATTERN = /^[0-9a-f]{32}$/;
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
      .refine(value => Number(value) <= maxFiatAmountUsd, `fiatAmount must be at most ${maxFiatAmountUsd}`),
    midenAccountHex: z
      .string()
      .regex(MIDEN_ACCOUNT_HEX_PATTERN, 'midenAccountHex must be 0x and 30 hex characters')
      .transform(value => value.toLowerCase())
  });
}

const sessionBodySchema = z.object({
  nonce: z.string().regex(NONCE_PATTERN, 'nonce is not valid'),
  signature: signatureSchema
});

export type TransakRoutesDeps = Pick<
  AppDeps,
  'config' | 'transak' | 'resolveUserIp' | 'orders' | 'now' | 'onOrderCreated'
>;

/** `POST /transak/challenge` and `POST /transak/session`. Mount at `/transak`. */
export function createTransakRouter({
  config,
  transak,
  resolveUserIp,
  orders,
  now,
  onOrderCreated
}: TransakRoutesDeps): Router {
  const challenges = new ChallengeStore(now);
  const challengeSchema = challengeBodySchema(config.maxFiatAmountUsd);
  const rateLimit = () => createRateLimit({ capacity: 10, refillPerMinute: 10, now });
  const router = Router();

  router.post('/challenge', rateLimit(), async (req, res) => {
    const body = challengeSchema.parse(req.body);
    const address = getAddress(body.evmAddress);
    res.json(challenges.issue(address, body.fiatAmount, body.midenAccountHex));
  });

  router.post('/session', rateLimit(), async (req, res) => {
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
    // The worker tracks the order from now on. This also cancels an earlier open order of the address.
    orders.createCheckout({
      id: nonce,
      evmAddress: entry.address,
      midenAccountHex: entry.midenAccountHex,
      fiatAmount: entry.fiatAmount,
      tokenAddress: config.onrampTokenAddress,
      tokenDecimals: config.onrampTokenDecimals
    });
    try {
      onOrderCreated(nonce);
    } catch (error) {
      // The order is stored. The next worker tick watches and advances it.
      logEvent('warn', 'order_created_hook_failed', { orderId: nonce, error: errorText(error) });
    }
    res.json({ widgetUrl, widgetParams });
  });

  return router;
}
