/** @jest-environment node */
import { epochCheckpointFixture, epochReverseAuthorityFixture } from './helpers/mainnet-epoch-fixture';

const hash = `0x${'a'.repeat(64)}`;
const refund = jest.fn(); const returned = jest.fn(); const forward = jest.fn(); const prepare = jest.fn();
const restore = jest.fn(); const summary = jest.fn();
const head = jest.fn();
const account = jest.fn();
const wallet = { getAccountAddress: account };
let previous: ReturnType<typeof epochCheckpointFixture> | undefined;
let callback: ((fixtures: { walletB: typeof wallet }) => Promise<void>) | undefined;
const test = Object.assign(jest.fn((_name: string, body: typeof callback) => { callback = body; }), {
  use: jest.fn(), describe: { configure: jest.fn() }, skip: jest.fn()
});
const environment = new Map<string, string | undefined>();
const keys = ['E2E_NETWORK', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'MAINNET_EPOCH_MODE',
  'E2E_MAINNET_GUARDIAN_KEY_PAIR', 'E2E_MAINNET_EVM_KEY'];
const modules = [
  '../playwright/e2e/fixtures/two-wallets', '../playwright/e2e/helpers/mainnet-epoch-checkpoint',
  '../playwright/e2e/helpers/mainnet-epoch-runtime', '../playwright/e2e/helpers/mainnet-epoch-provider',
  '../playwright/e2e/helpers/mainnet-loop-wallet', '../playwright/e2e/helpers/mainnet-miden-read',
  '../playwright/e2e/helpers/balance-truth', '../playwright/e2e/helpers/mainnet-one-click-config',
  '../playwright/e2e/helpers/mainnet-one-click-evm', '../playwright/e2e/helpers/mainnet-one-click-prices', 'node:fs'
];
beforeEach(() => {
  jest.resetModules(); jest.clearAllMocks(); callback = undefined;
  for (const key of keys) environment.set(key, process.env[key]);
  Object.assign(process.env, { E2E_NETWORK: 'mainnet', GITHUB_RUN_ID: '999999', GITHUB_RUN_ATTEMPT: '1',
    MAINNET_EPOCH_MODE: 'recover', E2E_MAINNET_GUARDIAN_KEY_PAIR: 'existing-fixture-key' });
  delete process.env.E2E_MAINNET_EVM_KEY;
  previous = { ...epochCheckpointFixture(), phase: 'recovery-required', forwardNoteId: hash, forwardMidenTxId: hash,
    forwardAuthority: { minimumOutput: '1000001', bindingHash: hash, reclaimHeight: 7200, mandateReclaimHeight: 2200 },
    paidMidenFees: '7' };
  account.mockResolvedValue(previous.account); head.mockResolvedValue(8000);
  refund.mockResolvedValue(undefined); returned.mockResolvedValue(undefined); restore.mockResolvedValue(undefined);
  jest.doMock(modules[0]!, () => ({ test }));
  jest.doMock(modules[1]!, () => ({ loadMainnetEpochCheckpoint: () => previous, saveMainnetEpochCheckpoint: jest.fn() }));
  jest.doMock(modules[2]!, () => ({ runEpochRefund: refund, recoverEpochReturn: returned,
    recoverEpochForward: forward, runEpochForward: jest.fn(), runEpochReverse: jest.fn() }));
  jest.doMock(modules[3]!, () => ({ prepareEpochRoundTrip: prepare,
    epochReadOnlyProvider: () => ({ config: {}, sdk: { getIntentStatus: async () => [] } }) }));
  jest.doMock(modules[4]!, () => ({ restoreMainnetLoopGuardian: restore }));
  jest.doMock(modules[5]!, () => ({ readMainnetMidenBlock: head }));
  for (const module of modules.slice(6, 10)) jest.doMock(module, () => ({}));
  jest.doMock('node:fs', () => ({ ...jest.requireActual('node:fs'), writeFileSync: summary }));
  jest.isolateModules(() => { require('../playwright/e2e/tests/mainnet/mainnet-epoch-loop.spec'); });
});
afterEach(() => {
  for (const key of keys) { const value = environment.get(key); if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  for (const module of modules) jest.dontMock(module);
  jest.resetModules();
});
const run = () => {
  if (!callback) throw new Error('Epoch staged callback was not registered');
  return callback({ walletB: wallet });
};
it('recovers only original matured collateral without asking for an EVM signing key or creating a new plan', async () => {
  const original = JSON.stringify(previous);
  await run();
  expect(restore).toHaveBeenCalledWith(wallet, 'existing-fixture-key');
  expect(refund).toHaveBeenCalledWith(wallet, previous, expect.any(String), expect.any(String), expect.any(AbortSignal));
  expect(returned).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
  expect(JSON.stringify(previous)).toBe(original);
});
it('reconciles an original signed deposit instead of authorizing another EVM deposit', async () => {
  Object.assign(previous!, { forwardReceived: '1001000', forwardEvmTxHash: hash, reverseNonce: '10', returnAmount: '1000501',
    evmNonceBefore: 0, reverseAuthority: epochReverseAuthorityFixture(), transactions: [{ kind: 'deposit', nonce: 0, hash }] });
  await run();
  expect(returned).toHaveBeenCalledWith(wallet, previous, expect.any(String), expect.any(String), expect.any(AbortSignal));
  expect(refund).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
});
it('does not restore a funded actor for a terminal checkpoint', async () => {
  previous!.phase = 'cancelled'; await run();
  expect(restore).not.toHaveBeenCalled(); expect(refund).not.toHaveBeenCalled(); expect(returned).not.toHaveBeenCalled();
});
it('does not restore a funded actor when there is no previous authorization', async () => {
  previous = undefined; await run(); expect(restore).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
});
it('refuses a different Guardian before any recovery fee is authorized', async () => {
  account.mockResolvedValue('another-account');
  await expect(run()).rejects.toThrow(/account|actor/i);
  expect(refund).not.toHaveBeenCalled(); expect(returned).not.toHaveBeenCalled();
});
it('does not retry an already authorized native claim with an unknown outcome', async () => {
  Object.assign(previous!, { returnNoteId: hash, consumeAuthority: { nonce: '11111111-1111-4111-8111-111111111111',
    sha256: '1'.repeat(64), canonicalSha256: '2'.repeat(64) } });
  await expect(run()).rejects.toThrow(/claim|ambig|authorization/i);
  expect(refund).not.toHaveBeenCalled(); expect(returned).not.toHaveBeenCalled();
});
it('waits before original reclaim maturity instead of inventing refund permission', async () => {
  head.mockResolvedValue(7199);
  await expect(run()).rejects.toThrow(/pending|matur|reclaim/i);
  expect(refund).not.toHaveBeenCalled(); expect(returned).not.toHaveBeenCalled();
});
