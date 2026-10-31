/** The chain names accepted by this wallet build. */
export function evmChainSlug(chainId: number): string | undefined {
  switch (chainId) {
    case 1:
      return 'ethereum';
    case 10:
      return 'optimism';
    case 8453:
      return 'base';
    case 42161:
      return 'arbitrum';
    case 137:
      return 'polygon';
    case 4663:
      return 'robinhood';
    case 5042:
      return 'arc';
    case 11155111:
      return 'sepolia';
    case 5042002:
      return 'arc-testnet';
    case 84532:
      return 'base-sepolia';
    case 421614:
      return 'arbitrum-sepolia';
    default:
      return undefined;
  }
}
