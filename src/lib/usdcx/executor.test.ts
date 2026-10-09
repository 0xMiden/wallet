import { decodeAbiParameters, decodeFunctionData, hexToString, padHex, size, slice } from 'viem';
import { baseSepolia } from 'viem/chains';

import {
  CCTP_EXECUTOR_HOOK_NAME,
  getUsdcxExecutorSource,
  TOKEN_MESSENGER_V2_ADDRESS,
  USDCX_REMOTE_DOMAIN,
  XRESERVE_ABI
} from './constant';
import {
  addressToBytes32,
  buildDepositForBurnWithHookArgs,
  encodeDepositForHandlerData,
  encodeExecutorHookData,
  encodeExecutorPayload,
  encodeHookFrame,
  encodeXReserveDepositCalldata,
  isUsdcxExecutorDomainNotRegisteredError,
  runUsdcxExecutorDeposit,
  UsdcxExecutorDepositDeps,
  UsdcxExecutorDomainNotRegisteredError
} from './executor';

jest.mock('lib/miden/activity', () => ({
  updateBridgedReceivePhase: jest.fn()
}));

const SOURCE = getUsdcxExecutorSource(baseSepolia.id);
const TARGET = SOURCE.target;
const RECIPIENT = '0x00000000000000000000000000000000b64e1827414584510723cad8e145a400' as const;
const DEPOSITOR = '0x1111111111111111111111111111111111111111' as const;
const APPROVE_HASH = `0x${'1'.repeat(64)}` as const;
const BURN_HASH = `0x${'2'.repeat(64)}` as const;

/** Round a byte length up to a 32-byte word, as `abi.encode` pads a `bytes` tail. */
const ceil32 = (length: number) => Math.ceil(length / 32) * 32;

describe('encodeHookFrame', () => {
  // [magic(24) | version(4) | payloadLength(4) | payload], the layout `ComposableHookData._findHook` scans.
  it('writes the 32-byte header the executor parses, with the name right-padded', () => {
    const frame = encodeHookFrame(CCTP_EXECUTOR_HOOK_NAME, '0xdeadbeef');
    expect(size(frame)).toBe(36);
    expect(hexToString(slice(frame, 0, 24)).replace(/\0+$/, '')).toBe(CCTP_EXECUTOR_HOOK_NAME);
    expect(slice(frame, 24, 28)).toBe('0x00000001');
    expect(slice(frame, 28, 32)).toBe('0x00000004');
    expect(slice(frame, 32)).toBe('0xdeadbeef');
  });

  it('refuses a name longer than 24 bytes', () => {
    expect(() => encodeHookFrame('a'.repeat(25), '0x')).toThrow('longer than 24 bytes');
  });
});

describe('executor hook data', () => {
  it('right-aligns an address in 32 bytes', () => {
    expect(addressToBytes32(DEPOSITOR)).toBe(`0x${'0'.repeat(24)}${DEPOSITOR.slice(2)}`);
  });

  it('asks Arc xReserve to deposit for Miden with a zero amount the handler overwrites', () => {
    const decoded = decodeFunctionData({ abi: XRESERVE_ABI, data: encodeXReserveDepositCalldata(TARGET, RECIPIENT) });
    expect(decoded.functionName).toBe('depositToRemote');
    expect(decoded.args).toEqual([0n, USDCX_REMOTE_DOMAIN, RECIPIENT, TARGET.usdc, 0n, '0x']);
  });

  // `DepositForHandler.handle` decodes (address, address, bytes, uint256[]) and checks the exact length.
  it('encodes the handler data as the handler decodes it, with xReserve pulling at calldata index 4', () => {
    const data = encodeDepositForHandlerData(TARGET, RECIPIENT);
    const [depositContract, approvalTarget, depositCalldata, amountIndices] = decodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'bytes' }, { type: 'uint256[]' }],
      data
    );
    expect(depositContract).toBe(TARGET.xReserve);
    expect(approvalTarget).toBe(TARGET.xReserve);
    expect(depositCalldata).toBe(encodeXReserveDepositCalldata(TARGET, RECIPIENT));
    expect(amountIndices).toEqual([4n]);
    expect(size(data)).toBe(192 + ceil32(size(depositCalldata)) + amountIndices.length * 32);
  });

  // `GenericExecutor._decodeAndValidatePayload` decodes (uint8, bytes32, address, bytes) and checks the exact length.
  it('encodes the executor payload as the executor decodes it: version 1, depositor, handler, handler data', () => {
    const payload = encodeExecutorPayload(TARGET, RECIPIENT, DEPOSITOR);
    const [version, recoveryAddress, handler, handlerCalldata] = decodeAbiParameters(
      [{ type: 'uint8' }, { type: 'bytes32' }, { type: 'address' }, { type: 'bytes' }],
      payload
    );
    expect(version).toBe(1);
    expect(recoveryAddress).toBe(padHex(DEPOSITOR, { size: 32 }));
    expect(handler).toBe(TARGET.handler);
    expect(handlerCalldata).toBe(encodeDepositForHandlerData(TARGET, RECIPIENT));
    expect(size(payload)).toBe(160 + ceil32(size(handlerCalldata)));
  });

  it('wraps the payload in one executor frame and no forward frame', () => {
    const hookData = encodeExecutorHookData(TARGET, RECIPIENT, DEPOSITOR);
    const payload = encodeExecutorPayload(TARGET, RECIPIENT, DEPOSITOR);
    expect(hookData).toBe(encodeHookFrame(CCTP_EXECUTOR_HOOK_NAME, payload));
    expect(size(hookData)).toBe(32 + size(payload));
    expect(hookData.includes(Buffer.from('cctp-forward').toString('hex'))).toBe(false);
  });
});

describe('buildDepositForBurnWithHookArgs', () => {
  it('burns a standard transfer to Arc that mints to the executor and binds it as destination caller', () => {
    const executor = addressToBytes32(TARGET.executor);
    expect(buildDepositForBurnWithHookArgs('1.5', SOURCE, RECIPIENT, DEPOSITOR)).toEqual([
      1_500_000n,
      26,
      executor,
      SOURCE.usdc,
      executor,
      0n,
      2000,
      encodeExecutorHookData(TARGET, RECIPIENT, DEPOSITOR)
    ]);
  });

  it('refuses a depositor that is not an address', () => {
    expect(() => buildDepositForBurnWithHookArgs('1', SOURCE, RECIPIENT, '0xnope' as never)).toThrow(
      'Invalid EVM address'
    );
  });
});

/** Every dependency records into one `calls` log so the order can be asserted. */
function makeDeps(overrides: Partial<UsdcxExecutorDepositDeps> = {}) {
  const calls: string[] = [];
  const deps: UsdcxExecutorDepositDeps = {
    source: SOURCE,
    depositor: DEPOSITOR,
    signer: {
      approve: jest.fn(async () => {
        calls.push('approve');
        return APPROVE_HASH;
      }),
      depositForBurnWithHook: jest.fn(async () => {
        calls.push('depositForBurnWithHook');
        return BURN_HASH;
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
      calls.push(`receipt:${hash === APPROVE_HASH ? 'approve' : 'burn'}`);
    }),
    updatePhase: jest.fn(async (_id: string, phase: string) => {
      calls.push(`phase:${phase}`);
    }),
    ...overrides
  };
  return { deps, calls };
}

describe('runUsdcxExecutorDeposit', () => {
  it('checks Arc, approves the token messenger, burns and writes the phases in order', async () => {
    const { deps, calls } = makeDeps();

    await expect(runUsdcxExecutorDeposit('row-1', '1.5', RECIPIENT, deps)).resolves.toBe(BURN_HASH);

    expect(calls).toEqual([
      'isRemoteDomainRegistered',
      'readAllowance',
      'approve',
      'receipt:approve',
      'depositForBurnWithHook',
      'phase:submitting',
      'receipt:burn',
      'phase:delivering'
    ]);
    expect(deps.isRemoteDomainRegistered).toHaveBeenCalledWith(USDCX_REMOTE_DOMAIN);
    expect(deps.readAllowance).toHaveBeenCalledWith(TOKEN_MESSENGER_V2_ADDRESS);
    expect(deps.signer.approve).toHaveBeenCalledWith(TOKEN_MESSENGER_V2_ADDRESS, 1_500_000n);
    expect(deps.signer.depositForBurnWithHook).toHaveBeenCalledWith(
      buildDepositForBurnWithHookArgs('1.5', SOURCE, RECIPIENT, DEPOSITOR)
    );
    // The burn's domain is written with the hash, so the reconciler knows which Iris messages to read.
    expect(deps.updatePhase).toHaveBeenCalledWith('row-1', 'submitting', {
      evmTxHash: BURN_HASH,
      cctp: { sourceDomain: 6 }
    });
    expect(deps.updatePhase).toHaveBeenCalledWith('row-1', 'delivering', { evmTxHash: BURN_HASH });
  });

  it('skips the approval when the allowance covers the burn', async () => {
    const { deps, calls } = makeDeps({ readAllowance: jest.fn(async () => 1_500_000n) });

    await runUsdcxExecutorDeposit('row-1', '1.5', RECIPIENT, deps);

    expect(deps.signer.approve).not.toHaveBeenCalled();
    expect(calls).toEqual([
      'isRemoteDomainRegistered',
      'depositForBurnWithHook',
      'phase:submitting',
      'receipt:burn',
      'phase:delivering'
    ]);
  });

  it('fails before any wallet prompt when Arc xReserve has no Miden domain', async () => {
    const { deps } = makeDeps({ isRemoteDomainRegistered: jest.fn(async () => false) });

    const error: unknown = await runUsdcxExecutorDeposit('row-1', '1', RECIPIENT, deps).catch(caught => caught);

    expect(error).toBeInstanceOf(UsdcxExecutorDomainNotRegisteredError);
    expect(isUsdcxExecutorDomainNotRegisteredError(error)).toBe(true);
    expect(deps.signer.approve).not.toHaveBeenCalled();
    expect(deps.signer.depositForBurnWithHook).not.toHaveBeenCalled();
    expect(deps.updatePhase).not.toHaveBeenCalled();
  });

  it('propagates a reverted burn and leaves the row in submitting', async () => {
    const { deps } = makeDeps({
      waitForReceipt: jest.fn(async (hash: string) => {
        if (hash === BURN_HASH) throw new Error('Transaction reverted');
      })
    });

    await expect(runUsdcxExecutorDeposit('row-1', '1', RECIPIENT, deps)).rejects.toThrow('Transaction reverted');

    expect(deps.updatePhase).toHaveBeenCalledTimes(1);
    expect(deps.updatePhase).toHaveBeenCalledWith(
      'row-1',
      'submitting',
      expect.objectContaining({ evmTxHash: BURN_HASH })
    );
  });
});
