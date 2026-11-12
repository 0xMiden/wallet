export const TEST_CONSUME_AUTHORIZATION_KEY = 'e2e_mainnet_consume_authorization';

export async function awaitTestConsumeAuthorization(
  _accountId: string, _noteIds: string[], _request: { serialize(): Uint8Array }
): Promise<void> {
  throw new Error('Exact test consume authorization is not implemented');
}
