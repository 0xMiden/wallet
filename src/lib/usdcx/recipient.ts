import { Hex, pad } from 'viem';

const MIDEN_ACCOUNT_HEX_ID = /^0x[0-9a-fA-F]{30}$/;

/**
 * Encode a Miden account id as the `remoteRecipient` bytes32 the USDCx faucet
 * expects (`EthEmbeddedAccountId::to_bytes32`).
 *
 * A Miden account id is 15 bytes: an 8-byte prefix and a 7-byte suffix. The
 * layout is: bytes 0 to 15 zero, bytes 16 to 23 the prefix, bytes 24 to 31 the
 * suffix followed by one zero byte. In practice: append `00` to the 30-hex-char
 * id and left-pad to 32 bytes.
 *
 * The input is the hex form from `AccountId.toString()`. The function is pure
 * so it can be tested without the SDK. It throws on any other shape, because
 * the faucet checks the id structure on chain and an invalid id can never be
 * minted to.
 */
export function midenAccountHexToXReserveRecipient(hexId: string): Hex {
  if (!MIDEN_ACCOUNT_HEX_ID.test(hexId)) {
    throw new Error(`Invalid Miden account id: ${hexId}`);
  }
  const suffixed: Hex = `0x${hexId.slice(2).toLowerCase()}00`;
  return pad(suffixed, { size: 32, dir: 'left' });
}
