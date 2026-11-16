// Adapted from bridge-portal@cb52c470 src/bridge/providers/epoch/{epoch-quote,epoch-execute}.ts.
// MIT notice and original paths: third-party/bridge-portal/.
import { isBridgeRouteAvailable } from 'lib/bridge/core/provider';
import type { QuoteRequest, QuoteResult } from 'lib/bridge/core/quote';
import { configKey, routeMatchesRecovery } from 'lib/bridge/core/routes';
import { validateTransferAmount } from 'lib/bridge/core/rules';
import type { BridgeOperationInput } from 'lib/bridge/operation';
import { reviewedEpochMinimum } from 'lib/epoch/bridge';
import { bridgeEpochSend, quoteEpochSendOutput } from 'lib/epoch/epoch-send';
import type { BridgeNoteDeps } from 'lib/epoch/miden-note';
import { getBridgeConfigSnapshot } from 'lib/remote-config/runtime';

export { pollEpochIntentFill } from 'lib/epoch/epoch-send';

function sendTerms(request: QuoteRequest) {
  const { route, amount, midenAccount, evmAddress } = request;
  const { source, destination } = route;
  const chain = route.recovery.config.supportedEvmChains[destination.network];
  if (
    route.provider !== 'epoch' ||
    route.mode !== 'send' ||
    source.kind !== 'miden' ||
    destination.kind === 'miden' ||
    !chain ||
    !isBridgeRouteAvailable(route) ||
    !routeMatchesRecovery(route) ||
    !midenAccount.trim() ||
    !/^0x[\da-f]{40}$/i.test(evmAddress)
  )
    throw new Error('Epoch requires a configured Miden-source route');
  validateTransferAmount(route, amount);
  return {
    amount: reviewedEpochMinimum(amount, source.decimals),
    faucetId: source.faucetId,
    destinationAddress: `0x${evmAddress.slice(2)}` satisfies `0x${string}`,
    senderPublicKey: midenAccount,
    destinationChainId: chain.chainId
  };
}

export async function quoteEpochSend(request: QuoteRequest): Promise<QuoteResult> {
  request = structuredClone(request);
  const terms = sendTerms(request);
  const assertCurrent = () => {
    const current = getBridgeConfigSnapshot();
    const recovery = request.route.recovery;
    if (
      current.status !== 'ready' ||
      configKey([current.network, current.config, current.derived]) !==
        configKey([recovery.network, recovery.config, recovery.derived])
    )
      throw new Error('Epoch quote route changed');
  };
  assertCurrent();
  const output = await quoteEpochSendOutput(terms);
  assertCurrent();
  reviewedEpochMinimum(output.amount, request.route.destination.decimals);
  if (!output.validity) throw new Error('Epoch quote validity is unavailable');
  return { kind: 'epoch', received: output.amount, validity: output.validity };
}

export async function runEpochSend(
  operation: BridgeOperationInput,
  deps: BridgeNoteDeps,
  onRowCreated?: (txId: string) => void
): Promise<{ txId?: string }> {
  operation = structuredClone(operation);
  const { review } = operation;
  const terms = sendTerms({ route: review.route, amount: review.amount, ...review.accounts });
  if (!review.quote) throw new Error('Epoch quote requires a new review');
  return bridgeEpochSend({
    ...terms,
    minimumOutputBaseUnits: reviewedEpochMinimum(review.quote.received, review.route.destination.decimals),
    operation,
    deps,
    onRowCreated
  });
}
