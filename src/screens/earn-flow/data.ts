import type { EarnVaultInfo } from 'lib/epoch';
import type { EarnVaultConfig } from 'lib/remote-config/schema';

import { EarnPosition, EarnSummary, EarnVault } from './types';

/**
 * Test fixtures for the earn screens. `EARN_VAULT_INFOS` has the shape the lib reads from the pools service: USDC
 * markets of Aave V3, Compound V3 and two of Morpho Blue on Base, and the testnet dummy lender of the fallback, each
 * with the document's entry for it (`listing`). They are in the order the document lists them, which the lib keeps.
 * `EARN_DATA.vaults` is each one as `mapEarnVault` shows it, written out so that a test can mock `lib/epoch` and
 * still import this module.
 */

const listing = (
  id: string,
  marketUid: string,
  name: string,
  extra: Partial<EarnVaultConfig> = {}
): EarnVaultConfig => ({ id, marketUid, name, protocol: '1delta', depositsEnabled: true, ...extra });

const BASE_USDC: EarnVaultInfo['underlying'] = {
  address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  symbol: 'USDC',
  decimals: 6
};

const MORPHO_UNIBTC_USDC: EarnVaultInfo = {
  marketUid:
    'morpho_blue_0x3b3769cfca57be2eaed03fcc5299c25691b77781a1e124e7a8d520eb9a7eabb5:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  lenderKey: 'MORPHO_BLUE_0X3B3769CFCA57BE2EAED03FCC5299C25691B77781A1E124E7A8D520EB9A7EABB5',
  lenderFamily: 'MORPHO_BLUE',
  lenderName: 'Morpho uniBTC-USDC 77',
  marketName: 'Loan USDC',
  logoUri: 'https://raw.githubusercontent.com/1delta-DAO/protocol-icons/main/lender/morpho_blue.webp',
  chainId: '8453',
  underlying: BASE_USDC,
  depositApr: 6.1,
  aprTotal: 6.48,
  totalDepositsUsd: 5_432_100,
  totalLiquidityUsd: 1_210_000,
  utilization: 0.78,
  risk: { score: 3, label: 'high' },
  canOpen: true,
  about:
    'You earn 6.48% (6.10% base + 0.38% rewards), floating with utilization. Withdrawals are instant, up to the liquidity available in the market.',
  listing: listing(
    'morpho-unibtc-base-usdc',
    'morpho_blue_0x3b3769cfca57be2eaed03fcc5299c25691b77781a1e124e7a8d520eb9a7eabb5:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    'Morpho uniBTC-USDC 77'
  )
};

const MORPHO_CBBTC_USDC: EarnVaultInfo = {
  marketUid:
    'morpho_blue_0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  lenderKey: 'MORPHO_BLUE_0X9103C3B4E834476C9A62EA009BA2C884EE42E94E6E314A26F04D312434191836',
  lenderFamily: 'MORPHO_BLUE',
  lenderName: 'Morpho cbBTC-USDC 86',
  marketName: 'Loan USDC',
  logoUri: 'https://raw.githubusercontent.com/1delta-DAO/protocol-icons/main/lender/morpho_blue.webp',
  chainId: '8453',
  underlying: BASE_USDC,
  depositApr: 5.4,
  aprTotal: 5.9,
  totalDepositsUsd: 812_345_678,
  totalLiquidityUsd: 96_000_000,
  utilization: 0.88,
  risk: { score: 2, label: 'medium' },
  // A market that accepts no deposits now, so the screens can show that state.
  canOpen: false,
  listing: listing(
    'morpho-cbbtc-base-usdc',
    'morpho_blue_0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    'Morpho cbBTC-USDC 86'
  )
};

const AAVE_V3_USDC: EarnVaultInfo = {
  marketUid: 'aave_v3:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  lenderKey: 'AAVE_V3',
  lenderFamily: 'AAVE_V3',
  lenderName: 'Aave V3',
  marketName: 'Aave V3 USDC',
  logoUri: 'https://raw.githubusercontent.com/1delta-DAO/protocol-icons/main/lender/aave_v3.webp',
  chainId: '8453',
  underlying: BASE_USDC,
  depositApr: 3.75,
  aprTotal: 5.12,
  totalDepositsUsd: 412_345_678.9,
  totalLiquidityUsd: 98_765_432.1,
  utilization: 0.76,
  risk: { score: 1, label: 'low' },
  canOpen: true,
  about:
    'You earn 5.12% (3.75% base + 1.37% rewards), floating with utilization. Withdrawals are instant, up to the liquidity available in the market.',
  listing: listing('aave-v3-base-usdc', 'aave_v3:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 'Aave V3 USDC')
};

const COMPOUND_V3_USDC: EarnVaultInfo = {
  marketUid: 'compound_v3_usdc:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  lenderKey: 'COMPOUND_V3_USDC',
  lenderFamily: 'COMPOUND_V3',
  lenderName: 'Compound V3',
  marketName: 'Compound V3 USDC',
  logoUri: 'https://raw.githubusercontent.com/1delta-DAO/protocol-icons/main/lender/compound_v3.webp',
  chainId: '8453',
  underlying: BASE_USDC,
  depositApr: 4.2,
  aprTotal: 4.86,
  totalDepositsUsd: 23_456_789,
  utilization: 0.81,
  risk: { score: 2, label: 'medium' },
  canOpen: true,
  // The document's own words and risk, which take the place of the catalogue's.
  listing: listing(
    'compound-v3-base-usdc',
    'compound_v3_usdc:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    'Compound III USDC',
    { about: 'Lends USDC to Compound III borrowers on Base.', risk: 'low' }
  )
};

// The fallback market: the service gives no totals, risk or description for it.
const DUMMY_LENDING_USDC: EarnVaultInfo = {
  marketUid: 'dummy_lending:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
  lenderKey: 'DUMMY_LENDING',
  lenderFamily: 'DUMMY_LENDING',
  lenderName: 'Dummy Lending',
  marketName: 'Dummy Lending',
  logoUri: '',
  chainId: '11155111',
  underlying: { address: '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69', symbol: 'USDC', decimals: 6 },
  depositApr: 2,
  aprTotal: 2,
  canOpen: true,
  listing: listing(
    'dummy-lending-sepolia-usdc',
    'dummy_lending:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
    'Dummy Lending USDC',
    { protocol: 'dummy-lending' }
  )
};

export const EARN_VAULT_INFOS: EarnVaultInfo[] = [
  MORPHO_UNIBTC_USDC,
  MORPHO_CBBTC_USDC,
  AAVE_V3_USDC,
  COMPOUND_V3_USDC,
  DUMMY_LENDING_USDC
];

const flatSeries = (apr: number) => [
  { label: '—', value: apr },
  { label: '—', value: apr }
];

const AAVE_V3_VAULT_ID = 'aave-v3-base-usdc';

export const EARN_DATA: {
  summary: EarnSummary;
  positions: EarnPosition[];
  vaults: EarnVault[];
} = {
  summary: {
    totalRewardsUsd: 218.32,
    blendedApyPercent: 5.2,
    totalDepositedUsd: 4218.32,
    estimatedRewardsUsd: 24.5
  },
  // Two owners with a position in the same Aave V3 market, so both link to the same vault.
  positions: [
    {
      id: 'aave-usdc-1',
      vaultId: AAVE_V3_VAULT_ID,
      owner: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
      marketUid: 'AAVE_V3:8453:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      chainId: '8453',
      underlyingAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      withdrawable: '1024.5',
      decimals: 6,
      protocol: 'Aave V3',
      asset: 'USDC',
      network: 'Base',
      amount: '$1,024.50',
      depositedAmount: '$1,000.00',
      rewards: '+$24.50',
      age: '42d',
      activeDuration: '42 days active',
      apy: '5.24%',
      dailyAverage: '+$0.58',
      started: 'Mar 18',
      yearlyEstimate: '+$53.68 / yr',
      withdrawTime: '~30 sec · no lockup',
      route: 'Miden -> Aave V3 (Base)',
      stale: false,
      chartData: [
        { label: 'Mar 18', value: 1000 },
        { label: 'Mar 24', value: 1003 },
        { label: 'Mar 30', value: 1008 },
        { label: 'Apr 05', value: 1010 },
        { label: 'Apr 11', value: 1009 },
        { label: 'Apr 17', value: 1012 },
        { label: 'Apr 23', value: 1017 },
        { label: 'Apr 29', value: 1019 },
        { label: 'May 05', value: 1018 },
        { label: 'May 11', value: 1020 },
        { label: 'May 17', value: 1026 },
        { label: 'May 23', value: 1029 },
        { label: 'May 29', value: 1028 },
        { label: 'Jun 04', value: 1029 },
        { label: 'Jun 10', value: 1034 },
        { label: 'Jun 16', value: 1039 },
        { label: 'Jun 22', value: 1041 },
        { label: 'Jun 28', value: 1040 }
      ]
    },
    {
      id: 'aave-usdc-2',
      vaultId: AAVE_V3_VAULT_ID,
      owner: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
      marketUid: 'AAVE_V3:8453:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      chainId: '8453',
      underlyingAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      withdrawable: '1024.5',
      decimals: 6,
      protocol: 'Aave V3',
      asset: 'USDC',
      network: 'Base',
      amount: '$1,024.50',
      depositedAmount: '$1,000.00',
      rewards: '+$24.50',
      age: '42d',
      activeDuration: '42 days active',
      apy: '5.24%',
      dailyAverage: '+$0.58',
      started: 'Mar 18',
      yearlyEstimate: '+$53.68 / yr',
      withdrawTime: '~30 sec · no lockup',
      route: 'Miden -> Aave V3 (Base)',
      stale: false,
      chartData: [
        { label: 'Mar 18', value: 1000 },
        { label: 'Mar 24', value: 1004 },
        { label: 'Mar 30', value: 1007 },
        { label: 'Apr 05', value: 1011 },
        { label: 'Apr 11', value: 1010 },
        { label: 'Apr 17', value: 1013 },
        { label: 'Apr 23', value: 1016 },
        { label: 'Apr 29', value: 1018 },
        { label: 'May 05', value: 1019 },
        { label: 'May 11', value: 1021 },
        { label: 'May 17', value: 1025 },
        { label: 'May 23', value: 1028 },
        { label: 'May 29', value: 1029 },
        { label: 'Jun 04', value: 1030 },
        { label: 'Jun 10', value: 1033 },
        { label: 'Jun 16', value: 1037 },
        { label: 'Jun 22', value: 1040 },
        { label: 'Jun 28', value: 1041 }
      ]
    }
  ],
  vaults: [
    {
      id: 'morpho-unibtc-base-usdc',
      name: 'Morpho uniBTC-USDC 77',
      protocol: 'Morpho',
      asset: 'USDC',
      network: 'Base',
      apy: '6.48%',
      aprPercent: 6.48,
      apyChange24h: '—',
      tvl: '$5.4M',
      risk: 'High',
      riskLevel: 'high',
      audited: false,
      about: MORPHO_UNIBTC_USDC.about ?? '—',
      canOpen: true,
      depositsEnabled: true,
      info: MORPHO_UNIBTC_USDC,
      chartData: flatSeries(6.48)
    },
    {
      id: 'morpho-cbbtc-base-usdc',
      name: 'Morpho cbBTC-USDC 86',
      protocol: 'Morpho',
      asset: 'USDC',
      network: 'Base',
      apy: '5.90%',
      aprPercent: 5.9,
      apyChange24h: '—',
      tvl: '$812.3M',
      risk: 'Medium',
      riskLevel: 'medium',
      audited: false,
      about: '—',
      canOpen: false,
      depositsEnabled: true,
      info: MORPHO_CBBTC_USDC,
      chartData: flatSeries(5.9)
    },
    {
      id: AAVE_V3_VAULT_ID,
      name: 'Aave V3 USDC',
      protocol: 'Aave V3',
      asset: 'USDC',
      network: 'Base',
      apy: '5.12%',
      aprPercent: 5.12,
      apyChange24h: '—',
      tvl: '$412.3M',
      risk: 'Low',
      riskLevel: 'low',
      audited: false,
      about: AAVE_V3_USDC.about ?? '—',
      canOpen: true,
      depositsEnabled: true,
      info: AAVE_V3_USDC,
      chartData: flatSeries(5.12)
    },
    {
      id: 'compound-v3-base-usdc',
      name: 'Compound III USDC',
      protocol: 'Compound V3',
      listedAbout: 'Lends USDC to Compound III borrowers on Base.',
      asset: 'USDC',
      network: 'Base',
      apy: '4.86%',
      aprPercent: 4.86,
      apyChange24h: '—',
      tvl: '$23.5M',
      // The document's risk and words, in place of the catalogue's.
      risk: 'Low',
      riskLevel: 'low',
      audited: false,
      about: 'Lends USDC to Compound III borrowers on Base.',
      canOpen: true,
      depositsEnabled: true,
      info: COMPOUND_V3_USDC,
      chartData: flatSeries(4.86)
    },
    {
      id: 'dummy-lending-sepolia-usdc',
      name: 'Dummy Lending USDC',
      protocol: 'Dummy Lending',
      asset: 'USDC',
      network: 'Sepolia',
      apy: '2.00%',
      aprPercent: 2,
      apyChange24h: '—',
      tvl: '—',
      risk: '—',
      audited: false,
      about: '—',
      canOpen: true,
      depositsEnabled: true,
      info: DUMMY_LENDING_USDC,
      chartData: flatSeries(2)
    }
  ]
};
