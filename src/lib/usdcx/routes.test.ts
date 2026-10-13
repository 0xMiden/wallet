import { arbitrumSepolia, baseSepolia, sepolia } from 'viem/chains';

import type { UsdcxConfig } from 'lib/remote-config/schema';

import { buildUsdcxRoutes, defaultUsdcxDestination, defaultUsdcxSource, minimumPayout } from './routes';
import { parseUsdcxSection, TEST_USDCX_CONFIG, TEST_USDCX_SECTION } from './testing/config';

const ARC_TESTNET_ID = 5042002;
const ARC = TEST_USDCX_SECTION.chains['arc-testnet'];
const routes = buildUsdcxRoutes(TEST_USDCX_CONFIG);

const without = (config: UsdcxConfig, drop: (name: string) => boolean): UsdcxConfig => ({
  ...config,
  chains: config.chains.filter(chain => !drop(chain.name))
});

describe('USDCx routes of a document', () => {
  it('lists every chain as a source and a destination, in the order of the document', () => {
    const order = [ARC_TESTNET_ID, sepolia.id, baseSepolia.id, arbitrumSepolia.id];
    expect([...routes.sources.keys()]).toEqual(order);
    expect([...routes.destinations.keys()]).toEqual(order);
    expect(routes.midenDomain).toBe(10007);
    expect(routes.attestationApi).toBe('https://xreserve-api-testnet.circle.com');
    for (const [chainId, source] of routes.sources) expect(source.chain.id).toBe(chainId);
    for (const [chainId, entry] of routes.destinations) expect(entry.chain.id).toBe(chainId);
  });

  it('gives the xReserve chain its own contract, the attestation service and the Miden domain', () => {
    expect(routes.sources.get(ARC_TESTNET_ID)).toMatchObject({
      route: 'xreserve',
      domain: 26,
      usdc: ARC.usdc,
      xReserve: ARC.deposit.xReserve,
      attestationApi: TEST_USDCX_SECTION.attestationUrl,
      midenDomain: 10007
    });
  });

  it('routes Sepolia, Base and Arbitrum through the executor on the chain that carries it', () => {
    const executorSources = [...routes.sources.values()].filter(source => source.route === 'cctp-executor');
    expect(executorSources.map(source => source.chain.id)).toEqual([sepolia.id, baseSepolia.id, arbitrumSepolia.id]);
    expect(routes.sources.get(sepolia.id)).toMatchObject({
      route: 'cctp-executor',
      domain: 0,
      usdc: TEST_USDCX_SECTION.chains.sepolia.usdc,
      tokenMessenger: TEST_USDCX_SECTION.chains.sepolia.deposit.tokenMessenger,
      tokenMessengerWithFees: TEST_USDCX_SECTION.chains.sepolia.deposit.tokenMessengerWithFees,
      irisApi: TEST_USDCX_SECTION.irisUrl,
      target: {
        domain: 26,
        executor: ARC.executor.address,
        handler: ARC.executor.handler,
        xReserve: ARC.deposit.xReserve,
        usdc: ARC.usdc,
        attestationApi: TEST_USDCX_SECTION.attestationUrl,
        irisApi: TEST_USDCX_SECTION.irisUrl,
        midenDomain: 10007
      }
    });
    for (const source of executorSources) {
      expect(source.route === 'cctp-executor' && source.target.chain.id).toBe(ARC_TESTNET_ID);
    }
  });

  it('returns checksummed addresses from the lowercase ones the parser keeps', () => {
    expect(TEST_USDCX_CONFIG.chains[0]?.usdc).toBe(ARC.usdc.toLowerCase());
    expect(routes.destinations.get(sepolia.id)?.usdc).toBe('0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238');
  });

  it('pre-selects the first source and the first destination of the document', () => {
    expect(defaultUsdcxSource(routes)?.chain.id).toBe(ARC_TESTNET_ID);
    expect(defaultUsdcxDestination(routes)?.chain.id).toBe(ARC_TESTNET_ID);
    const reordered = buildUsdcxRoutes({ ...TEST_USDCX_CONFIG, chains: [...TEST_USDCX_CONFIG.chains].reverse() });
    expect(defaultUsdcxSource(reordered)?.chain.id).toBe(arbitrumSepolia.id);
    expect(defaultUsdcxDestination(reordered)?.chain.id).toBe(arbitrumSepolia.id);
    expect(defaultUsdcxSource(null)).toBeUndefined();
    expect(defaultUsdcxDestination(null)).toBeUndefined();
  });
});

describe('USDCx executor chains without a usable executor', () => {
  it('keeps them as destinations only while no chain carries the executor', () => {
    const noExecutor = buildUsdcxRoutes(without(TEST_USDCX_CONFIG, name => name === 'arc-testnet'));
    expect([...noExecutor.sources.keys()]).toEqual([]);
    expect([...noExecutor.destinations.keys()]).toEqual([sepolia.id, baseSepolia.id, arbitrumSepolia.id]);
  });

  it('keeps them as destinations only while the document names no Iris API', () => {
    const noIris = buildUsdcxRoutes(parseUsdcxSection({ ...TEST_USDCX_SECTION, irisUrl: undefined }));
    expect([...noIris.sources.keys()]).toEqual([ARC_TESTNET_ID]);
    expect([...noIris.destinations.keys()]).toHaveLength(4);
  });

  it('keeps a chain with no deposit route as a destination only', () => {
    const { deposit: _deposit, ...baseOnly } = TEST_USDCX_SECTION.chains['base-sepolia'];
    const config = parseUsdcxSection({
      ...TEST_USDCX_SECTION,
      chains: { ...TEST_USDCX_SECTION.chains, 'base-sepolia': baseOnly }
    });
    const built = buildUsdcxRoutes(config);
    expect(built.sources.has(baseSepolia.id)).toBe(false);
    expect(built.destinations.has(baseSepolia.id)).toBe(true);
  });
});

describe('USDCx payout fee allowance', () => {
  // Circle charges a flat ~1,003,500 (about 1.0035 USDC) to pay a burn out on Ethereum, more than half of a 2 USDCx
  // burn, so the floor is the amount minus the allowance and nothing else.
  it('expects a payout of the amount minus the fee allowance, not positive once the allowance takes it whole', () => {
    const { destinations } = routes;
    expect(destinations.get(sepolia.id)?.payoutFeeAllowance).toBe(1_500_000n);
    expect(destinations.get(ARC_TESTNET_ID)?.payoutFeeAllowance).toBe(100_000n);
    expect(minimumPayout(destinations, baseSepolia.id, 3_000_000n)).toBe(2_900_000n);
    expect(minimumPayout(destinations, sepolia.id, 5_000_000n)).toBe(3_500_000n);
    expect(minimumPayout(destinations, sepolia.id, 2_000_000n)).toBe(500_000n);
    expect(minimumPayout(destinations, baseSepolia.id, 150_001n)).toBe(50_001n);
    expect(minimumPayout(destinations, sepolia.id, 1_500_001n)).toBe(1n);
    expect(minimumPayout(destinations, sepolia.id, 1_500_000n)).toBe(0n);
    expect(minimumPayout(destinations, sepolia.id, 1_000_000n)).toBe(-500_000n);
    expect(minimumPayout(destinations, 999, 1_000_000n)).toBe(1_000_000n);
  });
});
