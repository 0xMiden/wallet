/** The Transak product that the challenge opens: a buy of USDC, or a sell of USDCx. */
export type TransakChallengeSide = 'buy' | 'sell';

export interface TransakChallengeInput {
  side: TransakChallengeSide;
  /** Buy: the USD amount. Sell: the USDCx amount. */
  amount: string;
  address: string;
  /** The Miden account that receives the bridged funds (buy) or sells them (sell): lower case `0x` + 30 hex. */
  midenAccountHex: string;
  nonce: string;
  expiresAt: number;
}

/**
 * Make the text that the wallet signs to open a Transak checkout.
 *
 * This is a byte-identical twin of `buildChallengeMessage` in `backend/src/transak/challenge.ts`. The two packages do not
 * share code. If you change one, change the other, else the wallet refuses every challenge.
 */
export function buildChallengeMessage({
  side,
  amount,
  address,
  midenAccountHex,
  nonce,
  expiresAt
}: TransakChallengeInput): string {
  const expires = new Date(expiresAt * 1000).toISOString();
  const tail = `for Miden account ${midenAccountHex} via Transak. Nonce ${nonce}, expires ${expires}.`;
  switch (side) {
    case 'buy':
      return `Buy ${amount} USD of USDC on Ethereum to ${address} ${tail}`;
    case 'sell':
      return `Sell ${amount} USDCx as USDC on Ethereum from ${address} ${tail}`;
  }
}
