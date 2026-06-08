import { MIDEN_AGGLAYER_FAUCET_ID } from 'lib/agglayer/b2agg/constant';

/**
 * EVM-side configuration for the Epoch (Fast) route. All values are Sepolia /
 * testnet.
 *
 * The **Agglayer (Slow)** route can only bridge the dedicated agglayer faucet
 * token (`BRIDGEABLE_MIDEN_FAUCET_ID`). The **Epoch (Fast)** route bridges any
 * token — the selected token's faucet id is threaded through the quote/send —
 * and forward-quotes the Miden input into the fixed EVM output token below
 * (Sepolia USDC), so it must know which EVM ERC-20 the user receives.
 */
export const BRIDGEABLE_MIDEN_FAUCET_ID = MIDEN_AGGLAYER_FAUCET_ID;

/** EVM destination chain for the Epoch route (Sepolia). */
export const EPOCH_DESTINATION_CHAIN_ID = 11155111;

/** Sepolia USDC — the fixed EVM output token for the Epoch (Fast) route. */
export const BRIDGEABLE_EVM_OUTPUT_TOKEN_ADDRESS: string = '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69';

/** Output token symbol, shown in the quote preview. */
export const BRIDGEABLE_EVM_OUTPUT_TOKEN_SYMBOL = 'USDC';

/** Decimals of the EVM output token (Epoch's amounts use an 18-decimal convention). */
export const BRIDGEABLE_EVM_OUTPUT_TOKEN_DECIMALS = 18;

/** Whether the Epoch (Fast) route is configured well enough to run. */
export function isBridgeableEvmTokenConfigured(): boolean {
  return (
    /^0x[0-9a-fA-F]{40}$/.test(BRIDGEABLE_EVM_OUTPUT_TOKEN_ADDRESS) &&
    BRIDGEABLE_EVM_OUTPUT_TOKEN_ADDRESS !== '0x0000000000000000000000000000000000000000'
  );
}
