import { arbitrum, arbitrumSepolia, arc, base, baseSepolia, mainnet, sepolia } from 'viem/chains';

import {
  CCTP_EXECUTOR_ADDRESS,
  CIRCLE_DOMAIN,
  CIRCLE_USDC_ADDRESS,
  DEFAULT_USDCX_DESTINATION_CHAIN_ID,
  DEFAULT_USDCX_SOURCE_CHAIN_ID,
  getUsdcxContracts,
  getUsdcxDestination,
  getUsdcxExecutorSource,
  getUsdcxSourceChain,
  getUsdcxXReserveSource,
  IRIS_API_MAINNET,
  IRIS_API_TESTNET,
  isUsdcxExecutorSource,
  listUsdcxDestinations,
  TOKEN_MESSENGER_V2_ADDRESS,
  TOKEN_MESSENGER_WITH_FEES_ADDRESS,
  USDCX_DESTINATIONS,
  USDCX_SOURCE_CHAINS,
  XRESERVE_ADDRESS,
  XRESERVE_ATTESTATION_API_MAINNET,
  XRESERVE_ATTESTATION_API_TESTNET
} from './constant';

const ARC_TESTNET_ID = 5042002;

describe('USDCx source chains', () => {
  it('lists the xReserve chains and the executor chains, each with its contracts and domain', () => {
    expect([...USDCX_SOURCE_CHAINS.keys()]).toEqual([
      ARC_TESTNET_ID,
      sepolia.id,
      baseSepolia.id,
      arbitrumSepolia.id,
      arc.id,
      mainnet.id,
      base.id,
      arbitrum.id
    ]);
    for (const [chainId, source] of USDCX_SOURCE_CHAINS) {
      expect(source.chain.id).toBe(chainId);
      expect(source.usdc).toBe(CIRCLE_USDC_ADDRESS.get(chainId));
      expect(source.domain).toBe(CIRCLE_DOMAIN.get(chainId));
    }
  });

  it('gives each xReserve source its own contract and the attestation API of its network family', () => {
    const sources = [...USDCX_SOURCE_CHAINS.values()].filter(source => source.route === 'xreserve');
    expect(sources.map(source => source.chain.id)).toEqual([ARC_TESTNET_ID, sepolia.id, arc.id, mainnet.id]);
    expect(sources.map(source => source.xReserve)).toEqual(
      sources.map(source => XRESERVE_ADDRESS.get(source.chain.id))
    );
    expect(sources.map(source => source.attestationApi)).toEqual(
      sources.map(source =>
        source.chain.testnet ? XRESERVE_ATTESTATION_API_TESTNET : XRESERVE_ATTESTATION_API_MAINNET
      )
    );
  });

  it('gives each executor source the token messenger, Iris and an Arc target of its network family', () => {
    const sources = [...USDCX_SOURCE_CHAINS.values()].filter(source => source.route === 'cctp-executor');
    expect(sources.map(source => source.chain.id)).toEqual([baseSepolia.id, arbitrumSepolia.id, base.id, arbitrum.id]);
    expect(sources.map(source => source.tokenMessenger)).toEqual(sources.map(() => TOKEN_MESSENGER_V2_ADDRESS));
    expect(sources.map(source => source.irisApi)).toEqual(
      sources.map(source => (source.chain.testnet ? IRIS_API_TESTNET : IRIS_API_MAINNET))
    );
    expect(sources.map(source => source.target.chain.testnet ?? false)).toEqual(
      sources.map(source => source.chain.testnet ?? false)
    );
    expect(sources.map(source => source.target.domain)).toEqual(sources.map(() => 26));
    expect(sources.map(source => source.target.xReserve)).toEqual(
      sources.map(source => XRESERVE_ADDRESS.get(source.target.chain.id))
    );
    expect(sources.map(source => source.target.usdc)).toEqual(
      sources.map(source => CIRCLE_USDC_ADDRESS.get(source.target.chain.id))
    );
    expect(sources.map(source => ({ executor: source.target.executor, handler: source.target.handler }))).toEqual(
      sources.map(source => CCTP_EXECUTOR_ADDRESS.get(source.target.chain.id))
    );
  });

  it('routes Base and Arbitrum through the executor on Arc of the same network family', () => {
    expect(getUsdcxExecutorSource(baseSepolia.id).target.chain.id).toBe(ARC_TESTNET_ID);
    expect(getUsdcxExecutorSource(arbitrumSepolia.id).target.chain.id).toBe(ARC_TESTNET_ID);
    expect(getUsdcxExecutorSource(base.id).target.chain.id).toBe(arc.id);
    expect(getUsdcxExecutorSource(arbitrum.id).target.chain.id).toBe(arc.id);
    expect(isUsdcxExecutorSource(baseSepolia.id)).toBe(true);
    expect(isUsdcxExecutorSource(sepolia.id)).toBe(false);
    expect(isUsdcxExecutorSource(undefined)).toBe(false);
  });

  it('starts from Arc Testnet outside the e2e build and narrows each route', () => {
    expect(DEFAULT_USDCX_SOURCE_CHAIN_ID).toBe(ARC_TESTNET_ID);
    expect(getUsdcxXReserveSource(sepolia.id).chain.name).toBe('Sepolia');
    expect(() => getUsdcxXReserveSource(baseSepolia.id)).toThrow('no local xReserve');
    expect(() => getUsdcxExecutorSource(sepolia.id)).toThrow('not an executor source');
    expect(() => getUsdcxSourceChain(999)).toThrow('not configured');
  });
});

describe('USDCx destinations', () => {
  it('pays out on the direct-payout domains of every supported chain', () => {
    expect([...USDCX_DESTINATIONS.keys()]).toEqual([
      ARC_TESTNET_ID,
      sepolia.id,
      arbitrumSepolia.id,
      baseSepolia.id,
      arc.id,
      mainnet.id,
      arbitrum.id,
      base.id
    ]);
    expect(getUsdcxDestination(ARC_TESTNET_ID).domain).toBe(26);
    expect(getUsdcxDestination(sepolia.id).domain).toBe(0);
    expect(getUsdcxDestination(arbitrumSepolia.id).domain).toBe(3);
    expect(getUsdcxDestination(baseSepolia.id).domain).toBe(6);
    for (const [chainId, entry] of USDCX_DESTINATIONS) {
      expect(entry.chain.id).toBe(chainId);
      expect(entry.usdc).toBe(CIRCLE_USDC_ADDRESS.get(chainId));
    }
    expect(() => getUsdcxDestination(999)).toThrow('not configured');
  });

  it('splits the table by network family and pre-selects Arc Testnet', () => {
    expect(listUsdcxDestinations(true).map(entry => entry.chain.id)).toEqual([
      ARC_TESTNET_ID,
      sepolia.id,
      arbitrumSepolia.id,
      baseSepolia.id
    ]);
    expect(listUsdcxDestinations(false).map(entry => entry.chain.id)).toEqual([
      arc.id,
      mainnet.id,
      arbitrum.id,
      base.id
    ]);
    expect(DEFAULT_USDCX_DESTINATION_CHAIN_ID).toBe(ARC_TESTNET_ID);
  });
});

describe('USDCx per-chain contracts', () => {
  it('resolves Arc and Sepolia independently without silently falling back', () => {
    expect(getUsdcxContracts(5042002).usdc).toBe('0x3600000000000000000000000000000000000000');
    expect(getUsdcxContracts(sepolia.id).usdc).toBe('0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238');
    expect(() => getUsdcxContracts(999)).toThrow('not configured');
  });

  it.each([arbitrum, arbitrumSepolia, base, baseSepolia])('configures CCTP, not local xReserve, for $name', chain => {
    expect(CIRCLE_USDC_ADDRESS.has(chain.id)).toBe(true);
    expect(TOKEN_MESSENGER_WITH_FEES_ADDRESS.has(chain.id)).toBe(true);
    expect(CIRCLE_DOMAIN.get(chain.id)).toBe(chain.id === base.id || chain.id === baseSepolia.id ? 6 : 3);
    expect(() => getUsdcxContracts(chain.id)).toThrow('not configured');
  });

  it('keeps Arc mainnet direct deposits separate from its unconfirmed fee entry point', () => {
    expect(getUsdcxContracts(arc.id).xReserve).toBe('0x8888888199b2Df864bf678259607d6D5EBb4e3Ce');
    expect(CIRCLE_DOMAIN.get(arc.id)).toBe(26);
    expect(TOKEN_MESSENGER_WITH_FEES_ADDRESS.has(arc.id)).toBe(false);
  });
});
