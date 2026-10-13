import { parseBridgeConfig, type UsdcxConfig } from 'lib/remote-config/schema';

import { buildUsdcxRoutes, type UsdcxExecutorSource, type UsdcxRoutes, type UsdcxXReserveSource } from '../routes';

/**
 * The `usdcx` section of the testnet document (0xMiden/wallet-config `testnet.json`), as published: the fixture the
 * unit suites and the E2E harness read, since the product no longer compiles these values. The harness checks them
 * against Circle's live contracts; a change to the published section is copied here.
 */
export const TEST_USDCX_SECTION = {
  midenDomain: 10007,
  attestationUrl: 'https://xreserve-api-testnet.circle.com',
  irisUrl: 'https://iris-api-sandbox.circle.com',
  chains: {
    'arc-testnet': {
      chainId: 5042002,
      domain: 26,
      usdc: '0x3600000000000000000000000000000000000000',
      deposit: { route: 'xreserve', xReserve: '0x008888878f94C0d87defdf0B07f46B93C1934442' },
      executor: {
        address: '0xEdC81040756AcCfF070c21D37b265b9D0b5Ba45e',
        handler: '0xD05E7D2E7d30b92c5F17d7d0fC575fce231F1A48'
      }
    },
    sepolia: {
      chainId: 11155111,
      domain: 0,
      usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      deposit: {
        route: 'executor',
        tokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
        tokenMessengerWithFees: '0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A'
      }
    },
    'base-sepolia': {
      chainId: 84532,
      domain: 6,
      usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      deposit: {
        route: 'executor',
        tokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
        tokenMessengerWithFees: '0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A'
      }
    },
    'arbitrum-sepolia': {
      chainId: 421614,
      domain: 3,
      usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
      deposit: {
        route: 'executor',
        tokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
        tokenMessengerWithFees: '0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A'
      }
    }
  }
};

/** The section as the wallet's parser accepts it; throws when it does not, so a bad fixture fails at load. */
export function parseUsdcxSection(section: unknown): UsdcxConfig {
  const usdcx = parseBridgeConfig({ network: 'testnet', version: 1, usdcx: section }, 'testnet')?.usdcx;
  if (!usdcx) throw new Error('The USDCx fixture section does not parse.');
  return usdcx;
}

/** The testnet section, parsed. */
export const TEST_USDCX_CONFIG: UsdcxConfig = parseUsdcxSection(TEST_USDCX_SECTION);

/** The routes the wallet builds from the testnet section. */
export const TEST_USDCX_ROUTES: UsdcxRoutes = buildUsdcxRoutes(TEST_USDCX_CONFIG);

/** Circle's remote-domain id for Miden in the testnet section. */
export const TEST_USDCX_MIDEN_DOMAIN: number = TEST_USDCX_ROUTES.midenDomain;

/** The testnet source `chainId` with a local xReserve; throws for any other chain. */
export function testUsdcxXReserveSource(chainId: number): UsdcxXReserveSource {
  const source = TEST_USDCX_ROUTES.sources.get(chainId);
  if (source?.route !== 'xreserve') throw new Error(`The USDCx fixture has no xReserve source ${chainId}.`);
  return source;
}

/** The testnet source `chainId` that deposits through the executor; throws for any other chain. */
export function testUsdcxExecutorSource(chainId: number): UsdcxExecutorSource {
  const source = TEST_USDCX_ROUTES.sources.get(chainId);
  if (source?.route !== 'cctp-executor') throw new Error(`The USDCx fixture has no executor source ${chainId}.`);
  return source;
}
