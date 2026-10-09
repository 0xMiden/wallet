import { Router } from 'express';
import { getAddress, isAddress, type Hex } from 'viem';
import { z } from 'zod';

import { clientIp } from './client-ip.js';
import { HttpError } from './errors.js';
import type { AppDeps } from '../app.js';
import { errorText, logEvent } from '../log.js';
import { MIDEN_ACCOUNT_HEX_PATTERN } from '../miden-account.js';
import { type ChallengeEntry, type ChallengeSide, ChallengeStore, verifyChallenge } from '../transak/challenge.js';
import { buildSellWidgetParams, buildWidgetParams } from '../transak/client.js';

const FIAT_AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;
/** USDCx has 6 decimals. */
const CRYPTO_AMOUNT_PATTERN = /^\d+(\.\d{1,6})?$/;
/** The challenge nonce. It is also the order ID. */
export const NONCE_PATTERN = /^[0-9a-f]{32}$/;
const SIGNATURE_PATTERN = /^0x[0-9a-fA-F]+$/;

const signatureSchema = z.custom<Hex>(
  value => typeof value === 'string' && SIGNATURE_PATTERN.test(value),
  'signature is not valid'
);

const evmAddressSchema = z.string().refine(value => isAddress(value), 'evmAddress is not a valid EVM address');
const midenAccountHexSchema = z
  .string()
  .regex(MIDEN_ACCOUNT_HEX_PATTERN, 'midenAccountHex must be 0x and 30 hex characters')
  .transform(value => value.toLowerCase());

function amountSchema(field: string, pattern: RegExp, decimals: number, max: number) {
  return z
    .string()
    .regex(pattern, `${field} must be a decimal string with at most ${decimals} decimals`)
    .refine(value => Number(value) > 0, `${field} must be more than 0`)
    .refine(value => Number(value) <= max, `${field} must be at most ${max}`);
}

function challengeBodySchema(maxFiatAmountUsd: number) {
  return z.object({
    evmAddress: evmAddressSchema,
    fiatAmount: amountSchema('fiatAmount', FIAT_AMOUNT_PATTERN, 2, maxFiatAmountUsd),
    midenAccountHex: midenAccountHexSchema
  });
}

/** A sell is capped by the same USD limit as a buy: USDCx is sold as USDC, one to one. */
function sellChallengeBodySchema(maxFiatAmountUsd: number) {
  return z.object({
    evmAddress: evmAddressSchema,
    cryptoAmount: amountSchema('cryptoAmount', CRYPTO_AMOUNT_PATTERN, 6, maxFiatAmountUsd),
    midenAccountHex: midenAccountHexSchema
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

/**
 * `POST /transak/challenge` and `POST /transak/session` open a buy. `POST /transak/sell/challenge` and
 * `POST /transak/sell/session` open a sell. Mount at `/transak`.
 */
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
  const sellChallengeSchema = sellChallengeBodySchema(config.maxFiatAmountUsd);
  const router = Router();

  /** Take the challenge of `nonce` and check its signature. A nonce is single use even when the check fails. */
  async function takeVerified(side: ChallengeSide, body: unknown): Promise<{ nonce: string; entry: ChallengeEntry }> {
    const { nonce, signature } = sessionBodySchema.parse(body);
    const entry = challenges.take(nonce);
    // A nonce issued for the other side is burned too: it is taken and never usable again.
    if (entry === null || entry.side !== side) {
      throw new HttpError(401, 'Challenge is missing or expired');
    }
    if (!(await verifyChallenge(entry, nonce, signature))) {
      throw new HttpError(401, 'Signature is not valid');
    }
    return { nonce, entry };
  }

  /**
   * Store the order the session opened. The worker tracks it from now on. This also cancels an earlier open order
   * of the address and side.
   */
  function storeOrder(side: ChallengeSide, nonce: string, entry: ChallengeEntry): void {
    orders.createCheckout({
      id: nonce,
      side,
      evmAddress: entry.address,
      midenAccountHex: entry.midenAccountHex,
      amount: entry.amount
    });
    try {
      onOrderCreated(nonce);
    } catch (error) {
      // The order is stored. The next worker tick watches and advances it.
      logEvent('warn', 'order_created_hook_failed', { orderId: nonce, error: errorText(error) });
    }
  }

  router.post('/challenge', async (req, res) => {
    const body = challengeSchema.parse(req.body);
    const address = getAddress(body.evmAddress);
    res.json(challenges.issue('buy', address, body.fiatAmount, body.midenAccountHex));
  });

  router.post('/session', async (req, res) => {
    const { nonce, entry } = await takeVerified('buy', req.body);
    // Build the params once. The same object goes to Transak and back to the wallet.
    const widgetParams = buildWidgetParams({
      referrerDomain: config.referrerDomain,
      walletAddress: entry.address,
      fiatAmount: entry.amount,
      partnerOrderId: nonce
    });
    const userIp = await resolveUserIp(clientIp(req));
    const widgetUrl = await transak.createWidgetSession(widgetParams, userIp);
    storeOrder('buy', nonce, entry);
    res.json({ widgetUrl, widgetParams });
  });

  router.post('/sell/challenge', async (req, res) => {
    const body = sellChallengeSchema.parse(req.body);
    const address = getAddress(body.evmAddress);
    res.json(challenges.issue('sell', address, body.cryptoAmount, body.midenAccountHex));
  });

  // A sell session opens the widget and stores a sell order. The worker follows it on the Transak API, and relays
  // the released token to Transak's deposit address once the wallet signed the transfer.
  router.post('/sell/session', async (req, res) => {
    const { nonce, entry } = await takeVerified('sell', req.body);
    const widgetParams = buildSellWidgetParams({
      referrerDomain: config.referrerDomain,
      walletAddress: entry.address,
      cryptoAmount: entry.amount,
      partnerOrderId: nonce
    });
    const userIp = await resolveUserIp(clientIp(req));
    const widgetUrl = await transak.createWidgetSession(widgetParams, userIp);
    storeOrder('sell', nonce, entry);
    res.json({ widgetUrl, widgetParams });
  });

  return router;
}
