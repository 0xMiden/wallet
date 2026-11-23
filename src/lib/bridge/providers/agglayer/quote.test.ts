import { createPublicClient } from 'viem';

import { accounts, now, referenceSnapshot, testRoute } from 'lib/bridge/testing/fixtures';
import { getBridgeConfigSnapshot } from 'lib/remote-config/runtime';

import { quoteAgglayer } from './quote';

jest.mock('viem', () => ({ ...jest.requireActual('viem'), createPublicClient: jest.fn() }));
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

it.each(['receive', 'send'])('quotes exact same-asset %s output only after the real bridge pause read', async mode => {
  const route = testRoute(mode === 'send' ? 'send' : 'receive');
  const quote = await quoteAgglayer({ route, amount: '0.00000001', ...accounts }, new AbortController().signal);
  expect(quote).toEqual({
    kind: 'agglayer',
    received: '0.00000001',
    validity: { kind: 'time', expiresAt: now + 60000 }
  });
  expect(read).toHaveBeenCalledWith(
    expect.objectContaining({ functionName: 'isEmergencyState', address: '0x528e26b25a34a4a5d0dbda1d57d318153d2ed582' })
  );
});

it('refuses unrepresentable native payout precision before any live quote read', async () => {
  await expect(
    quoteAgglayer({ route: testRoute(), amount: '0.000000001', ...accounts }, new AbortController().signal)
  ).rejects.toThrow();
  expect(read).not.toHaveBeenCalled();
});

it('does not infer a payout when the bridge read fails or reports a pause', async () => {
  read.mockRejectedValueOnce(new Error('Unavailable'));
  await expect(
    quoteAgglayer({ route: testRoute(), amount: '1', ...accounts }, new AbortController().signal)
  ).rejects.toThrow();
  read.mockResolvedValueOnce(true);
  await expect(
    quoteAgglayer({ route: testRoute(), amount: '1', ...accounts }, new AbortController().signal)
  ).rejects.toThrow();
});

it('drops an aborted quote after its async bridge read', async () => {
  const controller = new AbortController();
  read.mockImplementationOnce(async () => {
    controller.abort();
    return false;
  });
  await expect(quoteAgglayer({ route: testRoute(), amount: '1', ...accounts }, controller.signal)).rejects.toThrow();
});
