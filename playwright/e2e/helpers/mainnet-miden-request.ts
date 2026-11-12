export interface MainnetReturnNoteScope {
  noteId: string;
  accountHex: string;
  faucetHex: string;
  minimumOutput: bigint;
}

export function inspectMainnetReturnNote(_scope: MainnetReturnNoteScope, _bytes: Uint8Array): bigint {
  throw new Error('Shared mainnet return-note inspection is not implemented');
}
