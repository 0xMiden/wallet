export interface TransakChallengeInput {
  fiatAmount: string;
  address: string;
  /** The Miden account that receives the bridged funds: lower case `0x` + 30 hex. */
  midenAccountHex: string;
  nonce: string;
  expiresAt: number;
}

/**
 * Make the text that the wallet signs to open a Transak checkout.
 *
 * This is a byte-identical twin of `buildChallengeMessage` in `backend/src/challenge.ts`. The two packages do not
 * share code. If you change one, change the other, else the wallet refuses every challenge.
 */
export function buildChallengeMessage({
  fiatAmount,
  address,
  midenAccountHex,
  nonce,
  expiresAt
}: TransakChallengeInput): string {
  const expires = new Date(expiresAt * 1000).toISOString();
  return `Buy ${fiatAmount} USD of USDC on Ethereum to ${address} for Miden account ${midenAccountHex} via Transak. Nonce ${nonce}, expires ${expires}.`;
}
