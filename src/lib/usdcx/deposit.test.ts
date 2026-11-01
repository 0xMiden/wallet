import { sepolia } from 'viem/chains';

import * as bridgeRuntime from 'lib/remote-config/runtime';
import { testBridgeSnapshot } from 'lib/remote-config/testing/fixture';

import {
  USDCX_DEPOSIT_HOOK_DATA,
  USDCX_DEPOSIT_MAX_FEE,
  getUsdcxRemoteDomain,
  getUsdcxXReserveSource
} from './constant';
import {
  buildDepositToRemoteArgs,
  isUsdcxDomainNotRegisteredError,
  runUsdcxDeposit,
  UsdcxDepositDeps,
  UsdcxDomainNotRegisteredError
} from './deposit';
import * as protocol from './protocol';

jest.mock('lib/remote-config/runtime', () => ({
  getBridgeConfigSnapshot: () =>
    jest
      .requireActual<typeof import('lib/remote-config/testing/fixture')>('lib/remote-config/testing/fixture')
      .testBridgeSnapshot()
}));

jest.mock('lib/miden/activity', () => ({
  updateBridgedReceivePhase: jest.fn()
}));

const RECIPIENT = '0x00000000000000000000000000000000b64e1827414584510723cad8e145a400' as const;
const MIXED_CASE_RECIPIENT = '0x00000000000000000000000000000000B64E1827414584510723CAD8E145A400' as const;
const ARC_TESTNET_ID = 5042002;
const APPROVE_HASH = `0x${'1'.repeat(64)}` as const;
const DEPOSIT_HASH = `0x${'2'.repeat(64)}` as const;

/** Every dependency records into one `calls` log so the order can be asserted. */
function makeDeps(overrides: Partial<UsdcxDepositDeps> = {}) {
  const calls: string[] = [];
  const deps: UsdcxDepositDeps = {
    sourceChainId: ARC_TESTNET_ID,
    signer: {
      approve: jest.fn(async () => {
        calls.push('approve');
        return APPROVE_HASH;
      }),
      depositToRemote: jest.fn(async () => {
        calls.push('depositToRemote');
        return DEPOSIT_HASH;
      })
    },
    isRemoteDomainRegistered: jest.fn(async () => {
      calls.push('isRemoteDomainRegistered');
      return true;
    }),
    readAllowance: jest.fn(async () => {
      calls.push('readAllowance');
      return 0n;
    }),
    waitForReceipt: jest.fn(async (hash: string) => {
      calls.push(`receipt:${hash === APPROVE_HASH ? 'approve' : 'deposit'}`);
    }),
    updatePhase: jest.fn(async (_id: string, phase: string) => {
      calls.push(`phase:${phase}`);
    }),
    ...overrides
  };
  return { deps, calls };
}

describe('buildDepositToRemoteArgs', () => {
  it('scales the amount to USDC base units and fixes the other parameters', () => {
    expect(buildDepositToRemoteArgs('1.5', RECIPIENT, ARC_TESTNET_ID)).toEqual([
      1_500_000n,
      10007,
      RECIPIENT,
      '0x3600000000000000000000000000000000000000',
      USDCX_DEPOSIT_MAX_FEE,
      USDCX_DEPOSIT_HOOK_DATA
    ]);
  });

  it('names the USDC of the source chain as the local token', () => {
    expect(buildDepositToRemoteArgs('1', RECIPIENT, ARC_TESTNET_ID)[3]).toBe(
      '0x3600000000000000000000000000000000000000'
    );
  });

  // Sepolia's xReserve has no Miden domain, so outside the e2e build Sepolia deposits through the executor.
  it.each([84532, sepolia.id])('refuses chain %i, which has no local xReserve', chainId => {
    expect(() => buildDepositToRemoteArgs('1', RECIPIENT, chainId)).toThrow('no local xReserve');
  });

  it('trims the amount', () => {
    expect(buildDepositToRemoteArgs(' 2 ', RECIPIENT, ARC_TESTNET_ID)[0]).toBe(2_000_000n);
  });
});

describe('runUsdcxDeposit', () => {
  it('runs approve, deposit and the phase writes in order', async () => {
    const { deps, calls } = makeDeps();

    await expect(runUsdcxDeposit('row-1', '1.5', RECIPIENT, deps)).resolves.toBe(DEPOSIT_HASH);

    expect(calls).toEqual([
      'isRemoteDomainRegistered',
      'readAllowance',
      'phase:submitting',
      'approve',
      'receipt:approve',
      'phase:submitting',
      'depositToRemote',
      'phase:submitting',
      'receipt:deposit',
      'phase:delivering'
    ]);
    expect(deps.signer.approve).toHaveBeenCalledWith(getUsdcxXReserveSource(ARC_TESTNET_ID).xReserve, 1_500_000n);
    expect(deps.signer.depositToRemote).toHaveBeenCalledWith(
      buildDepositToRemoteArgs('1.5', RECIPIENT, ARC_TESTNET_ID)
    );
    expect(deps.updatePhase).toHaveBeenCalledWith('row-1', 'submitting', {
      evmTxHash: DEPOSIT_HASH,
      usdcxRemoteRecipient: RECIPIENT
    });
    expect(deps.updatePhase).toHaveBeenCalledWith('row-1', 'delivering', { evmTxHash: DEPOSIT_HASH });
  });

  // The reconciler trusts Circle's attestation only when it names this recipient, so it lands with the hash, before
  // a receipt wait can strand the row.
  it('persists the recipient it signed, lowercased, with the first phase write only', async () => {
    const { deps } = makeDeps();

    await runUsdcxDeposit('row-1', '1', MIXED_CASE_RECIPIENT, deps);

    expect(jest.mocked(deps.updatePhase).mock.calls).toEqual([
      [
        'row-1',
        'submitting',
        undefined,
        undefined,
        {
          claimSourceExecution: {
            provider: 'usdcx',
            source: getUsdcxXReserveSource(ARC_TESTNET_ID),
            recipient: MIXED_CASE_RECIPIENT
          }
        }
      ],
      [
        'row-1',
        'submitting',
        undefined,
        undefined,
        {
          continueSourceExecution: {
            provider: 'usdcx',
            source: getUsdcxXReserveSource(ARC_TESTNET_ID),
            recipient: MIXED_CASE_RECIPIENT
          }
        }
      ],
      ['row-1', 'submitting', { evmTxHash: DEPOSIT_HASH, usdcxRemoteRecipient: RECIPIENT }],
      ['row-1', 'delivering', { evmTxHash: DEPOSIT_HASH }]
    ]);
  });

  it('reads the allowance xReserve has', async () => {
    const { deps } = makeDeps();

    await runUsdcxDeposit('row-1', '1', RECIPIENT, deps);

    expect(deps.readAllowance).toHaveBeenCalledWith(getUsdcxXReserveSource(ARC_TESTNET_ID).xReserve);
  });

  it('takes the xReserve and USDC of the chain the deps name', async () => {
    const { deps } = makeDeps({ sourceChainId: ARC_TESTNET_ID });

    await runUsdcxDeposit('row-1', '1', RECIPIENT, deps);

    expect(deps.readAllowance).toHaveBeenCalledWith(getUsdcxXReserveSource(ARC_TESTNET_ID).xReserve);
    expect(deps.signer.depositToRemote).toHaveBeenCalledWith(buildDepositToRemoteArgs('1', RECIPIENT, ARC_TESTNET_ID));
  });

  // 1.5 USDC is 1_500_000 base units: an allowance equal to it, or more than it, covers the deposit.
  it.each([1_500_000n, 5_000_000n])('skips the approval when the allowance is %s', async allowance => {
    const { deps, calls } = makeDeps({ readAllowance: jest.fn(async () => allowance) });

    await expect(runUsdcxDeposit('row-1', '1.5', RECIPIENT, deps)).resolves.toBe(DEPOSIT_HASH);

    expect(deps.signer.approve).not.toHaveBeenCalled();
    expect(calls).toEqual([
      'isRemoteDomainRegistered',
      'phase:submitting',
      'phase:submitting',
      'depositToRemote',
      'phase:submitting',
      'receipt:deposit',
      'phase:delivering'
    ]);
  });

  it('approves the full amount when the allowance is less than the deposit', async () => {
    const { deps } = makeDeps({ readAllowance: jest.fn(async () => 1_499_999n) });

    await runUsdcxDeposit('row-1', '1.5', RECIPIENT, deps);

    expect(deps.signer.approve).toHaveBeenCalledWith(getUsdcxXReserveSource(ARC_TESTNET_ID).xReserve, 1_500_000n);
  });

  it('checks the remote domain with the configured value', async () => {
    const { deps } = makeDeps();

    await runUsdcxDeposit('row-1', '1', RECIPIENT, deps);

    expect(deps.isRemoteDomainRegistered).toHaveBeenCalledWith(getUsdcxRemoteDomain());
  });

  // xReserve reverts a deposit to an unregistered domain; failing
  // before the approve means no gas is spent and no wallet prompt is shown.
  it('fails before any wallet prompt when the domain is not registered', async () => {
    const { deps } = makeDeps({ isRemoteDomainRegistered: jest.fn(async () => false) });

    const error: unknown = await runUsdcxDeposit('row-1', '1', RECIPIENT, deps).catch(caught => caught);

    expect(error).toBeInstanceOf(UsdcxDomainNotRegisteredError);
    expect(isUsdcxDomainNotRegisteredError(error)).toBe(true);
    expect(error).toMatchObject({ remoteDomain: getUsdcxRemoteDomain() });
    expect(deps.signer.approve).not.toHaveBeenCalled();
    expect(deps.signer.depositToRemote).not.toHaveBeenCalled();
    expect(deps.updatePhase).not.toHaveBeenCalled();
  });

  it('propagates a reverted deposit and leaves the row in submitting', async () => {
    const { deps } = makeDeps({
      waitForReceipt: jest.fn(async (hash: string) => {
        if (hash === DEPOSIT_HASH) throw new Error('Transaction reverted');
      })
    });

    await expect(runUsdcxDeposit('row-1', '1', RECIPIENT, deps)).rejects.toThrow('Transaction reverted');

    expect(deps.updatePhase).toHaveBeenCalledTimes(3);
    expect(deps.updatePhase).toHaveBeenCalledWith('row-1', 'submitting', {
      evmTxHash: DEPOSIT_HASH,
      usdcxRemoteRecipient: RECIPIENT
    });
  });

  it('does not deposit when the approval fails', async () => {
    const { deps } = makeDeps({
      signer: {
        approve: jest.fn(async () => {
          throw new Error('User rejected');
        }),
        depositToRemote: jest.fn()
      }
    });

    await expect(runUsdcxDeposit('row-1', '1', RECIPIENT, deps)).rejects.toThrow('User rejected');

    expect(deps.signer.depositToRemote).not.toHaveBeenCalled();
    expect(deps.updatePhase).toHaveBeenCalledTimes(1);
    expect(deps.updatePhase).toHaveBeenCalledWith('row-1', 'submitting', undefined, undefined, {
      claimSourceExecution: { provider: 'usdcx', source: getUsdcxXReserveSource(ARC_TESTNET_ID), recipient: RECIPIENT }
    });
  });

  it('recognises only its own error class', () => {
    expect(isUsdcxDomainNotRegisteredError(new Error('other'))).toBe(false);
  });
});

it('uses one captured xReserve route when the configuration changes during the domain read', async () => {
  const source = getUsdcxXReserveSource(ARC_TESTNET_ID);
  const changed = testBridgeSnapshot();
  const deposit = changed.config?.supportedEvmChains['arc-testnet']?.bridges.usdcx?.deposit;
  if (!deposit || deposit.route !== 'xreserve') throw new Error('The test route is missing');
  deposit.xReserve = '0x1111111111111111111111111111111111111111';
  const snapshotRead = jest.spyOn(bridgeRuntime, 'getBridgeConfigSnapshot');
  const { deps } = makeDeps({
    source,
    isRemoteDomainRegistered: jest.fn(async () => {
      snapshotRead.mockReturnValue(changed);
      return true;
    })
  });
  try {
    await runUsdcxDeposit('row-1', '1', RECIPIENT, deps);
    expect(deps.signer.approve).toHaveBeenCalledWith(source.xReserve, 1_000_000n);
    expect(deps.signer.depositToRemote).toHaveBeenCalledWith([
      1_000_000n,
      source.midenDomain,
      RECIPIENT,
      source.usdc,
      0n,
      '0x'
    ]);
  } finally {
    snapshotRead.mockRestore();
  }
});

it("re-exports the protocol's domain error, so a check against either module holds for both", () => {
  expect(UsdcxDomainNotRegisteredError).toBe(protocol.UsdcxDomainNotRegisteredError);
  expect(isUsdcxDomainNotRegisteredError(new protocol.UsdcxDomainNotRegisteredError(10007))).toBe(true);
});
