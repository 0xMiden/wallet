import { parseUnits } from 'viem';

import { accounts } from 'lib/bridge/testing/fixtures';
import { reviewedErc20Transfer } from 'lib/bridge/testing/operation-fixtures';
import type { initiateBridgedReceiveTransaction } from 'lib/miden/transaction/initiate';

import { legacyBridgeReceiveFixture } from './bridge-receive-test-fixture';

it('models the successful legacy admission row without creating owned source authority', () => {
  const review = reviewedErc20Transfer('epoch');
  const destination = review.route.destination;
  if (destination.kind !== 'miden') throw new Error('Missing accepted receive fixture');
  const args = {
    accountId: accounts.midenAccount,
    amount: parseUnits('1', destination.decimals),
    faucetId: destination.faucetId,
    provider: 'epoch',
    sourceChainId: 11155111,
    sourceAddress: accounts.evmAddress,
    sourceAmount: review.amount,
    sourceSymbol: review.route.source.symbol
  } satisfies Parameters<typeof initiateBridgedReceiveTransaction>[0];
  const row = legacyBridgeReceiveFixture(args, 'bridge-tx');
  expect(row).toMatchObject({
    id: 'bridge-tx',
    accountId: args.accountId,
    amount: args.amount,
    extraInputs: { provider: 'epoch', phase: 'submitting', sourceChainId: 11155111 }
  });
  expect(Object.prototype.hasOwnProperty.call(row.extraInputs, 'bridgeOperation')).toBe(false);
  expect(() =>
    legacyBridgeReceiveFixture({ ...args, operation: { operationId: 'owned', review } }, 'bridge-tx')
  ).toThrow('real protected initiator');
});
