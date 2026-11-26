/**
 * Wallet payment links (Trust, MetaMask, Rainbow) for a transfer on an EVM chain. A screen that shows a deposit
 * address offers these links, so the user can open a wallet app with the transfer already filled in. The links carry
 * the amount in base units (EIP-681 `uint256` / `value`) and, for Trust, in decimal text.
 */
import { formatUnits, zeroAddress } from 'viem';

export type PaymentWalletId = 'trust' | 'metamask' | 'rainbow' | 'phantom';

export interface WalletPaymentLink {
  wallet: PaymentWalletId;
  url: string;
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MAX_DECIMALS = 38;

/** The Trust coin id of an EVM chain, or undefined. Trust coin ids are not EVM chain ids (trustwallet/wallet-core). */
export function trustCoinOfEvmChain(chainId: number): number | undefined {
  switch (chainId) {
    case 1:
      return 60;
    case 8453:
      return 8453;
    case 42161:
      return 10042221;
    case 10:
      return 10000070;
    default:
      return undefined;
  }
}

/** A Trust `send` link. `asset` is the Trust asset id, `amount` is decimal text. */
export function trustPaymentLink(asset: string, address: string, amount: string, memo?: string): WalletPaymentLink {
  const query = new URLSearchParams({ asset, address, amount });
  if (memo) query.set('memo', memo);
  return { wallet: 'trust', url: `trust://send?${query}` };
}

export interface EvmPaymentLinkParts {
  chainId: number;
  /** The Trust coin id of the chain (`trustCoinOfEvmChain`). */
  trustCoin: number;
  /** The token contract, or undefined for the native coin. */
  token: string | undefined;
  to: string;
  /** The amount in base units, decimal text. */
  units: string;
  /** The same amount as decimal text in whole tokens. */
  amount: string;
  /** A memo that the transfer must carry. Only Trust can carry it, so a memo gives the Trust link alone. */
  memo?: string;
}

/**
 * The links of a transfer whose fields the caller has checked: Trust, then MetaMask and Rainbow (EIP-681). The text
 * goes into the links as it is.
 */
export function evmPaymentLinksOf({
  chainId,
  trustCoin,
  token,
  to,
  units,
  amount,
  memo
}: EvmPaymentLinkParts): WalletPaymentLink[] {
  const trust = trustPaymentLink(token ? `c${trustCoin}_t${token}` : `c${trustCoin}`, to, amount, memo);
  if (memo) return [trust];
  const path = token
    ? `${token}@${chainId}/transfer?${new URLSearchParams({ address: to, uint256: units })}`
    : `${to}@${chainId}?${new URLSearchParams({ value: units })}`;
  return [
    trust,
    { wallet: 'metamask', url: `metamask://send/${path}` },
    { wallet: 'rainbow', url: `ethereum:${path}` }
  ];
}

/**
 * The payment links of a transfer of `amountBaseUnits` of `token` to `to` on `chainId`. `token` null or the zero
 * address is the native coin. Empty for a chain without a mapping, an address that is not a 20-byte hex address, an
 * amount of zero or less, and a `decimals` that is not an integer from 0 to 38.
 */
export function evmPaymentLinks(input: {
  chainId: number;
  token: `0x${string}` | null;
  to: `0x${string}`;
  amountBaseUnits: bigint;
  decimals: number;
}): WalletPaymentLink[] {
  const { chainId, to, amountBaseUnits, decimals } = input;
  const token = input.token === null || input.token.toLowerCase() === zeroAddress ? undefined : input.token;
  const trustCoin = trustCoinOfEvmChain(chainId);
  if (trustCoin === undefined || !EVM_ADDRESS.test(to)) return [];
  if (token !== undefined && !EVM_ADDRESS.test(token)) return [];
  if (amountBaseUnits <= 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) return [];
  return evmPaymentLinksOf({
    chainId,
    trustCoin,
    token,
    to,
    units: amountBaseUnits.toString(),
    amount: formatUnits(amountBaseUnits, decimals)
  });
}
