import { decodeAbiParameters, decodeFunctionData, hexToString, padHex, size, slice } from 'viem';
import { baseSepolia } from 'viem/chains';

import { CctpBurnQuote } from './cctp';
import {
  CCTP_EXECUTOR_HOOK_NAME,
  CCTP_FORWARD_HOOK_NAME,
  getUsdcxExecutorSource,
  getUsdcxRemoteDomain,
  XRESERVE_ABI
} from './constant';
import { isUsdcxDomainNotRegisteredError, UsdcxDomainNotRegisteredError } from './deposit';
import {
  addressToBytes32,
  buildDepositForBurnWithHookAndFeesArgs,
  buildExecutorBurnIntent,
  encodeDepositForHandlerData,
  encodeExecutorHookData,
  encodeExecutorPayload,
  encodeHookFrame,
  encodeXReserveDepositCalldata,
  isUsdcxExecutorBalanceTooLowError,
  isUsdcxForwardQuoteUnavailableError,
  runUsdcxExecutorDeposit,
  UsdcxExecutorBalanceTooLowError,
  UsdcxExecutorDepositDeps,
  UsdcxExecutorFeeShortfall,
  usdcxExecutorFeeShortfall,
  UsdcxForwardQuoteUnavailableError
} from './executor';

jest.mock('lib/remote-config/runtime', () => ({
  getBridgeConfigSnapshot: () =>
    jest
      .requireActual<typeof import('lib/remote-config/testing/fixture')>('lib/remote-config/testing/fixture')
      .testBridgeSnapshot()
}));

jest.mock('lib/miden/activity', () => ({
  updateBridgedReceivePhase: jest.fn()
}));

const SOURCE = getUsdcxExecutorSource(baseSepolia.id);
const TARGET = SOURCE.target;
const RECIPIENT = '0x00000000000000000000000000000000b64e1827414584510723cad8e145a400' as const;
const MIXED_CASE_RECIPIENT = '0x00000000000000000000000000000000B64E1827414584510723CAD8E145A400' as const;
const DEPOSITOR = '0x1111111111111111111111111111111111111111' as const;
const APPROVE_HASH = `0x${'1'.repeat(64)}` as const;
const BURN_HASH = `0x${'2'.repeat(64)}` as const;
/** Circle's sandbox priced a 4 USDC Arbitrum Sepolia burn at 31,908 base units: forward plus fast fee. */
// Valid for two minutes from the test run; only an approval makes the runner quote again.
const QUOTE: CctpBurnQuote = {
  signedQuote: '0x0102',
  feeTotalAmount: 31_908n,
  expiresAt: Math.floor(Date.now() / 1000) + 120
};
/** The quote Circle signs when asked again after the approval. */
const REQUOTE: CctpBurnQuote = { ...QUOTE, signedQuote: '0x0304' };

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
    expect(decoded.args).toEqual([0n, getUsdcxRemoteDomain(), RECIPIENT, TARGET.usdc, 0n, '0x']);
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

  // Circle's forwarder looks for an empty `cctp-forward` frame; the executor frame follows it unchanged.
  it('puts an empty forward frame ahead of the executor frame', () => {
    const hookData = encodeExecutorHookData(TARGET, RECIPIENT, DEPOSITOR);
    const payload = encodeExecutorPayload(TARGET, RECIPIENT, DEPOSITOR);
    expect(slice(hookData, 0, 32)).toBe(encodeHookFrame(CCTP_FORWARD_HOOK_NAME, '0x'));
    expect(slice(hookData, 32)).toBe(encodeHookFrame(CCTP_EXECUTOR_HOOK_NAME, payload));
    expect(size(hookData)).toBe(64 + size(payload));
  });
});

describe('forwarded burn', () => {
  it('binds the quote and the burn to the same executor caller and forwarded hook data', () => {
    const intent = buildExecutorBurnIntent('1.5', SOURCE, RECIPIENT, DEPOSITOR);
    expect(intent).toEqual({
      value: 1_500_000n,
      destinationCaller: addressToBytes32(TARGET.executor),
      hookData: encodeExecutorHookData(TARGET, RECIPIENT, DEPOSITOR)
    });
    expect(buildDepositForBurnWithHookAndFeesArgs(SOURCE, intent, QUOTE, DEPOSITOR)).toEqual([
      1_500_000n,
      26,
      intent.destinationCaller,
      SOURCE.usdc,
      intent.destinationCaller,
      intent.hookData,
      { signedQuote: QUOTE.signedQuote, refundAddress: DEPOSITOR }
    ]);
  });

  it('refuses a depositor that is not an address', () => {
    expect(() => buildExecutorBurnIntent('1', SOURCE, RECIPIENT, '0xnope' as never)).toThrow('Invalid EVM address');
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
      depositForBurnWithHookAndFees: jest.fn(async () => {
        calls.push('depositForBurnWithHookAndFees');
        return BURN_HASH;
      })
    },
    fetchQuote: jest.fn(async () => {
      calls.push('quote');
      return calls.filter(call => call === 'quote').length > 1 ? REQUOTE : QUOTE;
    }),
    isRemoteDomainRegistered: jest.fn(async () => {
      calls.push('isRemoteDomainRegistered');
      return true;
    }),
    readAllowance: jest.fn(async () => {
      calls.push('readAllowance');
      return 0n;
    }),
    readBalance: jest.fn(async () => {
      calls.push('readBalance');
      return 10_000_000n;
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

describe('usdcxExecutorFeeShortfall', () => {
  const VALUE = 1_500_000n;
  const FEE = QUOTE.feeTotalAmount;

  it.each<[string, bigint, UsdcxExecutorFeeShortfall | undefined]>([
    ['falls one unit short of', VALUE + FEE - 1n, { needed: VALUE + FEE, fee: FEE, balance: VALUE + FEE - 1n }],
    ['is exactly', VALUE + FEE, undefined],
    ['is one unit over', VALUE + FEE + 1n, undefined]
  ])('holds a balance that %s the amount plus the fee', (_case, balance, shortfall) => {
    expect(usdcxExecutorFeeShortfall(VALUE, FEE, balance)).toEqual(shortfall);
  });
});

describe('runUsdcxExecutorDeposit', () => {
  it('checks Arc, reads the allowance, quotes, approves with headroom, re-quotes, burns and writes the phases', async () => {
    const { deps, calls } = makeDeps();

    await expect(runUsdcxExecutorDeposit('row-1', '1.5', RECIPIENT, deps)).resolves.toBe(BURN_HASH);

    // The allowance and balance reads come before the quote, so no read sits between a quote and its burn; the approval
    // prompt and its receipt can outlast a quote that lives about two minutes and the balance read before it, so both
    // are taken again after the approval, the balance first.
    expect(calls).toEqual([
      'isRemoteDomainRegistered',
      'readAllowance',
      'readBalance',
      'quote',
      'phase:submitting',
      'approve',
      'receipt:approve',
      'readBalance',
      'quote',
      'phase:submitting',
      'depositForBurnWithHookAndFees',
      'phase:submitting',
      'receipt:burn',
      'phase:delivering'
    ]);
    expect(deps.isRemoteDomainRegistered).toHaveBeenCalledWith(getUsdcxRemoteDomain());
    expect(deps.readAllowance).toHaveBeenCalledWith(SOURCE.tokenMessengerWithFees);
    expect(deps.signer.approve).toHaveBeenCalledWith(
      SOURCE.tokenMessengerWithFees,
      1_500_000n + 2n * QUOTE.feeTotalAmount
    );
    const intent = buildExecutorBurnIntent('1.5', SOURCE, RECIPIENT, DEPOSITOR);
    expect(deps.fetchQuote).toHaveBeenCalledTimes(2);
    expect(deps.fetchQuote).toHaveBeenCalledWith(intent);
    expect(deps.signer.depositForBurnWithHookAndFees).toHaveBeenCalledWith(
      buildDepositForBurnWithHookAndFeesArgs(SOURCE, intent, REQUOTE, DEPOSITOR)
    );
    // The burn's domain and the fact it was forwarded are written with the hash, so the reconciler waits
    // for Circle's forward transaction instead of offering the execute.
    expect(deps.updatePhase).toHaveBeenCalledWith('row-1', 'submitting', {
      evmTxHash: BURN_HASH,
      usdcxRemoteRecipient: RECIPIENT,
      cctp: { sourceDomain: 6, forwarded: true, forwardFee: '31908' }
    });
    expect(deps.updatePhase).toHaveBeenCalledWith('row-1', 'delivering', { evmTxHash: BURN_HASH });
  });

  // The executor's deposit names the same recipient, so the reconciler can match Circle's attestation of it.
  it('persists the recipient it signed, lowercased, with the first phase write only', async () => {
    const { deps } = makeDeps();

    await runUsdcxExecutorDeposit('row-1', '1.5', MIXED_CASE_RECIPIENT, deps);

    expect(jest.mocked(deps.updatePhase).mock.calls).toEqual([
      [
        'row-1',
        'submitting',
        { cctp: { sourceDomain: 6, forwarded: true, forwardFee: '31908' } },
        undefined,
        { claimSourceExecution: { provider: 'usdcx', source: SOURCE, recipient: MIXED_CASE_RECIPIENT } }
      ],
      [
        'row-1',
        'submitting',
        { cctp: { sourceDomain: 6, forwarded: true, forwardFee: '31908' } },
        undefined,
        { continueSourceExecution: { provider: 'usdcx', source: SOURCE, recipient: MIXED_CASE_RECIPIENT } }
      ],
      [
        'row-1',
        'submitting',
        {
          evmTxHash: BURN_HASH,
          usdcxRemoteRecipient: RECIPIENT,
          cctp: { sourceDomain: 6, forwarded: true, forwardFee: '31908' }
        }
      ],
      ['row-1', 'delivering', { evmTxHash: BURN_HASH }]
    ]);
  });

  // A burn through the plain token messenger is not forwarded by Circle and stops at the executor, so there is no
  // fallback: a refused quote fails the deposit before any wallet prompt, with the refusal as its cause.
  it('fails before any wallet prompt when Circle does not quote', async () => {
    const refusal = new Error('UNSUPPORTED_WORKFLOW');
    const { deps, calls } = makeDeps({
      fetchQuote: jest.fn(async () => {
        calls.push('quote');
        throw refusal;
      })
    });

    const error: unknown = await runUsdcxExecutorDeposit('row-1', '1.5', RECIPIENT, deps).catch(caught => caught);

    expect(error).toBeInstanceOf(UsdcxForwardQuoteUnavailableError);
    expect(isUsdcxForwardQuoteUnavailableError(error)).toBe(true);
    expect(error).toMatchObject({ cause: refusal });
    expect(calls).toEqual(['isRemoteDomainRegistered', 'readAllowance', 'readBalance', 'quote']);
    expect(deps.signer.approve).not.toHaveBeenCalled();
    expect(deps.signer.depositForBurnWithHookAndFees).not.toHaveBeenCalled();
    expect(deps.updatePhase).not.toHaveBeenCalled();
  });

  it('skips the approval when the allowance covers the amount and the fee', async () => {
    const { deps, calls } = makeDeps({ readAllowance: jest.fn(async () => 1_500_000n + QUOTE.feeTotalAmount) });

    await runUsdcxExecutorDeposit('row-1', '1.5', RECIPIENT, deps);

    expect(deps.signer.approve).not.toHaveBeenCalled();
    expect(calls).toEqual([
      'isRemoteDomainRegistered',
      'readBalance',
      'quote',
      'phase:submitting',
      'phase:submitting',
      'depositForBurnWithHookAndFees',
      'phase:submitting',
      'receipt:burn',
      'phase:delivering'
    ]);
  });

  // The one approval leaves twice the quoted fee, so a fee that moved by the second quote is still covered.
  it('signs the re-quote when the fee rose within the approved headroom', async () => {
    const rose: CctpBurnQuote = { ...REQUOTE, feeTotalAmount: 40_000n };
    const { deps, calls } = makeDeps({
      fetchQuote: jest.fn(async () => {
        calls.push('quote');
        return calls.filter(call => call === 'quote').length > 1 ? rose : QUOTE;
      })
    });

    await runUsdcxExecutorDeposit('row-1', '1.5', RECIPIENT, deps);

    expect(jest.mocked(deps.signer.approve).mock.calls).toEqual([
      [SOURCE.tokenMessengerWithFees, 1_500_000n + 2n * QUOTE.feeTotalAmount]
    ]);
    expect(deps.signer.depositForBurnWithHookAndFees).toHaveBeenCalledWith(
      buildDepositForBurnWithHookAndFeesArgs(
        SOURCE,
        buildExecutorBurnIntent('1.5', SOURCE, RECIPIENT, DEPOSITOR),
        rose,
        DEPOSITOR
      )
    );
  });

  // At most one approval goes to the fee entry point: a fee beyond the headroom fails the deposit before the burn.
  it('fails before the burn prompt when the fee rises beyond the approved headroom', async () => {
    const { deps, calls } = makeDeps({
      fetchQuote: jest.fn(async () => {
        calls.push('quote');
        return calls.filter(call => call === 'quote').length > 1 ? { ...REQUOTE, feeTotalAmount: 70_000n } : QUOTE;
      })
    });

    await expect(runUsdcxExecutorDeposit('row-1', '1.5', RECIPIENT, deps)).rejects.toBeInstanceOf(
      UsdcxForwardQuoteUnavailableError
    );

    expect(deps.fetchQuote).toHaveBeenCalledTimes(2);
    expect(jest.mocked(deps.signer.approve).mock.calls).toEqual([
      [SOURCE.tokenMessengerWithFees, 1_500_000n + 2n * QUOTE.feeTotalAmount]
    ]);
    expect(deps.signer.depositForBurnWithHookAndFees).not.toHaveBeenCalled();
    expect(deps.updatePhase).toHaveBeenCalledTimes(1);
    expect(deps.updatePhase).toHaveBeenCalledWith(
      'row-1',
      'submitting',
      { cctp: { sourceDomain: 6, forwarded: true, forwardFee: QUOTE.feeTotalAmount.toString() } },
      undefined,
      { claimSourceExecution: { provider: 'usdcx', source: SOURCE, recipient: RECIPIENT } }
    );
  });

  // Circle's expiry is never compared with the device clock: a fast clock must not refuse every deposit.
  it('signs a fresh first quote whose expiry already reads as past on the device clock', async () => {
    const skewed = { ...QUOTE, expiresAt: Math.floor(Date.now() / 1000) - 100 };
    const { deps } = makeDeps({
      readAllowance: jest.fn(async () => 10_000_000n),
      fetchQuote: jest.fn(async () => skewed)
    });

    await runUsdcxExecutorDeposit('row-1', '1.5', RECIPIENT, deps);

    expect(deps.fetchQuote).toHaveBeenCalledTimes(1);
    expect(deps.signer.approve).not.toHaveBeenCalled();
    expect(deps.signer.depositForBurnWithHookAndFees).toHaveBeenCalledWith(
      buildDepositForBurnWithHookAndFeesArgs(
        SOURCE,
        buildExecutorBurnIntent('1.5', SOURCE, RECIPIENT, DEPOSITOR),
        skewed,
        DEPOSITOR
      )
    );
  });

  it('fails after the approval when Circle does not quote again', async () => {
    const { deps, calls } = makeDeps({
      fetchQuote: jest.fn(async () => {
        calls.push('quote');
        if (calls.filter(call => call === 'quote').length > 1) throw new Error('UNSUPPORTED_WORKFLOW');
        return QUOTE;
      })
    });

    await expect(runUsdcxExecutorDeposit('row-1', '1.5', RECIPIENT, deps)).rejects.toBeInstanceOf(
      UsdcxForwardQuoteUnavailableError
    );

    expect(jest.mocked(deps.signer.approve).mock.calls).toEqual([
      [SOURCE.tokenMessengerWithFees, 1_500_000n + 2n * QUOTE.feeTotalAmount]
    ]);
    expect(deps.signer.depositForBurnWithHookAndFees).not.toHaveBeenCalled();
    expect(deps.updatePhase).toHaveBeenCalledTimes(1);
    expect(deps.updatePhase).toHaveBeenCalledWith(
      'row-1',
      'submitting',
      { cctp: { sourceDomain: 6, forwarded: true, forwardFee: QUOTE.feeTotalAmount.toString() } },
      undefined,
      { claimSourceExecution: { provider: 'usdcx', source: SOURCE, recipient: RECIPIENT } }
    );
  });

  // The fee entry point's allowance is read before the quote; a failed read fails the deposit before any prompt.
  it('fails before the quote when the fee entry point allowance read fails', async () => {
    const { deps } = makeDeps({
      readAllowance: jest.fn(async () => {
        throw new Error('rpc down');
      })
    });

    await expect(runUsdcxExecutorDeposit('row-1', '1.5', RECIPIENT, deps)).rejects.toThrow('rpc down');

    expect(deps.fetchQuote).not.toHaveBeenCalled();
    expect(deps.signer.approve).not.toHaveBeenCalled();
    expect(deps.signer.depositForBurnWithHookAndFees).not.toHaveBeenCalled();
  });

  it('fails before the quote when the balance read fails', async () => {
    const { deps } = makeDeps({
      readBalance: jest.fn(async () => {
        throw new Error('rpc down');
      })
    });

    await expect(runUsdcxExecutorDeposit('row-1', '1.5', RECIPIENT, deps)).rejects.toThrow('rpc down');

    expect(deps.fetchQuote).not.toHaveBeenCalled();
    expect(deps.signer.approve).not.toHaveBeenCalled();
    expect(deps.signer.depositForBurnWithHookAndFees).not.toHaveBeenCalled();
  });

  it('fails before the burn prompt when the balance read after the approval fails', async () => {
    const { deps } = makeDeps({
      readBalance: jest.fn().mockResolvedValueOnce(10_000_000n).mockRejectedValueOnce(new Error('rpc down'))
    });

    await expect(runUsdcxExecutorDeposit('row-1', '1.5', RECIPIENT, deps)).rejects.toThrow('rpc down');

    expect(deps.signer.approve).toHaveBeenCalledTimes(1);
    expect(deps.signer.depositForBurnWithHookAndFees).not.toHaveBeenCalled();
    expect(deps.updatePhase).toHaveBeenCalledTimes(1);
    expect(deps.updatePhase).toHaveBeenCalledWith(
      'row-1',
      'submitting',
      { cctp: { sourceDomain: 6, forwarded: true, forwardFee: QUOTE.feeTotalAmount.toString() } },
      undefined,
      { claimSourceExecution: { provider: 'usdcx', source: SOURCE, recipient: RECIPIENT } }
    );
  });

  it('re-reads the balance after an approval and refuses the burn when it dropped', async () => {
    const dropped = 1_500_000n;
    const { deps, calls } = makeDeps({
      readBalance: jest.fn(async () => {
        calls.push('readBalance');
        // Enough until the approval, so only a read after it can refuse the burn.
        return calls.includes('approve') ? dropped : 10_000_000n;
      })
    });

    const error: unknown = await runUsdcxExecutorDeposit('row-1', '1.5', RECIPIENT, deps).catch(caught => caught);

    expect(deps.signer.depositForBurnWithHookAndFees).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(UsdcxExecutorBalanceTooLowError);
    expect(error).toMatchObject({
      needed: 1_500_000n + REQUOTE.feeTotalAmount,
      fee: REQUOTE.feeTotalAmount,
      balance: dropped
    });
    expect(deps.signer.approve).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([
      'isRemoteDomainRegistered',
      'readAllowance',
      'readBalance',
      'quote',
      'phase:submitting',
      'approve',
      'receipt:approve',
      'readBalance',
      'quote'
    ]);
    expect(deps.updatePhase).toHaveBeenCalledTimes(1);
    expect(deps.updatePhase).toHaveBeenCalledWith(
      'row-1',
      'submitting',
      { cctp: { sourceDomain: 6, forwarded: true, forwardFee: QUOTE.feeTotalAmount.toString() } },
      undefined,
      { claimSourceExecution: { provider: 'usdcx', source: SOURCE, recipient: RECIPIENT } }
    );
  });

  it('reads the balance once, before the quote, when the allowance already covers', async () => {
    const { deps, calls } = makeDeps({ readAllowance: jest.fn(async () => 10_000_000n) });

    await expect(runUsdcxExecutorDeposit('row-1', '1.5', RECIPIENT, deps)).resolves.toBe(BURN_HASH);

    expect(calls.filter(call => call === 'readBalance' || call === 'quote')).toEqual(['readBalance', 'quote']);
  });

  // The burn pulls Circle's fee on top of the amount, so a balance that covers only the amount paid gas for the
  // approval and then failed at the burn. Refused before the first prompt, whether that is the approval or the burn.
  it.each([
    ['the approval', 0n],
    ['the burn', 1_500_000n + QUOTE.feeTotalAmount]
  ])('refuses before %s when the balance covers the amount but not the fee', async (_prompt, allowance) => {
    const balance = 1_500_000n + QUOTE.feeTotalAmount - 1n;
    const { deps, calls } = makeDeps({
      readAllowance: jest.fn(async () => allowance),
      readBalance: jest.fn(async () => balance)
    });

    const error: unknown = await runUsdcxExecutorDeposit('row-1', '1.5', RECIPIENT, deps).catch(caught => caught);

    expect(error).toBeInstanceOf(UsdcxExecutorBalanceTooLowError);
    expect(isUsdcxExecutorBalanceTooLowError(error)).toBe(true);
    expect(error).toMatchObject({ needed: 1_500_000n + QUOTE.feeTotalAmount, fee: QUOTE.feeTotalAmount, balance });
    expect(calls).toEqual(['isRemoteDomainRegistered', 'quote']);
    expect(deps.signer.approve).not.toHaveBeenCalled();
    expect(deps.signer.depositForBurnWithHookAndFees).not.toHaveBeenCalled();
    expect(deps.updatePhase).not.toHaveBeenCalled();
  });

  it('approves and burns when the balance is exactly the amount plus the fee', async () => {
    const exact = 1_500_000n + QUOTE.feeTotalAmount;
    const { deps } = makeDeps({ readBalance: jest.fn(async () => exact) });

    await expect(runUsdcxExecutorDeposit('row-1', '1.5', RECIPIENT, deps)).resolves.toBe(BURN_HASH);

    expect(deps.signer.approve).toHaveBeenCalledTimes(1);
    expect(deps.signer.depositForBurnWithHookAndFees).toHaveBeenCalledTimes(1);
  });

  // The fee can move between the two quotes: a second fee the approval still covers but the balance does not is
  // refused before the burn prompt.
  it("refuses before the burn prompt when the second quote's fee rises past the balance", async () => {
    const rose: CctpBurnQuote = { ...REQUOTE, feeTotalAmount: 40_000n };
    const { deps, calls } = makeDeps({
      readBalance: jest.fn(async () => 1_535_000n),
      fetchQuote: jest.fn(async () => {
        calls.push('quote');
        return calls.filter(call => call === 'quote').length > 1 ? rose : QUOTE;
      })
    });

    const error: unknown = await runUsdcxExecutorDeposit('row-1', '1.5', RECIPIENT, deps).catch(caught => caught);

    expect(error).toBeInstanceOf(UsdcxExecutorBalanceTooLowError);
    expect(error).toMatchObject({ needed: 1_540_000n, fee: 40_000n, balance: 1_535_000n });
    expect(jest.mocked(deps.signer.approve).mock.calls).toEqual([
      [SOURCE.tokenMessengerWithFees, 1_500_000n + 2n * QUOTE.feeTotalAmount]
    ]);
    expect(deps.signer.depositForBurnWithHookAndFees).not.toHaveBeenCalled();
    expect(deps.updatePhase).toHaveBeenCalledTimes(1);
    expect(deps.updatePhase).toHaveBeenCalledWith(
      'row-1',
      'submitting',
      { cctp: { sourceDomain: 6, forwarded: true, forwardFee: QUOTE.feeTotalAmount.toString() } },
      undefined,
      { claimSourceExecution: { provider: 'usdcx', source: SOURCE, recipient: RECIPIENT } }
    );
  });

  it('approves when the allowance covers the amount but not the fee', async () => {
    const { deps } = makeDeps({ readAllowance: jest.fn(async () => 1_500_000n) });

    await runUsdcxExecutorDeposit('row-1', '1.5', RECIPIENT, deps);

    expect(deps.signer.approve).toHaveBeenCalledWith(
      SOURCE.tokenMessengerWithFees,
      1_500_000n + 2n * QUOTE.feeTotalAmount
    );
  });

  it('fails before any wallet prompt when Arc xReserve has no Miden domain', async () => {
    const { deps } = makeDeps({ isRemoteDomainRegistered: jest.fn(async () => false) });

    const error: unknown = await runUsdcxExecutorDeposit('row-1', '1', RECIPIENT, deps).catch(caught => caught);

    // One error for both routes: the screen maps it to one message.
    expect(error).toBeInstanceOf(UsdcxDomainNotRegisteredError);
    expect(isUsdcxDomainNotRegisteredError(error)).toBe(true);
    expect(deps.fetchQuote).not.toHaveBeenCalled();
    expect(deps.signer.approve).not.toHaveBeenCalled();
    expect(deps.signer.depositForBurnWithHookAndFees).not.toHaveBeenCalled();
    expect(deps.updatePhase).not.toHaveBeenCalled();
  });

  it('propagates a reverted burn and leaves the row in submitting', async () => {
    const { deps } = makeDeps({
      waitForReceipt: jest.fn(async (hash: string) => {
        if (hash === BURN_HASH) throw new Error('Transaction reverted');
      })
    });

    await expect(runUsdcxExecutorDeposit('row-1', '1', RECIPIENT, deps)).rejects.toThrow('Transaction reverted');

    expect(deps.updatePhase).toHaveBeenCalledTimes(3);
    expect(deps.updatePhase).toHaveBeenCalledWith(
      'row-1',
      'submitting',
      expect.objectContaining({ evmTxHash: BURN_HASH })
    );
  });
});

describe('a route without its Miden domain', () => {
  // Every route usdcxSourceChains builds carries one (schema.ts drops a usdcx route without it); the encoders no longer
  // read the live document, which the E2E harness cannot load.
  const { midenDomain: _targetDomain, ...target } = TARGET;
  const { midenDomain: _sourceDomain, ...source } = SOURCE;

  it('refuses to encode the xReserve deposit', () => {
    expect(() => encodeXReserveDepositCalldata(target, RECIPIENT)).toThrow('USDCx Miden domain is not configured');
  });

  it('refuses the deposit before any read or prompt', async () => {
    const { deps, calls } = makeDeps({ source: { ...source, target } });

    await expect(runUsdcxExecutorDeposit('row-1', '1', RECIPIENT, deps)).rejects.toThrow(
      'USDCx Miden domain is not configured'
    );
    expect(calls).toEqual([]);
  });

  // The target keeps its domain, so the intent builds and only the source route's own check can refuse.
  it("refuses a source route without it before Arc's registration read", async () => {
    const { deps, calls } = makeDeps({ source: { ...source, target: TARGET } });

    await expect(runUsdcxExecutorDeposit('row-1', '1', RECIPIENT, deps)).rejects.toThrow(
      'USDCx Miden domain is not configured'
    );
    expect(calls).toEqual([]);
    expect(deps.isRemoteDomainRegistered).not.toHaveBeenCalled();
  });
});
