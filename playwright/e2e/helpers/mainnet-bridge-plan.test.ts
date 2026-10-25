import {
  agglayerGasReserve,
  agglayerShortfall,
  bridgeLoops,
  BURN_FEE_MULTIPLE,
  depositGasReserve,
  feePrecheckProblem,
  landedVaultSample,
  LOOP_USDC,
  midenFeeReserve,
  ROUND_TRIP_TXS,
  roundTripReserve,
  TX_FEE_MULTIPLE,
  usdcReserve,
  usdcxLoopsOrFail,
  usdcxShortfall,
  type MainnetBridgeChain
} from './mainnet-bridge-plan';

const CHAINS: MainnetBridgeChain[] = [
  {
    chainId: 5042,
    bridges: { usdcx: { domain: 26, deposit: { route: 'xreserve' }, depositEnabled: true, withdrawalEnabled: true } }
  },
  {
    chainId: 1,
    bridges: {
      agglayer: { contractAddress: '0x2a3dd3eb832af982ec71669e178424b10dca2ede' },
      usdcx: { domain: 0, deposit: { route: 'executor' }, depositEnabled: true, withdrawalEnabled: true }
    }
  },
  {
    chainId: 8453,
    bridges: { usdcx: { domain: 6, deposit: { route: 'executor' }, depositEnabled: true, withdrawalEnabled: true } }
  },
  {
    chainId: 42161,
    bridges: { usdcx: { domain: 3, deposit: { route: 'executor' }, depositEnabled: true, withdrawalEnabled: true } }
  }
];

describe('mainnet bridge loops', () => {
  it('lists Arc, Base, Arbitrum, Ethereum USDCx, then AggLayer', () => {
    expect(bridgeLoops(CHAINS)).toEqual([
      { kind: 'usdcx', name: 'arc', chainId: 5042, route: 'xreserve', domain: 26 },
      { kind: 'usdcx', name: 'base', chainId: 8453, route: 'executor', domain: 6 },
      { kind: 'usdcx', name: 'arbitrum', chainId: 42161, route: 'executor', domain: 3 },
      { kind: 'usdcx', name: 'ethereum', chainId: 1, route: 'executor', domain: 0 },
      { kind: 'agglayer', name: 'ethereum', chainId: 1 }
    ]);
  });

  it('keeps 5 USDC moving and reserves tonight plus the fees that do not return', () => {
    const fee = 50_000n;
    expect(LOOP_USDC).toBe(5_000_000n);
    // Deposit headroom is 5 USDC plus twice the quote. Tonight also spends the quote and up to the payout allowance.
    expect(usdcReserve(fee, 100_000n)).toBe(5_000_000n + 2n * fee + fee + 100_000n);
    expect(usdcReserve(fee, 1_500_000n)).toBe(5_000_000n + 3n * fee + 1_500_000n);
  });

  it('refuses a chain that cannot repeat tomorrow, and names the chain', () => {
    const fee = 50_000n;
    const message = usdcxShortfall({
      name: 'base',
      address: '0xabc',
      usdc: LOOP_USDC,
      quotedForwardFee: fee,
      domain: 6,
      native: depositGasReserve(1n),
      maxFeePerGas: 1n
    });
    expect(message).toContain('base 0xabc');
    expect(message).toContain('short of');
    expect(
      usdcxShortfall({
        name: 'base',
        address: '0xabc',
        usdc: usdcReserve(fee, 100_000n),
        quotedForwardFee: fee,
        domain: 6,
        native: depositGasReserve(1n),
        maxFeePerGas: 1n
      })
    ).toBeUndefined();
  });

  it('charges the round-trip funding consume once, before the vault is read', () => {
    const fee = 7n;
    const send = 1n;
    const oneTx = TX_FEE_MULTIPLE * fee;
    const beforeClaim = 2n * (send + ROUND_TRIP_TXS * oneTx);
    expect(roundTripReserve(send, fee, true)).toBe(beforeClaim - oneTx);
    expect(roundTripReserve(send, fee, false)).toBe(beforeClaim);
    expect(() => roundTripReserve(0n, fee, true)).toThrow('positive base-unit amount');
    expect(() => roundTripReserve(send, 0n, true)).toThrow('positive base fee');
  });

  it('prices fees in base-fee units, so a base fee of 7 is a fraction of one USDCx', () => {
    expect(TX_FEE_MULTIPLE * 7n).toBe(210n);
    expect(BURN_FEE_MULTIPLE * 7n).toBe(315n);
    // Four burns and six other transactions, for two nights, at testnet's base fee.
    expect(midenFeeReserve(7n, 4n, 6n)).toBe(5_040n);
  });

  it('reserves two nights of AggLayer gas before it bridges', () => {
    expect(agglayerGasReserve(10n)).toBe(2n * 2n * 600_000n * 10n);
    expect(agglayerShortfall({ address: '0xabc', wei: 1n, maxFeePerGas: 10n })).toContain('short of');
    expect(agglayerShortfall({ address: '0xabc', wei: agglayerGasReserve(10n), maxFeePerGas: 10n })).toBeUndefined();
  });

  it('a funding-gate poll keeps going after a refresh that does not land', async () => {
    const refresh = jest.fn(async (): Promise<void> => undefined);
    refresh.mockRejectedValueOnce(new Error('refreshBalances did not land for account-a'));
    const read = jest.fn(async (): Promise<bigint> => 40n);
    const trace: string[] = [];
    let matched = false;
    // Same shape as expect.poll: the probe is awaited outside the matcher try.
    try {
      for (let lap = 0; lap < 4 && !matched; lap += 1) {
        const value = await landedVaultSample(() => refresh(), read);
        try {
          trace.push(value.toString());
          if (value < 1n) throw new Error('toBeGreaterThanOrEqual');
          matched = true;
        } catch {
          trace.push('retry');
        }
      }
    } catch (error) {
      trace.push(error instanceof Error ? error.message : String(error));
    }
    expect(trace).toEqual(['-1', 'retry', '40']);
    expect(matched).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('a refresh error that is not a missed land still rejects the probe', async () => {
    const read = jest.fn(async (): Promise<bigint> => 40n);
    await expect(
      landedVaultSample(() => Promise.reject(new Error('Execution context was destroyed')), read)
    ).rejects.toThrow('Execution context was destroyed');
    expect(read).not.toHaveBeenCalled();
  });

  it('says when no balance was read', () => {
    const address = '0xabc';
    const need = 5_040n;
    expect(feePrecheckProblem(address, need, undefined)).toBe(
      `${address} native balance was not read within 60s, so the fee precheck cannot say the account is short`
    );
    expect(feePrecheckProblem(address, need, 0n)).toBe(
      `${address} holds 0 native base units, short of ${need} for two nights of bridge fees`
    );
    expect(feePrecheckProblem(address, need, need)).toBeUndefined();
  });
});

describe('usdcxLoopsOrFail', () => {
  it('keeps only the USDCx loops', () => {
    expect(usdcxLoopsOrFail(bridgeLoops(CHAINS)).map(loop => loop.kind)).toEqual(
      expect.arrayContaining(['usdcx'])
    );
    expect(usdcxLoopsOrFail(bridgeLoops(CHAINS)).every(loop => loop.kind === 'usdcx')).toBe(true);
  });

  it('fails a night that would test no USDCx route', () => {
    expect(() => usdcxLoopsOrFail(bridgeLoops([]))).toThrow(
      'the mainnet config names no USDCx route with deposits enabled, so the bridge loop would test nothing'
    );
  });
});
