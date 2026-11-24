import { DEFAULT_CHAIN_ID, type EvmChain, getChain } from 'lib/walletconnect/config';

const CHAIN_ID_SEGMENT = /^[1-9][0-9]*$/;

/**
 * The EVM chain id in an Epoch market uid (`LENDER_KEY:chainId:underlying`).
 * Undefined when the uid has no chain segment or the segment is not a positive safe integer.
 */
export function marketUidChainId(marketUid: string): number | undefined {
  const segment = marketUid.split(':')[1];
  if (segment === undefined || !CHAIN_ID_SEGMENT.test(segment)) return undefined;
  const chainId = Number(segment);
  return Number.isSafeInteger(chainId) ? chainId : undefined;
}

/**
 * The EVM chain that the explorer links of an Earn row go to: the chain of its market uid.
 * A row with no market uid uses `DEFAULT_CHAIN_ID`.
 * Undefined when the uid names no chain, or a chain that the registry does not know.
 * The caller then shows the EVM values without a link, never with the link of a different chain.
 */
export function earnRowChain(marketUid: string | undefined): EvmChain | undefined {
  if (marketUid === undefined || marketUid === '') return getChain(DEFAULT_CHAIN_ID);
  const chainId = marketUidChainId(marketUid);
  return chainId === undefined ? undefined : getChain(chainId);
}
