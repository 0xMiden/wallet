/** @jest-environment node */
import { epochCheckpointFixture, epochReverseAuthorityFixture } from './helpers/mainnet-epoch-fixture';

const hash = `0x${'a'.repeat(64)}`;
const refund = jest.fn();
const returned = jest.fn();
const forward = jest.fn();
const prepare = jest.fn();
const reverse = jest.fn();
const restore = jest.fn();
const summary = jest.fn();
const save = jest.fn();
const fundedForward = jest.fn();
const head = jest.fn();
const account = jest.fn();
const wallet = { getAccountAddress: account };
let previous: ReturnType<typeof epochCheckpointFixture> | undefined;
let callback: ((fixtures: { walletB: typeof wallet }) => Promise<void>) | undefined;
const test = Object.assign(
  jest.fn((_name: string, body: typeof callback) => {
    callback = body;
  }),
  {
    use: jest.fn(),
    describe: { configure: jest.fn() },
    skip: jest.fn()
  }
);
const environment = new Map<string, string | undefined>();
const keys = [
  'E2E_NETWORK',
  'GITHUB_RUN_ID',
  'GITHUB_RUN_ATTEMPT',
  'MAINNET_EPOCH_MODE',
  'E2E_MAINNET_GUARDIAN_KEY_PAIR',
  'E2E_MAINNET_EVM_KEY',
  'MAINNET_EPOCH_FORWARD_ATTEMPTED',
  'MAINNET_LOOP_RECOVERY_CLEARED'
];
const modules = [
  '../playwright/e2e/fixtures/two-wallets',
  '../playwright/e2e/helpers/mainnet-epoch-checkpoint',
  '../playwright/e2e/helpers/mainnet-epoch-runtime',
  '../playwright/e2e/helpers/mainnet-epoch-provider',
  '../playwright/e2e/helpers/mainnet-loop-wallet',
  '../playwright/e2e/helpers/mainnet-miden-read',
  '../playwright/e2e/helpers/balance-truth',
  '../playwright/e2e/helpers/mainnet-one-click-config',
  '../playwright/e2e/helpers/mainnet-one-click-evm',
  '../playwright/e2e/helpers/mainnet-one-click-prices',
  'node:fs'
];
beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  callback = undefined;
  for (const key of keys) environment.set(key, process.env[key]);
  Object.assign(process.env, {
    E2E_NETWORK: 'mainnet',
    GITHUB_RUN_ID: '999999',
    GITHUB_RUN_ATTEMPT: '1',
    MAINNET_EPOCH_MODE: 'recover',
    E2E_MAINNET_GUARDIAN_KEY_PAIR: 'existing-fixture-key'
  });
  delete process.env.E2E_MAINNET_EVM_KEY;
  delete process.env.MAINNET_EPOCH_FORWARD_ATTEMPTED;
  delete process.env.MAINNET_LOOP_RECOVERY_CLEARED;
  previous = {
    ...epochCheckpointFixture(),
    phase: 'recovery-required',
    forwardNoteId: hash,
    forwardMidenTxId: hash,
    forwardAuthority: { minimumOutput: '1000001', bindingHash: hash, reclaimHeight: 7200, mandateReclaimHeight: 2200 },
    paidMidenFees: '7'
  };
  account.mockResolvedValue(previous.account);
  head.mockResolvedValue(8000);
  refund.mockResolvedValue(undefined);
  returned.mockResolvedValue(undefined);
  restore.mockResolvedValue(undefined);
  jest.doMock(modules[0]!, () => ({ test }));
  jest.doMock(modules[1]!, () => ({ loadMainnetEpochCheckpoint: () => previous, saveMainnetEpochCheckpoint: save }));
  jest.doMock(modules[2]!, () => ({
    runEpochRefund: refund,
    recoverEpochReturn: returned,
    recoverEpochForward: forward,
    runEpochForward: fundedForward,
    runEpochReverse: reverse
  }));
  jest.doMock(modules[3]!, () => ({
    prepareEpochRoundTrip: prepare,
    epochReadOnlyProvider: () => ({ config: {}, sdk: { getIntentStatus: async () => [] } })
  }));
  jest.doMock(modules[4]!, () => ({ restoreMainnetLoopGuardian: restore }));
  jest.doMock(modules[5]!, () => ({ readMainnetMidenBlock: head }));
  for (const module of modules.slice(6, 10)) jest.doMock(module, () => ({}));
  jest.doMock('node:fs', () => ({ ...jest.requireActual('node:fs'), writeFileSync: summary }));
  jest.isolateModules(() => {
    require('../playwright/e2e/tests/mainnet/mainnet-epoch-loop.spec');
  });
});
afterEach(() => {
  for (const key of keys) {
    const value = environment.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const module of modules) jest.dontMock(module);
  jest.resetModules();
});
const run = () => {
  if (!callback) throw new Error('Epoch staged callback was not registered');
  return callback({ walletB: wallet });
};
it.each(['forward', 'reverse'])(
  'dispatches an unused same-run Epoch %s only after the complete recovery barrier',
  async mode => {
    previous = epochCheckpointFixture();
    process.env.GITHUB_RUN_ID = previous.sourceRunId;
    process.env.MAINNET_EPOCH_MODE = mode;
    process.env.MAINNET_LOOP_RECOVERY_CLEARED = 'true';
    process.env.E2E_MAINNET_EVM_KEY = `0x${'0'.repeat(63)}1`;
    previous.createdAt = previous.pricedAt = new Date().toISOString();
    previous.evm.account = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
    if (mode === 'reverse')
      Object.assign(previous, {
        phase: 'forward-settled',
        forwardNoteId: hash,
        forwardMidenTxId: hash,
        forwardAuthority: {
          minimumOutput: '1000001',
          bindingHash: hash,
          reclaimHeight: 7200,
          mandateReclaimHeight: 2200
        },
        forwardReceived: '1001000',
        forwardEvmTxHash: hash,
        paidMidenFees: '7'
      });
    await run();
    expect(restore).toHaveBeenCalledWith(wallet, 'existing-fixture-key');
    expect(mode === 'forward' ? fundedForward : reverse).toHaveBeenCalledWith(
      wallet,
      previous,
      expect.any(String),
      previous.sourceRunId,
      ...(mode === 'forward' ? [] : [process.env.E2E_MAINNET_EVM_KEY]),
      expect.any(String),
      expect.any(AbortSignal)
    );
    expect(prepare).not.toHaveBeenCalled();
  }
);
it('closes only an authoritative never-attempted Epoch preflight without restoring keys or renewing authority', async () => {
  previous = epochCheckpointFixture();
  process.env.MAINNET_EPOCH_FORWARD_ATTEMPTED = 'false';
  const original = {
    sourceRunId: previous.sourceRunId,
    authorizationRunId: previous.authorizationRunId,
    lossBudgetUsdMicros: previous.lossBudgetUsdMicros,
    pricedAt: previous.pricedAt
  };
  await run();
  expect(save).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ ...original, phase: 'unspent' }));
  expect(restore).not.toHaveBeenCalled();
  expect(reverse).not.toHaveBeenCalled();
  expect(refund).not.toHaveBeenCalled();
});
it('keeps a missing original Epoch collateral fingerprint unresolved when the forward stage was attempted', async () => {
  previous = epochCheckpointFixture();
  process.env.MAINNET_EPOCH_FORWARD_ATTEMPTED = 'true';
  await expect(run()).rejects.toThrow();
  expect(save).not.toHaveBeenCalled();
  expect(reverse).not.toHaveBeenCalled();
});
it('recovers only original matured collateral without asking for an EVM signing key or creating a new plan', async () => {
  const original = JSON.stringify(previous);
  await run();
  expect(restore).toHaveBeenCalledWith(wallet, 'existing-fixture-key');
  expect(refund).toHaveBeenCalledWith(
    wallet,
    previous,
    expect.any(String),
    expect.any(String),
    expect.any(AbortSignal)
  );
  expect(returned).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
  expect(JSON.stringify(previous)).toBe(original);
});
it('reconciles an original signed deposit instead of authorizing another EVM deposit', async () => {
  Object.assign(previous!, {
    forwardReceived: '1001000',
    forwardEvmTxHash: hash,
    reverseNonce: '10',
    returnAmount: '1000501',
    evmNonceBefore: 0,
    reverseAuthority: epochReverseAuthorityFixture(),
    transactions: [{ kind: 'deposit', nonce: 0, hash }]
  });
  await run();
  expect(returned).toHaveBeenCalledWith(
    wallet,
    previous,
    expect.any(String),
    expect.any(String),
    expect.any(AbortSignal)
  );
  expect(refund).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
});
it('reconciles an already recorded actual native receipt without authorizing another claim', async () => {
  Object.assign(previous!, {
    forwardReceived: '1001000',
    forwardEvmTxHash: `0x${'b'.repeat(64)}`,
    reverseNonce: '10',
    returnAmount: '1000501',
    evmNonceBefore: 0,
    reverseAuthority: epochReverseAuthorityFixture(),
    transactions: [{ kind: 'deposit', nonce: 0, hash }],
    returnNoteId: `0x${'c'.repeat(64)}`,
    returnMidenTxId: `0x${'d'.repeat(64)}`,
    reverseReceived: '1000000',
    paidMidenFees: '14',
    consumeAuthority: {
      nonce: '11111111-1111-4111-8111-111111111111',
      sha256: '1'.repeat(64),
      canonicalSha256: '2'.repeat(64)
    }
  });
  await run();
  expect(returned).toHaveBeenCalledWith(
    wallet,
    previous,
    expect.any(String),
    expect.any(String),
    expect.any(AbortSignal)
  );
  expect(refund).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
});
it('recovers a FIRST original return from owned proceeds without replacing the old authorization or budgets', async () => {
  Object.assign(previous!, { phase: 'forward-settled', forwardReceived: '1001000', forwardEvmTxHash: hash });
  const key = `0x${'0'.repeat(63)}1`;
  process.env.E2E_MAINNET_EVM_KEY = key;
  const original = JSON.stringify(previous);
  await run();
  expect(reverse).toHaveBeenCalledWith(
    wallet,
    previous,
    expect.any(String),
    previous!.sourceRunId,
    key,
    expect.any(String),
    expect.any(AbortSignal)
  );
  expect(previous!.sourceRunId).not.toBe(process.env.GITHUB_RUN_ID);
  expect(JSON.stringify(previous)).toBe(original);
  expect(prepare).not.toHaveBeenCalled();
});
it('never refreshes an existing reverse nonce even when its signed journal is missing', async () => {
  Object.assign(previous!, {
    forwardReceived: '1001000',
    forwardEvmTxHash: hash,
    reverseNonce: '10',
    reverseAuthority: epochReverseAuthorityFixture()
  });
  process.env.E2E_MAINNET_EVM_KEY = `0x${'0'.repeat(63)}1`;
  await expect(run()).rejects.toThrow(/ambig|original|authorization|reverse/i);
  expect(reverse).not.toHaveBeenCalled();
  expect(refund).not.toHaveBeenCalled();
});
it('does not sign an original return with a missing existing EVM key', async () => {
  Object.assign(previous!, { forwardReceived: '1001000', forwardEvmTxHash: hash });
  await expect(run()).rejects.toThrow(/key/i);
  expect(reverse).not.toHaveBeenCalled();
});
it('does not restore a funded actor for a terminal checkpoint', async () => {
  previous!.phase = 'cancelled';
  await run();
  expect(restore).not.toHaveBeenCalled();
  expect(refund).not.toHaveBeenCalled();
  expect(returned).not.toHaveBeenCalled();
});
it('does not restore a funded actor when there is no previous authorization', async () => {
  previous = undefined;
  await run();
  expect(restore).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
});
it('refuses a different Guardian before any recovery fee is authorized', async () => {
  account.mockResolvedValue('another-account');
  await expect(run()).rejects.toThrow(/account|actor/i);
  expect(refund).not.toHaveBeenCalled();
  expect(returned).not.toHaveBeenCalled();
});
it('does not retry an already authorized native claim with an unknown outcome', async () => {
  Object.assign(previous!, {
    returnNoteId: hash,
    consumeAuthority: {
      nonce: '11111111-1111-4111-8111-111111111111',
      sha256: '1'.repeat(64),
      canonicalSha256: '2'.repeat(64)
    }
  });
  await expect(run()).rejects.toThrow(/claim|ambig|authorization/i);
  expect(refund).not.toHaveBeenCalled();
  expect(returned).not.toHaveBeenCalled();
});
it('waits before original reclaim maturity instead of inventing refund permission', async () => {
  head.mockResolvedValue(7199);
  await expect(run()).rejects.toThrow(/pending|matur|reclaim/i);
  expect(refund).not.toHaveBeenCalled();
  expect(returned).not.toHaveBeenCalled();
});
