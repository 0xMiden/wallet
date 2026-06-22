import { RequestAuthPayload, SignatureScheme, Signer } from '@openzeppelin/guardian-client';

import { AuthDigest } from './digest';
export type SignWordFunction = (publicKey: string, wordHex: string) => Promise<string>;

export class WalletSigner implements Signer {
  readonly commitment: string;
  readonly publicKey: string;
  // Must match the scheme of the secret key the vault signs with. Guardian
  // accounts derive their signer key via `AuthSecretKey.ecdsaWithRNG`, so the
  // guardian verifies these signatures as ECDSA.
  readonly scheme: SignatureScheme = 'ecdsa';
  private signWordFn: (wordHex: string) => Promise<string>;

  constructor(publicKey: string, commitment: string, signWordFn: SignWordFunction) {
    this.publicKey = publicKey;
    this.commitment = commitment;
    this.signWordFn = (wordHex: string) => signWordFn(commitment.slice(2), wordHex);
  }

  async signAccountIdWithTimestamp(accountId: string, timestamp: number): Promise<string> {
    const digest = AuthDigest.fromAccountIdWithTimestamp(accountId, timestamp);
    return this.signWordFn(digest.toHex());
  }

  async signRequest(accountId: string, timestamp: number, requestPayload: RequestAuthPayload): Promise<string> {
    const digest = AuthDigest.fromRequest(accountId, timestamp, requestPayload);
    return this.signWordFn(digest.toHex());
  }

  async signCommitment(commitmentHex: string): Promise<string> {
    const paddedHex = commitmentHex.startsWith('0x') ? commitmentHex : `0x${commitmentHex}`;
    const sig = await this.signWordFn(paddedHex);
    return sig;
  }
}
