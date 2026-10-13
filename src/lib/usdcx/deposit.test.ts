import { sepolia } from 'viem/chains';

import { TEST_BRIDGE_CONFIG, TEST_BRIDGE_CONFIG_SNAPSHOT } from 'lib/epoch/testing/bridge-config';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';

import { USDCX_DEPOSIT_HOOK_DATA, USDCX_DEPOSIT_MAX_FEE } from './constant';
import {
  buildDepositToRemoteArgs,
  isUsdcxDomainNotRegisteredError,
  runUsdcxDeposit,
  UsdcxDepositDeps,
  UsdcxDomainNotRegisteredError
} from './deposit';
import {
  parseUsdcxSection,
  TEST_USDCX_MIDEN_DOMAIN,
  TEST_USDCX_SECTION,
  testUsdcxXReserveSource
} from './testing/config';

// The deposit reads its chain's contracts from the network's bridge config.
let mockBridgeSnapshot: BridgeConfigSnapshot = TEST_BRIDGE_CONFIG_SNAPSHOT;
jest.mock('lib/remote-config/runtime', () =>
  jest
    .requireActual<typeof import('lib/epoch/testing/bridge-config')>('lib/epoch/testing/bridge-config')
    .remoteConfigRuntimeMock(() => mockBridgeSnapshot)
);
afterEach(() => {
  mockBridgeSnapshot = TEST_BRIDGE_CONFIG_SNAPSHOT;
});

const USDCX_REMOTE_DOMAIN = TEST_USDCX_MIDEN_DOMAIN;
/** A document in which Sepolia has its own xReserve, as the one the E2E Sepolia fork serves. */
const SEPOLIA_XRESERVE = '0x008888878f94C0d87defdf0B07f46B93C1934442';
const SEPOLIA_XRESERVE_SNAPSHOT: BridgeConfigSnapshot = {
  ...TEST_BRIDGE_CONFIG_SNAPSHOT,
  config: {
    ...TEST_BRIDGE_CONFIG,
    usdcx: parseUsdcxSection({
      ...TEST_USDCX_SECTION,
      chains: {
        sepolia: {
          ...TEST_USDCX_SECTION.chains.sepolia,
          deposit: { route: 'xreserve', xReserve: SEPOLIA_XRESERVE }
        }
      }
    })
  }
};

jest.mock('lib/miden/activity', () => ({
  updateBridgedReceivePhase: jest.fn()
}));

const RECIPIENT = '0x00000000000000000000000000000000b64e1827414584510723cad8e145a400' as const;
const MIXED_CASE_RECIPIENT = '0x00000000000000000000000000000000B64E1827414584510723CAD8E145A400' as const;
const ARC_TESTNET_ID = 5042002;
const ARC_XRESERVE = testUsdcxXReserveSource(ARC_TESTNET_ID).xReserve;
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
    mockBridgeSnapshot = SEPOLIA_XRESERVE_SNAPSHOT;
    expect(buildDepositToRemoteArgs('1', RECIPIENT, sepolia.id)[3]).toBe('0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238');
  });

  // Sepolia's xReserve has no Miden domain, so the testnet document sends a Sepolia deposit through the executor.
  it.each([84532, sepolia.id])('refuses chain %i, which has no local xReserve', chainId => {
    expect(() => buildDepositToRemoteArgs('1', RECIPIENT, chainId)).toThrow('no local xReserve');
  });

  it('refuses a chain the document does not list, and every chain while it lists none', () => {
    expect(() => buildDepositToRemoteArgs('1', RECIPIENT, 1)).toThrow('not configured');
    const { usdcx: _usdcx, ...config } = TEST_BRIDGE_CONFIG;
    mockBridgeSnapshot = { ...TEST_BRIDGE_CONFIG_SNAPSHOT, config };
    expect(() => buildDepositToRemoteArgs('1', RECIPIENT, ARC_TESTNET_ID)).toThrow('not configured');
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
      'approve',
      'receipt:approve',
      'depositToRemote',
      'phase:submitting',
      'receipt:deposit',
      'phase:delivering'
    ]);
    expect(deps.signer.approve).toHaveBeenCalledWith(ARC_XRESERVE, 1_500_000n);
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
      ['row-1', 'submitting', { evmTxHash: DEPOSIT_HASH, usdcxRemoteRecipient: RECIPIENT }],
      ['row-1', 'delivering', { evmTxHash: DEPOSIT_HASH }]
    ]);
  });

  it('reads the allowance xReserve has', async () => {
    const { deps } = makeDeps();

    await runUsdcxDeposit('row-1', '1', RECIPIENT, deps);

    expect(deps.readAllowance).toHaveBeenCalledWith(ARC_XRESERVE);
  });

  it('takes the xReserve and USDC of the chain the deps name', async () => {
    mockBridgeSnapshot = SEPOLIA_XRESERVE_SNAPSHOT;
    const { deps } = makeDeps({ sourceChainId: sepolia.id });

    await runUsdcxDeposit('row-1', '1', RECIPIENT, deps);

    expect(deps.readAllowance).toHaveBeenCalledWith(SEPOLIA_XRESERVE);
    expect(deps.signer.depositToRemote).toHaveBeenCalledWith(buildDepositToRemoteArgs('1', RECIPIENT, sepolia.id));
  });

  // 1.5 USDC is 1_500_000 base units: an allowance equal to it, or more than it, covers the deposit.
  it.each([1_500_000n, 5_000_000n])('skips the approval when the allowance is %s', async allowance => {
    const { deps, calls } = makeDeps({ readAllowance: jest.fn(async () => allowance) });

    await expect(runUsdcxDeposit('row-1', '1.5', RECIPIENT, deps)).resolves.toBe(DEPOSIT_HASH);

    expect(deps.signer.approve).not.toHaveBeenCalled();
    expect(calls).toEqual([
      'isRemoteDomainRegistered',
      'depositToRemote',
      'phase:submitting',
      'receipt:deposit',
      'phase:delivering'
    ]);
  });

  it('approves the full amount when the allowance is less than the deposit', async () => {
    const { deps } = makeDeps({ readAllowance: jest.fn(async () => 1_499_999n) });

    await runUsdcxDeposit('row-1', '1.5', RECIPIENT, deps);

    expect(deps.signer.approve).toHaveBeenCalledWith(ARC_XRESERVE, 1_500_000n);
  });

  it('checks the remote domain with the configured value', async () => {
    const { deps } = makeDeps();

    await runUsdcxDeposit('row-1', '1', RECIPIENT, deps);

    expect(deps.isRemoteDomainRegistered).toHaveBeenCalledWith(USDCX_REMOTE_DOMAIN);
  });

  // xReserve reverts a deposit to an unregistered domain; failing
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
    expect(deps.updatePhase).not.toHaveBeenCalled();
  });

  it('recognises only its own error class', () => {
    expect(isUsdcxDomainNotRegisteredError(new Error('other'))).toBe(false);
  });
});
