import { verifyMessage } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { notConfigured } from './errors';
import type { Hex } from './parse';
import { relayerAddress } from './secrets';
import type { Env } from './types';

/** A fee quote for one account and one Calibur batch nonce. */
interface FeeQuoteTerms {
  chainId: number;
  evmAddress: Hex;
  batchNonce: bigint;
  token: Hex;
  recipient: Hex;
  amount: bigint;
  gas: bigint;
  validUntil: number;
}

function quoteMessage(terms: FeeQuoteTerms): string {
  return JSON.stringify([
    'miden.evm-relay.fee-quote.v1',
    terms.chainId,
    terms.evmAddress.toLowerCase(),
    terms.batchNonce.toString(),
    terms.token.toLowerCase(),
    terms.recipient.toLowerCase(),
    terms.amount.toString(),
    terms.gas.toString(),
    terms.validUntil
  ]);
}

/** Sign the terms so any Worker instance can check them until the quote expires. */
export async function signFeeQuote(env: Env, terms: FeeQuoteTerms): Promise<Hex> {
  const key = env.RELAYER_PRIVATE_KEY;
  if (key === undefined || relayerAddress(env) === null) throw notConfigured();
  return privateKeyToAccount(`0x${key.slice(2)}`).signMessage({ message: quoteMessage(terms) });
}

export async function verifyFeeQuote(relayer: Hex, terms: FeeQuoteTerms, signature: Hex): Promise<boolean> {
  try {
    return await verifyMessage({ address: relayer, message: quoteMessage(terms), signature });
  } catch {
    return false;
  }
}
