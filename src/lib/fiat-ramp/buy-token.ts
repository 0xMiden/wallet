/**
 * The ERC-20 the fiat on-ramp delivers on Sepolia and the buy watcher bridges
 * to Miden.
 */
export const BUY_TOKEN_ADDRESS: `0x${string}` = '0x699cFE8997d647D03325Ef4bfD039d5bB0984A17';

export const BUY_TOKEN_SYMBOL = 'USDC';

/** Fallback when the on-chain `decimals()` read fails (this token's value). */
const BUY_TOKEN_FALLBACK_DECIMALS = 18;

let cachedDecimals: number | undefined;

/** `decimals()` read once per session, falling back to 6 on RPC failure. */
export async function getBuyTokenDecimals(): Promise<number> {
  if (cachedDecimals !== undefined) return cachedDecimals;
  try {
    const { readErc20Decimals } = await import('lib/agglayer/vault-evm');
    cachedDecimals = await readErc20Decimals(BUY_TOKEN_ADDRESS);
  } catch (err) {
    console.warn('[buy] decimals() read failed, assuming 18', err);
    return BUY_TOKEN_FALLBACK_DECIMALS;
  }
  return cachedDecimals;
}
