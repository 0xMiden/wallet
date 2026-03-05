import { AccountId, Felt, FeltArray, Rpo256, Word } from '@miden-sdk/miden-sdk';
import { SignatureScheme, Signer } from '@openzeppelin/psm-client';

export type SignWordFunction = (publicKey: string, wordHex: string) => Promise<string>;

export class WalletSigner implements Signer {
  readonly commitment: string;
  readonly publicKey: string;
  readonly scheme: SignatureScheme = 'falcon';
  private signWordFn: SignWordFunction;
  readonly commitmentForStorageRetrieval: string;

  constructor(publicKey: string, commitment: string, signWordFn: SignWordFunction) {
    this.publicKey = publicKey;
    this.commitment = commitment;
    this.commitmentForStorageRetrieval = commitment.slice(2);
    this.signWordFn = signWordFn;
  }

  async signAccountIdWithTimestamp(accountId: string, timestamp: number): Promise<string> {
    const digest = WalletSigner.computeAccountDigest(accountId, timestamp);
    console.log('Signing account digest for storage retrieval', accountId);
    const sig = await this.signWordFn(this.commitmentForStorageRetrieval, digest.toHex());
    return sig;
  }

  async signCommitment(commitmentHex: string): Promise<string> {
    const paddedHex = commitmentHex.startsWith('0x') ? commitmentHex : `0x${commitmentHex}`;
    const sig = await this.signWordFn(this.commitmentForStorageRetrieval, paddedHex);
    return sig;
  }

  static computeAccountDigest(accountId: string, timestamp: number): Word {
    const paddedHex = accountId.startsWith('0x') ? accountId : `0x${accountId}`;
    const parsedAccountId = AccountId.fromHex(paddedHex);
    const prefix = parsedAccountId.prefix();
    const suffix = parsedAccountId.suffix();

    const feltArray = new FeltArray([prefix, suffix, new Felt(BigInt(timestamp)), new Felt(BigInt(0))]);

    return Rpo256.hashElements(feltArray);
  }
}
