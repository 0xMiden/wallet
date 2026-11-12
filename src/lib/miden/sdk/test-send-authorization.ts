export const TEST_SEND_AUTHORIZATION_KEY = 'e2e_mainnet_send_authorization';

export async function awaitTestSendAuthorization(_accountId: string, _request: { serialize(): Uint8Array }): Promise<void> {
  throw new Error('Native SDK send upload hold is not implemented');
}
