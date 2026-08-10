/**
 * Epoch Protocol integration config.
 *
 * Epoch handles cross-chain intents between the user's EVM wallet (held by
 * MetaMask et al. and reached via WalletConnect — see lib/walletconnect) and
 * the Miden chain. The wallet is the dApp / intent submitter; the allocator
 * is hosted by Epoch.
 */

export const EPOCH_ALLOCATOR_URL = process.env.EPOCH_ALLOCATOR_URL ?? 'https://testnet-dev.epochprotocol.xyz';

/**
 * Read-only Dummy Lending positions service. A SEPARATE host from the allocator
 * (`EPOCH_ALLOCATOR_URL`) — it only reads on-chain lending state, never submits.
 * Used by the Earn views to fetch a user's open positions by their EVM
 * position-owner address(es). See `lib/epoch/positions.ts`.
 */
export const EPOCH_POSITIONS_URL = process.env.EPOCH_POSITIONS_URL ?? 'https://positions-testnet-dev.epochprotocol.xyz';

/**
 * Virtual chain id used by the SDK when an intent's origin / destination
 * is the Miden chain. The walletClient's `chain.id` must be temporarily set
 * to this value when calling solveIntent for a Miden→EVM flow. See:
 * https://docs.epochprotocol.xyz/epoch-miden-integration/integration-guide
 */
export const MIDEN_DESTINATION_CHAIN_ID = 999999999;
