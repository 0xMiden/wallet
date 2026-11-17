// Adapted from bridge-portal@cb52c470 src/bridge/providers/xreserve/{deposit-quote,cctp-quote}.ts (MIT).
import { formatUnits } from 'viem';

import { isBridgeRouteAvailable } from 'lib/bridge/core/provider';
import type { QuoteRequest, QuoteResult } from 'lib/bridge/core/quote';
import { configKey, routeMatchesRecovery } from 'lib/bridge/core/routes';
import { validateTransferAmount } from 'lib/bridge/core/rules';
import { captureBridgeWalletScope } from 'lib/bridge/operation';
import { getBridgeConfigSnapshot } from 'lib/remote-config/runtime';
import { getUsdcxSourceChain } from 'lib/usdcx/constant';
import { usdcxRemoteRecipientFor } from 'lib/usdcx/deposit-target';
import { buildExecutorBurnIntent, quoteExecutorBurn } from 'lib/usdcx/executor';

import { assertXReserveRouteAvailable } from './deposit-preflight';
import { parseArcAmount } from './deposit-terms';
import { xreserveReadClient } from './provider';
import { quoteXReserveWithdrawal } from './withdrawal-quote';

export async function quoteXReserve(request: QuoteRequest, signal: AbortSignal): Promise<QuoteResult | null> {
  request = structuredClone(request);
  const originalScope = captureBridgeWalletScope();
  const { route, amount, midenAccount, evmAddress } = request;
  const assertCurrent = () => {
    signal.throwIfAborted();
    validateTransferAmount(route, amount);
    const current = getBridgeConfigSnapshot();
    if (
      route.provider !== 'xreserve' ||
      !isBridgeRouteAvailable(route) ||
      !routeMatchesRecovery(route) ||
      current.status !== 'ready' ||
      configKey(originalScope) !== configKey(captureBridgeWalletScope()) ||
      configKey([current.network, current.config, current.derived]) !==
        configKey([route.recovery.network, route.recovery.config, route.recovery.derived])
    )
      throw new Error('Circle quote terms changed');
  };
  assertCurrent();
  parseArcAmount(amount);
  let result: QuoteResult;
  if (route.mode === 'send') result = await quoteXReserveWithdrawal(request);
  else {
    const chain = route.recovery.config.supportedEvmChains[route.source.network];
    if (!chain) throw new Error('Circle source unavailable');
    const source = getUsdcxSourceChain(chain.chainId);
    const recipient = usdcxRemoteRecipientFor(midenAccount);
    if (route.destination.kind !== 'miden') throw new Error('Circle native destination unavailable');
    const target = source.route === 'xreserve' ? source : source.target;
    await assertXReserveRouteAvailable(xreserveReadClient(target.chain.id), source, route.destination.faucetId);
    assertCurrent();
    if (source.route === 'xreserve')
      result = {
        kind: 'arc-deposit',
        received: amount.trim(),
        validity: { kind: 'time', expiresAt: Date.now() + 60000 }
      };
    else {
      if (!source.tokenMessenger) throw new Error('Circle source messenger unavailable');
      const authorization = await quoteExecutorBurn(
        source,
        buildExecutorBurnIntent(amount, source, recipient, `0x${evmAddress.slice(2)}`)
      );
      result = {
        kind: 'cctp',
        received: amount.trim(),
        fee: formatUnits(authorization.feeTotalAmount, 6),
        validity: { kind: 'provider' },
        authorization
      };
    }
  }
  assertCurrent();
  return result;
}
