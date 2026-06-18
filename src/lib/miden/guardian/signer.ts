import { RequestAuthPayload, SignatureScheme, Signer } from '@openzeppelin/guardian-client';

import { AuthDigest } from './digest';
export type SignWordFunction = (publicKey: string, wordHex: string) => Promise<string>;

export class WalletSigner implements Signer {
  readonly commitment: string;
  readonly publicKey: string;
  readonly scheme: SignatureScheme;
  private signWordFn: (wordHex: string) => Promise<string>;

  constructor(publicKey: string, commitment: string, signWordFn: SignWordFunction, scheme: SignatureScheme = 'ecdsa') {
    this.publicKey = publicKey;
    this.commitment = commitment;
    this.scheme = scheme;
    // Vault.signWord looks up the stored hot ciphertext by hotPublicKey (the
    // 33-byte compressed pubkey hex), NOT by commitment — see
    // accAuthSecretKeyStrgKey(keys.hotPublicKey) in vault.ts persistGuardianKeys.
    // The legacy Falcon path keyed storage by commitment, which was equivalent
    // for that scheme but broke once Phase 2 standardized on hotPublicKey.
    const pubKeyNoPrefix = publicKey.startsWith('0x') ? publicKey.slice(2) : publicKey;
    this.signWordFn = (wordHex: string) => signWordFn(pubKeyNoPrefix, wordHex);
  }

  async signAccountIdWithTimestamp(accountId: string, timestamp: number): Promise<string> {
    const digest = AuthDigest.fromAccountIdWithTimestamp(accountId, timestamp);
    const sig = await this.signWordFn(digest.toHex());
    console.log('Signature for accountId and timestamp:', sig);
    return sig;
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
