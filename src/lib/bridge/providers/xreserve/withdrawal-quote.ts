// Adapted from bridge-portal@cb52c470 src/bridge/providers/xreserve/withdrawal-quote.server.ts (MIT).
import { formatUnits, isAddress, padHex, parseUnits } from 'viem';

import type { QuoteRequest, QuoteResult } from 'lib/bridge/core/quote';
import { validateTransferAmount } from 'lib/bridge/core/rules';
import { getUsdcxDestination, usdcxSourceChains } from 'lib/usdcx/constant';
import { usdcxExpectedRemoteTokenFor, usdcxRemoteRecipientFor } from 'lib/usdcx/deposit-target';

import { field, unsignedDecimal } from './cctp-schema';
import { postCircleJson } from './circle-http';

/** Estimate only: no Circle-returned script, intent or signature is passed to native signing. */
export async function quoteXReserveWithdrawal(request: QuoteRequest): Promise<QuoteResult> {
  const { route, amount, midenAccount, evmAddress } = request;
  validateTransferAmount(route, amount);
  const chain = route.recovery.config.supportedEvmChains[route.destination.network];
  const sources = [...usdcxSourceChains().values()].filter(source => source.route === 'xreserve');
  const arc = sources.length === 1 ? sources[0] : undefined;
  if (
    route.provider !== 'xreserve' ||
    route.mode !== 'send' ||
    route.source.kind !== 'miden' ||
    route.destination.kind !== 'erc20' ||
    !chain ||
    !arc ||
    arc.route !== 'xreserve' ||
    !isAddress(evmAddress)
  )
    throw new Error('Circle withdrawal route unavailable');
  const target = getUsdcxDestination(chain.chainId);
  const value = parseUnits(amount, 6);
  const recipient = padHex(evmAddress, { size: 32 }).toLowerCase();
  const token = padHex(target.usdc, { size: 32 }).toLowerCase();
  const depositor = usdcxRemoteRecipientFor(midenAccount).toLowerCase();
  const body = await postCircleJson(`${arc.attestationApi}/v1/prepare-withdrawal`, {
    batches: [
      {
        token: 'USDC',
        remoteDomain: arc.midenDomain,
        remoteDepositor: depositor,
        finalDestinationDomain: target.domain,
        finalDestinationRecipient: recipient,
        valueIncludingFees: formatUnits(value, 6),
        useCircleForwarding: true,
        forwardingOptions: { maxFee: '0.300000', usesFastFinality: true }
      }
    ]
  });
  const batches = field(body, 'batches');
  const intents = Array.isArray(batches) && batches.length === 1 ? field(batches[0], 'burnIntents') : undefined;
  const intent: unknown = Array.isArray(intents) && intents.length === 1 ? intents[0] : undefined;
  const spec = field(intent, 'spec');
  const hook = field(spec, 'hookData');
  const fee = field(intent, 'maxFee');
  const payout = field(spec, 'value');
  const matches = (candidate: unknown, expected: string) =>
    typeof candidate === 'string' && candidate.toLowerCase() === expected;
  if (
    field(spec, 'version') !== 1 ||
    field(spec, 'sourceDomain') !== arc.domain ||
    field(spec, 'destinationDomain') !== target.domain ||
    !matches(field(spec, 'destinationRecipient'), recipient) ||
    !matches(field(spec, 'destinationToken'), token) ||
    field(hook, 'remoteDomain') !== arc.midenDomain ||
    !matches(field(hook, 'remoteDepositor'), depositor) ||
    !matches(field(hook, 'remoteToken'), usdcxExpectedRemoteTokenFor(route.source.faucetId).toLowerCase()) ||
    !matches(field(hook, 'forwardingContractAddress'), '0x0000000000000000000000000000000000000000') ||
    field(hook, 'forwardingCalldata') !== '0x' ||
    !unsignedDecimal(fee) ||
    !unsignedDecimal(payout) ||
    BigInt(payout) <= 0n ||
    BigInt(payout) + BigInt(fee) !== value
  )
    throw new Error('Circle withdrawal quote terms changed');
  return {
    kind: 'withdrawal',
    fee: formatUnits(BigInt(fee), 6),
    received: formatUnits(BigInt(payout), 6),
    validity: { kind: 'time', expiresAt: Date.now() + 60000 }
  };
}
