/** @jest-environment node */
import { runEpochReverse } from '../playwright/e2e/helpers/mainnet-epoch-runtime';
import { epochCheckpointFixture } from './helpers/mainnet-epoch-fixture';
import type { GuardianAwareWalletPage } from '../playwright/e2e/fixtures/two-wallets';

const mockMetadata = jest.fn();
const mockSender = jest.fn();
const mockAuthorize = jest.fn();
const mockSave = jest.fn();
const mockReady = jest.fn();
const mockAddress = `0x${'1'.repeat(40)}`;
let mockSend: (transaction: object, signal: AbortSignal) => Promise<unknown>;
const mockStop = jest.fn();
jest.mock('@playwright/test', () => ({
  expect: () => ({ toBeEnabled: (options: unknown) => mockReady(options) })
}));
jest.mock('viem', () => ({ ...jest.requireActual('viem'), createPublicClient: () => ({}) }));
jest.mock('viem/accounts', () => ({ privateKeyToAccount: () => ({ address: mockAddress }) }));
jest.mock('../playwright/e2e/ios/helpers/wc-counterparty', () => ({
  WcCounterparty: jest.fn((options: { send: typeof mockSend }) => {
    mockSend = options.send;
    return { start: jest.fn(), stop: mockStop, connectWithRetry: jest.fn().mockResolvedValue(undefined) };
  })
}));
jest.mock('../playwright/e2e/helpers/history', () => ({ plantQueueBlocker: () => 'held-queue' }));
jest.mock('../playwright/e2e/helpers/mainnet-epoch-provider', () => ({
  epochReadOnlyProvider: () => ({ config: {}, sdk: { resolveServiceConfiguration: mockMetadata } })
}));
jest.mock('../playwright/e2e/helpers/mainnet-epoch-request', () => ({}));
jest.mock('../playwright/e2e/helpers/mainnet-epoch-ui', () => ({}));
jest.mock('../playwright/e2e/helpers/mainnet-epoch-evm', () => ({
  createEpochEvmSender: (...args: unknown[]) => mockSender(...args)
}));
jest.mock('../playwright/e2e/helpers/mainnet-loop-authorization', () => ({
  awaitMainnetLoopAuthorization: (...args: unknown[]) => mockAuthorize(...args)
}));
jest.mock('../playwright/e2e/helpers/mainnet-epoch-checkpoint', () => ({
  ...jest.requireActual('../playwright/e2e/helpers/mainnet-epoch-checkpoint'),
  saveMainnetEpochCheckpoint: (...args: unknown[]) => mockSave(...args)
}));

const service = 'https://mainnet-api.epochprotocol.xyz';
const pathQuote = (input: unknown = '1000501', output: unknown = '1000000') => ({
  path: [
    [
      [[{ name: 'Arbitrum' }], [{ name: 'USDC', token: { amount: input } }], [{ name: 'call' }]],
      [[{ name: 'Miden' }], [{ name: 'USDCX', token: { amount: output } }], [{ name: 'call' }]]
    ]
  ]
});
let quote: unknown;
let tokenIds: string[];
const control = (id: string | RegExp) => ({
  fill: jest.fn(),
  click: async () => {
    if (id instanceof RegExp || id.startsWith('bridge-token-')) {
      const matches = tokenIds.filter(token => (typeof id === 'string' ? token === id : id.test(token)));
      if (matches.length !== 1) throw new Error('Missing or ambiguous actual token row');
    }
    if (id === 'bridge-deposit-review-confirm') await mockSend({}, AbortSignal.timeout(1000));
  }
});
const wallet = {
  extensionId: 'a'.repeat(32),
  getAccountAddress: jest.fn(),
  page: {
    goto: jest.fn(),
    evaluate: jest.fn(),
    locator: () => ({ getByTestId: control }),
    getByTestId: control,
    requests: async () => [
      {
        url: () => `${service}/checkIfDepositNeeded`,
        response: async () => ({ ok: () => true, json: async () => quote }),
        postDataJSON: () => ({ compact: { expires: String(Math.floor(Date.now() / 1000) + 60) } })
      },
      {
        url: () => `${service}/suggested-nonce/42161/${mockAddress}`,
        response: async () => ({ ok: () => true, json: async () => ({ nonce: '0x0a' }) })
      }
    ]
  }
};
beforeEach(() => {
  jest.clearAllMocks();
  quote = { tokenIn: '1000501', tokenOut: '1000000' };
  tokenIds = ['bridge-token-EPOCH_USDC'];
  wallet.getAccountAddress.mockResolvedValue(epochCheckpointFixture().account);
  wallet.page.evaluate.mockResolvedValue({ connected: true, address: mockAddress, chainId: 42161 });
  mockMetadata.mockRejectedValue(new Error('Read-only stop at live metadata boundary'));
});
async function inspect() {
  const state = {
    ...epochCheckpointFixture(),
    phase: 'forward-settled' as const,
    forwardReceived: '1001000',
    forwardAuthority: {
      minimumOutput: '1000000',
      bindingHash: `0x${'a'.repeat(64)}`,
      reclaimHeight: 7200,
      mandateReclaimHeight: 2200
    }
  };
  await expect(
    runEpochReverse(
      wallet as unknown as GuardianAwareWalletPage,
      state,
      'never-written.json',
      state.sourceRunId,
      `0x${'1'.repeat(64)}`,
      'never-acknowledged',
      AbortSignal.timeout(1000)
    )
  ).rejects.toThrow();
  expect(mockSender).not.toHaveBeenCalled();
  expect(mockAuthorize).not.toHaveBeenCalled();
  expect(state).not.toHaveProperty('reverseAuthority');
  expect(state).not.toHaveProperty('reverseNonce');
  expect(state.forwardNonce).toBe('9');
  expect(state.createdAt).toBe(epochCheckpointFixture().createdAt);
  expect(mockStop).toHaveBeenCalledTimes(1);
}
it('uses the compact fixed-output form and stops before a new return grant', async () => {
  await inspect();
  expect(wallet.page.goto).toHaveBeenCalledWith(`chrome-extension://${wallet.extensionId}/sidepanel.html#/bridge/deposit`);
  expect(mockMetadata).toHaveBeenCalledTimes(1);
});
it('validates the installed SDK path-only quote before the live metadata boundary', async () => {
  quote = pathQuote();
  await inspect();
  expect(mockMetadata).toHaveBeenCalledTimes(1);
});
it.each(['0', '-1', '1e6', '1.2', (1n << 256n).toString(), 1000501])(
  'refuses an invalid raw path input before authority: %s',
  async input => {
    quote = pathQuote(input);
    await inspect();
    expect(mockMetadata).not.toHaveBeenCalled();
  }
);
it('refuses a path that changes the original exact return floor', async () => {
  quote = pathQuote('1000501', '999999');
  await inspect();
  expect(mockMetadata).not.toHaveBeenCalled();
});
it('does not replace a malformed explicit amount with a valid path amount', async () => {
  quote = { ...pathQuote(), tokenIn: 'invalid' };
  await inspect();
  expect(mockMetadata).not.toHaveBeenCalled();
});
it('uses the shared USDC row when Circle and Epoch name the same contract', async () => {
  tokenIds = ['bridge-token-CIRCLE_USDC'];
  await inspect();
  expect(mockMetadata).toHaveBeenCalledTimes(1);
});
it('refuses ambiguous USDC rows instead of selecting the first asset', async () => {
  tokenIds.push('bridge-token-CIRCLE_USDC');
  await inspect();
  expect(mockMetadata).not.toHaveBeenCalled();
});
it('waits for real mainnet token-list and faucet readiness before selecting Fast', async () => {
  await inspect();
  expect(mockReady).toHaveBeenCalledWith({ timeout: 90_000 });
});
