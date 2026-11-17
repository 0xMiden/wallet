import { circleSnapshot, TEST_CCTP_MESSENGER } from 'lib/bridge/testing/circle-fixtures';
import { parseBridgeConfig } from 'lib/remote-config/schema';

it('retains a published underlying messenger separately from the fee entrypoint through strict parsing', () => {
  const input = circleSnapshot().config;
  const parsed = parseBridgeConfig(input, 'testnet');
  expect(parsed?.supportedEvmChains.sepolia?.bridges.usdcx?.deposit).toMatchObject({
    route: 'executor',
    tokenMessenger: TEST_CCTP_MESSENGER.toLowerCase(),
    tokenMessengerWithFees: '0x8745d906d67c346e5eb1aeeed38eb87f34df0c0a'
  });
});
it('rejects a malformed provided underlying messenger without turning it into fee-messenger fallback', () => {
  const input = circleSnapshot().config;
  const deposit = input?.supportedEvmChains.sepolia?.bridges.usdcx?.deposit;
  if (!deposit) throw new Error('Missing source fixture');
  Object.assign(deposit, { tokenMessenger: 'not-a-contract' });
  expect(parseBridgeConfig(input, 'testnet')).toBeNull();
});
