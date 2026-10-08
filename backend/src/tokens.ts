import { getAddress, type Address } from 'viem';

interface OnrampToken {
  readonly address: Address;
  readonly decimals: number;
}

/** Fixed tokens for the Ethereum USDC buy route. */
export const ONRAMP_TOKENS = {
  // Ethereum USDC: https://developers.circle.com/stablecoins/usdc-contract-addresses
  1: { address: getAddress('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'), decimals: 6 },
  // Transak staging delivers TRNSK on Sepolia for this route.
  11155111: { address: getAddress('0x0c86a754a29714c4fe9c6f1359fa7099ed174c0b'), decimals: 18 }
} satisfies Record<1 | 11155111, OnrampToken>;
