import { isAddress as isSolanaAddress } from '@solana/addresses';
import { isAddress as isEvmAddress } from 'viem';

export type ChainFamily = 'evm' | 'solana';

/** Check address syntax for the selected family. This does not check account ownership. */
export function isValidChainAddress(value: string, family: ChainFamily): boolean {
  const address = value.trim();
  switch (family) {
    case 'evm': {
      if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return false;
      const body = address.slice(2);
      if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
      return isEvmAddress(address);
    }
    case 'solana':
      return isSolanaAddress(address);
    default:
      return false;
  }
}

export function recipientAddressKey(value: string): string {
  const trimmed = value.trim();
  return isValidChainAddress(trimmed, 'solana') ? trimmed : trimmed.toLowerCase();
}
