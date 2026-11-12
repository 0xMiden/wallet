export interface TestMainnetSendScope {
  accountId: string;
  recipientId: string;
  faucetId: string;
  amount: string;
}

export function inspectTestMainnetSendRequest(_scope: TestMainnetSendScope, _bytes: Uint8Array): string {
  throw new Error('Exact native send request inspection is not implemented');
}
