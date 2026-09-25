import {
  CIRCLE_USDC_SEPOLIA_ADDRESS,
  USDCX_DEPOSIT_HOOK_DATA,
  USDCX_DEPOSIT_MAX_FEE,
  USDCX_REMOTE_DOMAIN,
  XRESERVE_SEPOLIA_ADDRESS
} from './constant';
import {
  buildDepositToRemoteArgs,
  isUsdcxDomainNotRegisteredError,
  runUsdcxDeposit,
  UsdcxDepositDeps,
  UsdcxDomainNotRegisteredError
} from './deposit';

jest.mock('lib/miden/activity', () => ({
  updateBridgedReceivePhase: jest.fn()
}));

const RECIPIENT = '0x00000000000000000000000000000000b64e1827414584510723cad8e145a400' as const;
const APPROVE_HASH = `0x${'1'.repeat(64)}` as const;
const DEPOSIT_HASH = `0x${'2'.repeat(64)}` as const;

/** Every dependency records into one `calls` log so the order can be asserted. */
function makeDeps(overrides: Partial<UsdcxDepositDeps> = {}) {
  const calls: string[] = [];
  const deps: UsdcxDepositDeps = {
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
    expect(buildDepositToRemoteArgs('1.5', RECIPIENT)).toEqual([
      1_500_000n,
      USDCX_REMOTE_DOMAIN,
      RECIPIENT,
      CIRCLE_USDC_SEPOLIA_ADDRESS,
      USDCX_DEPOSIT_MAX_FEE,
      USDCX_DEPOSIT_HOOK_DATA
    ]);
  });

  it('trims the amount', () => {
    expect(buildDepositToRemoteArgs(' 2 ', RECIPIENT)[0]).toBe(2_000_000n);
  });
});

describe('runUsdcxDeposit', () => {
  it('runs approve, deposit and the phase writes in order', async () => {
    const { deps, calls } = makeDeps();

    await expect(runUsdcxDeposit('row-1', '1.5', RECIPIENT, deps)).resolves.toBe(DEPOSIT_HASH);

    expect(calls).toEqual([
      'isRemoteDomainRegistered',
      'approve',
      'receipt:approve',
      'depositToRemote',
      'phase:submitting',
      'receipt:deposit',
      'phase:delivering'
    ]);
    expect(deps.signer.approve).toHaveBeenCalledWith(XRESERVE_SEPOLIA_ADDRESS, 1_500_000n);
    expect(deps.signer.depositToRemote).toHaveBeenCalledWith(buildDepositToRemoteArgs('1.5', RECIPIENT));
    expect(deps.updatePhase).toHaveBeenCalledWith('row-1', 'submitting', { evmTxHash: DEPOSIT_HASH });
    expect(deps.updatePhase).toHaveBeenCalledWith('row-1', 'delivering', { evmTxHash: DEPOSIT_HASH });
  });

  it('checks the remote domain with the configured value', async () => {
    const { deps } = makeDeps();

    await runUsdcxDeposit('row-1', '1', RECIPIENT, deps);

    expect(deps.isRemoteDomainRegistered).toHaveBeenCalledWith(USDCX_REMOTE_DOMAIN);
  });

  // The Sepolia xReserve reverts a deposit to an unregistered domain; failing
  // before the approve means no gas is spent and no wallet prompt is shown.
  it('fails before any wallet prompt when the domain is not registered', async () => {
    const { deps } = makeDeps({ isRemoteDomainRegistered: jest.fn(async () => false) });

    const error: unknown = await runUsdcxDeposit('row-1', '1', RECIPIENT, deps).catch(caught => caught);

    expect(error).toBeInstanceOf(UsdcxDomainNotRegisteredError);
    expect(isUsdcxDomainNotRegisteredError(error)).toBe(true);
    expect(error).toMatchObject({ remoteDomain: USDCX_REMOTE_DOMAIN });
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

    expect(deps.updatePhase).toHaveBeenCalledTimes(1);
    expect(deps.updatePhase).toHaveBeenCalledWith('row-1', 'submitting', { evmTxHash: DEPOSIT_HASH });
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
    expect(deps.updatePhase).not.toHaveBeenCalled();
  });

  it('recognises only its own error class', () => {
    expect(isUsdcxDomainNotRegisteredError(new Error('other'))).toBe(false);
  });
});
