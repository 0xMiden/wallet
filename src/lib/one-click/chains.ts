// A leaf module: the transaction pipeline reads it, so it must not import the 1Click client or tracking.

/** The EVM chain id of a 1Click EVM blockchain name (eth 1, base 8453, arb 42161, op 10, ...), or undefined. */
export function nearIntentsEvmChainId(chainId: string): number | undefined {
  switch (chainId) {
    case 'eth':
      return 1;
    case 'op':
      return 10;
    case 'bsc':
      return 56;
    case 'gnosis':
      return 100;
    case 'pol':
      return 137;
    case 'base':
      return 8453;
    case 'arb':
      return 42161;
    case 'avax':
      return 43114;
    case 'bera':
      return 80094;
    default:
      return undefined;
  }
}
