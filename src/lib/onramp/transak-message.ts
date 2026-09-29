export interface TransakChallengeInput {
  fiatAmount: string;
  address: string;
  nonce: string;
  expiresAt: number;
}

/**
 * Make the text that the wallet signs to open a Transak checkout.
 *
 * This is a byte-identical twin of `buildChallengeMessage` in `backend/src/challenge.ts`. The two packages do not
 * share code. If you change one, change the other, else the wallet refuses every challenge.
 */
export function buildChallengeMessage({ fiatAmount, address, nonce, expiresAt }: TransakChallengeInput): string {
  const expires = new Date(expiresAt * 1000).toISOString();
  return `Buy ${fiatAmount} USD of USDC on Ethereum to ${address} via Transak. Nonce ${nonce}, expires ${expires}.`;
}
