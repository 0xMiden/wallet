export interface MainnetMidenOutputCandidates {
  transactionId: string;
  senderAddress: string;
  senderHex: string;
  blockNumber: number;
  noteIds: string[];
}

export async function readMainnetMidenOutputCandidates(
  _transactionId: string, _walletAccountHex: string, _fetcher: typeof fetch = fetch
): Promise<MainnetMidenOutputCandidates> {
  throw new Error('Exact mainnet maker transaction candidate lookup is not implemented');
}
