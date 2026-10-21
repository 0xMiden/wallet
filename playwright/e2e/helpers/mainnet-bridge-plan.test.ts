import {
  agglayerGasReserve,
  agglayerShortfall,
  bridgeLoops,
  depositGasReserve,
  LOOP_USDC,
  usdcReserve,
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

  it('reserves two nights of AggLayer gas before it bridges', () => {
    expect(agglayerGasReserve(10n)).toBe(2n * 2n * 600_000n * 10n);
    expect(agglayerShortfall({ address: '0xabc', wei: 1n, maxFeePerGas: 10n })).toContain('short of');
    expect(agglayerShortfall({ address: '0xabc', wei: agglayerGasReserve(10n), maxFeePerGas: 10n })).toBeUndefined();
  });
});
