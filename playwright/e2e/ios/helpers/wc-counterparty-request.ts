import { hexToBigInt, isAddress, isAddressEqual, isHex, type Address, type Hex } from 'viem';

/** One transaction a counterparty was asked to sign, once parseSendRequest accepted it. */
export interface CounterpartyTransaction {
  to: Address;
  data: Hex;
  value: bigint;
}

/**
 * The transaction in an `eth_sendTransaction` session request, or an error naming why the key will not sign it: another
 * chain than the counterparty's, another sender, no target, no calldata or a value that is not hex. The address case
 * the app sends is not the checksum's, so addresses are compared without it.
 */
export function parseSendRequest(
  request: { chainId?: string; params: unknown },
  expected: { chainId: number; from: Address }
): CounterpartyTransaction {
  const chain = `eip155:${expected.chainId}`;
  if (request.chainId !== chain) {
    throw new Error(`eth_sendTransaction on ${request.chainId ?? 'no chain'}, not ${chain}: refused`);
  }
  const [tx] = Array.isArray(request.params) ? request.params : [];
  const field = (key: string): unknown => (tx !== null && typeof tx === 'object' ? Reflect.get(tx, key) : undefined);
  const from = field('from');
  const to = field('to');
  const data = field('data');
  const value = field('value');
  if (typeof from !== 'string' || !isAddress(from, { strict: false }) || !isAddressEqual(from, expected.from)) {
    throw new Error(`eth_sendTransaction from ${String(from)}, not the counterparty's ${expected.from}: refused`);
  }
  if (typeof to !== 'string' || !isAddress(to, { strict: false })) {
    throw new Error(`eth_sendTransaction to ${String(to)}: refused`);
  }
  if (!isHex(data) || data === '0x') throw new Error('eth_sendTransaction without calldata: refused');
  if (value !== undefined && !isHex(value)) throw new Error(`eth_sendTransaction value ${String(value)}: refused`);
  return { to, data, value: value === undefined ? 0n : hexToBigInt(value) };
}

/** The namespaces a counterparty approves: every chain in `chainIds` for `address`, with the methods it answers. */
export function sessionNamespaces(chainIds: readonly number[], address: Address) {
  return {
    eip155: {
      chains: chainIds.map(id => `eip155:${id}`),
      methods: ['eth_sendTransaction', 'personal_sign', 'eth_sign', 'eth_signTypedData', 'eth_signTypedData_v4'],
      events: ['chainChanged', 'accountsChanged'],
      accounts: chainIds.map(id => `eip155:${id}:${address}`)
    }
  };
}
