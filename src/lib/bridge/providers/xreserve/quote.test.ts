import { createPublicClient } from 'viem';

import { bindTransferQuote, quoteAmounts } from 'lib/bridge/core/quote';
import { assertReviewedBridge } from 'lib/bridge/core/review';
import { accounts, now, referenceSnapshot } from 'lib/bridge/testing/fixtures';
import { reviewedCircleTransfer } from 'lib/bridge/testing/operation-fixtures';
import { getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { getBridgeConfigSnapshot } from 'lib/remote-config/runtime';

import { quoteXReserve } from './quote';

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  ...jest.requireActual('@miden-sdk/miden-sdk/lazy'),
  AccountId: { fromHex: (hex: string) => ({ toString: () => hex.toLowerCase() }) }
}));
jest.mock('viem', () => ({ ...jest.requireActual('viem'), createPublicClient: jest.fn() }));
jest.mock('lib/remote-config/runtime', () => ({ getBridgeConfigSnapshot: jest.fn() }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'), getEffectiveNetworkName: () => 'testnet',
  getEffectiveRpcUrl: jest.fn(() => 'https://wallet-rpc.example/private')
}));
const read = jest.fn();
const fetchMock = jest.fn();
const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
beforeAll(() => Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchMock }));
afterAll(() => {
  if (descriptor) Object.defineProperty(globalThis, 'fetch', descriptor);
  else Reflect.deleteProperty(globalThis, 'fetch');
});
beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(now);
  jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://wallet-rpc.example/private');
  jest.mocked(getBridgeConfigSnapshot).mockReturnValue(referenceSnapshot('testnet'));
  jest.mocked(createPublicClient).mockReturnValue(Object.assign(
    jest.requireActual('viem').createPublicClient({ transport: jest.requireActual('viem').http('https://rpc.example') }),
    { readContract: read }
  ));
});
afterEach(() => jest.restoreAllMocks());
function request(executor: boolean) {
  const review = reviewedCircleTransfer();
  if (!executor) {
    const chain = review.route.recovery.config.supportedEvmChains['arc-testnet'];
    const token = chain?.bridges.usdcx?.tokens.USDC;
    if (!token) throw new Error('Missing Arc fixture');
    review.route.source = { kind: 'erc20', network: 'arc-testnet', symbol: 'USDC', decimals: 6, address: token.contractAddress };
  }
  return { route: review.route, amount: '6.000001', ...accounts };
}
it.each([false, true])('quotes bound Circle received output and additional fee (executor=%s)', async executor => {
  const input = request(executor);
  const token = input.route.source.kind === 'erc20' ? input.route.source.address : '';
  const body = { signedQuote: '0x1234', burnAmount: '6000001', feeToken: token, feeTotalAmount: '100001',
    issuedAt: now / 1000, expiry: { mode: 'TIMESTAMP', expiresAt: now / 1000 + 120 } };
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => body });
  const result = await quoteXReserve(input, new AbortController().signal);
  expect(result).toMatchObject({ kind: executor ? 'cctp' : 'arc-deposit', received: '6.000001' });
  if (!result) throw new Error('Missing provider quote');
  const bound = bindTransferQuote(input, result);
  assertReviewedBridge({ route: input.route, amount: input.amount, accounts, quote: bound }, { route: input.route, amount: input.amount, accounts }, now);
  expect(quoteAmounts(input.route, bound)).toMatchObject({ received: '6.000001', sourceTotal: executor ? '6.100002' : '6.000001' });
});
