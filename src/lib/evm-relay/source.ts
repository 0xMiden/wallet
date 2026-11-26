/**
 * The relay address of an account as the source wallet of a bridge flow. A bridge flow that finds its source address
 * here sends through the relay provider in the place of an external wallet. This module knows no bridge: it gives a
 * provider (or a viem `WalletClient`) for one relay address on one chain, and the flow does the rest.
 */
import type { Address, Chain, WalletClient } from 'viem';

import { evmRpcChain } from 'lib/evm/rpc-chain';
import type { RelayChainConfig } from 'lib/remote-config/schema';
import { getRelayChain, getRelayConfig } from 'lib/remote-config/values';
import type { RelaySignRequest, RelaySignResult, WalletAccount } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';

import { getRelayBaseUrl } from './base-url';
import { RelayUnavailableError } from './errors';
import { lowerAddress } from './parse';
import { createRelayProvider, createRelayWalletClient, type RelayProvider } from './provider';
import { createRelaySubmitter, type RelaySubmitOptions, type RelaySubmitter } from './submit';

/** The relay address of an account and the account that signs for it. The address is in lower case. */
export interface RelaySource {
  accountPublicKey: string;
  address: Address;
}

/** True when the remote config turns the relay on and a base URL is known. */
function relayIsOn(): boolean {
  return getRelayConfig() !== null && getRelayBaseUrl() !== null;
}

/**
 * The relay source of an account: null when it has no valid `relayEvmAddress` or the relay is off. This reads the
 * realm's config snapshot as it is: a path that runs with no user action awaits `initBridgeConfig()` first.
 */
export function relaySourceOf(
  account: Pick<WalletAccount, 'publicKey' | 'relayEvmAddress'> | null | undefined
): RelaySource | null {
  if (!account) return null;
  const address = lowerAddress(account.relayEvmAddress);
  if (address === null || !relayIsOn()) return null;
  return { accountPublicKey: account.publicKey, address };
}

/**
 * The relay source whose address is `address` (letter case ignored), when it is the relay address of an account of
 * this wallet (the store's accounts) and the relay is on. Else null.
 */
export function findRelaySource(address: string): RelaySource | null {
  const wanted = lowerAddress(address);
  if (wanted === null) return null;
  const account = useWalletStore
    .getState()
    .accounts.find(candidate => lowerAddress(candidate.relayEvmAddress) === wanted);
  return relaySourceOf(account);
}

interface RelayChainParts {
  relayChain: RelayChainConfig;
  chain: Chain;
  rpcUrl: string;
}

/** The relay entry, the viem chain and the RPC URL of `chainId`, or null when one of them is missing. */
function relayChainParts(chainId: number): RelayChainParts | null {
  if (getRelayBaseUrl() === null) return null;
  const relayChain = getRelayChain(chainId);
  const chain = evmRpcChain(chainId);
  const rpcUrl = chain?.rpcUrls.default.http[0];
  if (relayChain === null || chain === null || !rpcUrl) return null;
  return { relayChain, chain, rpcUrl };
}

/**
 * True when the relay serves `chainId`: the config has an entry for the chain, a base URL is known, and the wallet
 * has a definition and an RPC for the chain.
 */
export function relayServesChain(chainId: number): boolean {
  return relayChainParts(chainId) !== null;
}

function requireRelayChain(chainId: number): RelayChainParts {
  const parts = relayChainParts(chainId);
  if (parts === null) throw new RelayUnavailableError('not_configured', `relay: chain ${chainId} is not served`);
  return parts;
}

function signerOf(source: RelaySource): (request: RelaySignRequest) => Promise<RelaySignResult> {
  return request => useWalletStore.getState().signRelay(source.accountPublicKey, request);
}

function providerFor(source: RelaySource, parts: RelayChainParts, hooks: RelaySubmitOptions): RelayProvider {
  return createRelayProvider({
    chain: parts.relayChain,
    address: source.address,
    rpcUrl: parts.rpcUrl,
    sign: signerOf(source),
    beforeSign: hooks.beforeSign,
    onJob: hooks.onJob,
    fee: hooks.fee
  });
}

/**
 * An EIP-1193 relay provider for `source` on `chainId`. The vault signs through the store's `signRelay` action for
 * the account of the source. `hooks` go to each submit. Throws `RelayUnavailableError` (`not_configured`) when the
 * relay does not serve the chain.
 */
export function buildRelayProvider(
  source: RelaySource,
  chainId: number,
  hooks: RelaySubmitOptions = {}
): RelayProvider {
  return providerFor(source, requireRelayChain(chainId), hooks);
}

/**
 * The relay submitter of `source` on `chainId`, for a flow that follows a stored job (`check`, `resume`) and sends
 * nothing itself. A `submit` signs through the store's `signRelay` action, as the provider does. Throws
 * `RelayUnavailableError` (`not_configured`) when the relay does not serve the chain.
 */
export function buildRelaySubmitter(source: RelaySource, chainId: number): RelaySubmitter {
  const parts = requireRelayChain(chainId);
  return createRelaySubmitter({ chain: parts.relayChain, address: source.address, sign: signerOf(source) });
}

/** A viem `WalletClient` over `buildRelayProvider`, on the wallet's chain definition with the wallet's RPC. */
export function buildRelayWalletClient(
  source: RelaySource,
  chainId: number,
  hooks: RelaySubmitOptions = {}
): WalletClient {
  const parts = requireRelayChain(chainId);
  return createRelayWalletClient(providerFor(source, parts, hooks), parts.chain);
}
