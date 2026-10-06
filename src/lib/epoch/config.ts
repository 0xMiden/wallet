import { MIDEN_VIRTUAL_CHAIN_ID } from '@epoch-protocol/epoch-intents-sdk';

/**
 * Virtual chain id the Epoch SDK uses when an intent's origin / destination
 * is the Miden chain. The walletClient's `chain.id` must be temporarily set
 * to this value when calling solveIntent for a Miden→EVM flow. See:
 * https://docs.epochprotocol.xyz/epoch-miden-integration/integration-guide
 */
export const MIDEN_DESTINATION_CHAIN_ID: number = MIDEN_VIRTUAL_CHAIN_ID;
