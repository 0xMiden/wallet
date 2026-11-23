import { createPublicClient } from 'viem';

import { quoteEpochSendOutput } from 'lib/epoch/epoch-send';
import { getBridgeConfigSnapshot } from 'lib/remote-config/runtime';

import { accounts, now, referenceSnapshot, testRoute } from './testing/fixtures';
import { reviewedErc20Transfer } from './testing/operation-fixtures';
import { quoteBridgeTransfer } from './wallet-transport';

jest.mock('viem', () => ({ ...jest.requireActual('viem'), createPublicClient: jest.fn() }));
jest.mock('lib/epoch/epoch-send', () => ({ quoteEpochSendOutput: jest.fn() }));
jest.mock('lib/remote-config/runtime', () => ({ getBridgeConfigSnapshot: jest.fn() }));
const read = jest.fn();
beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(now);
  jest.mocked(getBridgeConfigSnapshot).mockReturnValue(referenceSnapshot('testnet'));
  jest
    .mocked(createPublicClient)
    .mockReturnValue(
      Object.assign(
        jest
          .requireActual('viem')
          .createPublicClient({ transport: jest.requireActual('viem').http('https://rpc.example') }),
        { readContract: read }
      )
    );
  read.mockResolvedValue(false);
});
afterEach(() => jest.restoreAllMocks());

it.each(['receive', 'send'])(
  'quotes %s through the real wallet Agglayer pause reader and binds original terms',
  async mode => {
    const route = testRoute(mode === 'send' ? 'send' : 'receive');
    const quote = await quoteBridgeTransfer({ route, amount: '1.00000000', ...accounts }, new AbortController().signal);
    expect(quote).toEqual({
      kind: 'agglayer',
      received: '1',
      validity: { kind: 'time', expiresAt: now + 60000 },
      request: { routeId: route.id, recovery: route.recovery, amount: '1.00000000', ...accounts }
    });
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'isEmergencyState' }));
  }
);

it('uses the accepted native Epoch send quote instead of interpreting an EVM reverse quote as source input', async () => {
  const review = reviewedErc20Transfer('epoch', 'send');
  jest
    .mocked(quoteEpochSendOutput)
    .mockResolvedValue({ amount: '0.8', symbol: 'USDC', validity: { kind: 'provider' } });
  const quote = await quoteBridgeTransfer(
    { route: review.route, amount: review.amount, ...accounts },
    new AbortController().signal
  );
  expect(quote?.kind).toBe('epoch');
  expect(quote?.received).toBe('0.8');
  expect(quote?.request.amount).toBe('1.000000');
});

it('refuses retained Epoch fixed-input receive without calling a reverse quote or inventing an API', async () => {
  const review = reviewedErc20Transfer('epoch');
  await expect(
    quoteBridgeTransfer({ route: review.route, amount: review.amount, ...accounts }, new AbortController().signal)
  ).resolves.toBeNull();
  expect(quoteEpochSendOutput).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});

it('does not return an async pause-read result after cancellation', async () => {
  const controller = new AbortController();
  read.mockImplementationOnce(async () => {
    controller.abort();
    return false;
  });
  await expect(
    quoteBridgeTransfer({ route: testRoute(), amount: '1', ...accounts }, controller.signal)
  ).rejects.toThrow();
});
