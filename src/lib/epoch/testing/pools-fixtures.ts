/**
 * Base USDC markets as Epoch's mainnet `/pools` route served them on 2026-10-22, trimmed: the risk breakdown, the
 * oracle feeds, the asset props and most null per-protocol slots are left out. The types are as served: `chainId` is
 * a string, `borrowLiquidityUsd` and `closeFactor` are decimal strings. `BASE_EARN_VAULTS` is a document's vault
 * list over them.
 */
import type { EarnVaultConfig } from 'lib/remote-config/schema';

export const BASE_CHAIN_ID = 8453;
export const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC = BASE_USDC.toLowerCase();

interface PoolFixtureArgs {
  lenderKey: string;
  lenderName: string;
  name: string;
  depositRate: number;
  aprTotal: number;
  totalDepositsUsd: number;
  totalLiquidityUsd: number;
  utilization: number;
  risk: { score: number; label: string };
  description: string;
  /** The uid's token: another token than USDC for a market whose uid names its vault. */
  uidToken?: string;
  borrowingEnabled?: boolean;
}

function poolFixture(args: PoolFixtureArgs) {
  const slug = args.lenderKey.toLowerCase();
  return {
    marketUid: `${args.lenderKey}:${BASE_CHAIN_ID}:${args.uidToken ?? USDC}`,
    chainId: String(BASE_CHAIN_ID),
    lenderKey: args.lenderKey,
    borrowLiquidityUsd: args.totalLiquidityUsd.toFixed(10),
    closeFactor: '1.000000000000000000',
    name: args.name,
    rewards: [],
    depositRate: args.depositRate,
    utilization: args.utilization,
    totalDepositsUsd: args.totalDepositsUsd,
    totalLiquidityUsd: args.totalLiquidityUsd,
    withdrawLiquidity: args.totalLiquidityUsd,
    depositable: null,
    caps: { borrowCap: null, supplyCap: null, debtCeiling: null },
    flags: {
      isActive: true,
      isFrozen: false,
      hasStable: false,
      borrowingEnabled: args.borrowingEnabled ?? true,
      collateralActive: args.borrowingEnabled === false,
      depositsEnabled: true
    },
    underlyingInfo: {
      asset: {
        chainId: String(BASE_CHAIN_ID),
        address: USDC,
        symbol: 'USDC',
        name: 'USD Coin',
        decimals: 6,
        logoURI: 'https://ethereum-optimism.github.io/data/USDC/logo.png'
      },
      prices: { priceUsd: 0.99982117 }
    },
    risk: { ...args.risk, breakdown: [] },
    lenderInfo: {
      key: args.lenderKey,
      name: args.lenderName,
      logoURI: `https://raw.githubusercontent.com/1delta-DAO/protocol-icons/main/lender/${slug}.webp`
    },
    alchemix: null,
    fluid: null,
    rateModel: null,
    terms: null,
    termSheet: {
      supply: {
        aprTotal: args.aprTotal,
        canOpen: true,
        exitMode: 'instant',
        headline: `Variable ${args.aprTotal}% · withdraw any time`,
        description: args.description,
        tags: []
      }
    }
  };
}

export type PoolFixture = ReturnType<typeof poolFixture>;

export const AAVE_V3_USDC: PoolFixture = {
  ...poolFixture({
    lenderKey: 'AAVE_V3',
    lenderName: 'Aave V3',
    name: 'Aave V3 USDC',
    depositRate: 3.75454844,
    aprTotal: 5.201192000000001,
    totalDepositsUsd: 195048766.62868062,
    totalLiquidityUsd: 21638659.032707438,
    utilization: 0.8890630186278784,
    risk: { score: 2, label: 'low' },
    description:
      'You earn 5.2% (3.75% base + 1.45% rewards), floating with utilization. Withdrawals are instant, up to the ' +
      'liquidity available in the market.'
  }),
  closeFactor: '0.500000000000000000'
};

export const COMPOUND_V3_USDC: PoolFixture = poolFixture({
  lenderKey: 'COMPOUND_V3_USDC',
  lenderName: 'Compound USDC',
  name: 'Loan USDC',
  depositRate: 5.38416446,
  aprTotal: 5.38416446,
  totalDepositsUsd: 9605068.9651103,
  totalLiquidityUsd: 896953.931779512,
  utilization: 0.906616569006798,
  risk: { score: 2, label: 'low' },
  description:
    'You earn 5.38% (5.38% base), floating with utilization. Withdrawals are instant, up to the liquidity available ' +
    'in the market.'
});

export const MORPHO_UNIBTC_USDC: PoolFixture = poolFixture({
  lenderKey: 'MORPHO_BLUE_2E2548390B8894D2FFAAABABEBC2B5F2501920E03A4C611B63B46E19BFC6B75D',
  lenderName: 'Morpho uniBTC-USDC 77',
  name: 'Loan USDC',
  depositRate: 38.08331468,
  aprTotal: 38.08331468,
  totalDepositsUsd: 333745.6618557802,
  totalLiquidityUsd: 0.0028871616,
  utilization: 0.9999999913492164,
  risk: { score: 4, label: 'medium' },
  description:
    'You earn 38.08% (38.08% base), floating with utilization. Withdrawals are instant in principle, but utilization ' +
    'is 100% — there may be little or no liquidity to withdraw right now.'
});

export const MORPHO_USDC_COLLATERAL: PoolFixture = poolFixture({
  lenderKey: 'MORPHO_BLUE_6B61D4738919B56FFF396C9BB29C61AF495AA24EFC1ACA80F2563C34A6556312',
  lenderName: 'Morpho USDC-MXNB 92',
  name: 'Collateral USDC',
  depositRate: 0,
  aprTotal: 0,
  totalDepositsUsd: 316014.2991324569,
  totalLiquidityUsd: 316014.2991324569,
  utilization: 0,
  risk: { score: 2, label: 'low' },
  borrowingEnabled: false,
  description:
    'Deposits here are collateral only — they secure borrowing and do not earn interest. Withdrawals are instant, up ' +
    'to the liquidity available in the market.'
});

/** A lender the wallet does not support. Its uid names its vault, not the token. */
export const EULER_V2_USDC: PoolFixture = poolFixture({
  lenderKey: 'EULER_V2',
  lenderName: 'Euler V2',
  name: 'EVK Vault eUSDC-49',
  depositRate: 6.34826539,
  aprTotal: 6.34826539,
  totalDepositsUsd: 604586.8095256061,
  totalLiquidityUsd: 138395.8522450287,
  utilization: 0.7710901890935693,
  risk: { score: 4, label: 'medium' },
  uidToken: '0x4c1aeda9b43efcf1da1d1755b18802aabe90f61e',
  description:
    'You earn 6.35% (6.35% base), floating with utilization. Withdrawals are instant, up to the liquidity available ' +
    'in the market.'
});

/** The document's entry for `pool`'s market: protocol `1delta`, deposits on, the uid lowercase as the parser keeps it. */
export const listingFor = (
  pool: { marketUid: string },
  id: string,
  name: string,
  overrides: Partial<EarnVaultConfig> = {}
): EarnVaultConfig => ({
  id,
  marketUid: pool.marketUid.toLowerCase(),
  name,
  protocol: '1delta',
  depositsEnabled: true,
  ...overrides
});

export const AAVE_V3_LISTING = listingFor(AAVE_V3_USDC, 'aave-v3-base-usdc', 'Aave V3 USDC');
export const COMPOUND_V3_LISTING = listingFor(COMPOUND_V3_USDC, 'compound-v3-base-usdc', 'Compound III USDC');
export const MORPHO_UNIBTC_LISTING = listingFor(MORPHO_UNIBTC_USDC, 'morpho-unibtc-base-usdc', 'Morpho uniBTC USDC');
export const MORPHO_COLLATERAL_LISTING = listingFor(
  MORPHO_USDC_COLLATERAL,
  'morpho-mxnb-base-usdc',
  'Morpho USDC-MXNB'
);

/**
 * A Base document's `earn.vaults`: Aave V3, Compound III and two Morpho markets, in that picker order. The Euler
 * market is not listed, so the wallet never offers it.
 */
export const BASE_EARN_VAULTS: readonly EarnVaultConfig[] = [
  AAVE_V3_LISTING,
  COMPOUND_V3_LISTING,
  MORPHO_UNIBTC_LISTING,
  MORPHO_COLLATERAL_LISTING
];

/** The `/pools` envelope around `items`. */
export const poolsPage = (items: unknown[], start = 0) => ({
  success: true,
  data: { start, count: items.length, items },
  actions: null
});
