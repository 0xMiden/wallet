import { BridgedReceiveTransaction, type ITransaction } from 'lib/miden/db/types';
import type { initiateBridgedReceiveTransaction } from 'lib/miden/transaction/initiate';

/** Legacy UI admission is stubbed; its successful id still denotes a row to the real submission controller. */
export function legacyBridgeReceiveFixture(
  args: Parameters<typeof initiateBridgedReceiveTransaction>[0],
  id: string
): ITransaction {
  if (args.operation) throw new Error('Owned admission requires the real protected initiator');
  const row = new BridgedReceiveTransaction(
    args.accountId,
    args.amount,
    args.faucetId,
    args.provider,
    args.sourceAddress,
    args.sourceAmount,
    args.sourceSymbol,
    args.outputAmount,
    args.outputSymbol
  );
  Object.assign(row.extraInputs, {
    sourceChainId: args.sourceChainId,
    agglayerRoute: args.agglayerRoute,
    agglayerDelivery: args.agglayerDelivery,
    usdcxSource: args.usdcxSource,
    epochAllocatorUrl: args.epochAllocatorUrl
  });
  return { ...row, id };
}
