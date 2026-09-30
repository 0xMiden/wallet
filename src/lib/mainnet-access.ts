/** The number of digits in a mainnet access code. */
export const MAINNET_ACCESS_CODE_LENGTH = 8;

export type MainnetAccessOutcome = 'granted' | 'rejected';

/**
 * A placeholder code, the one in the design. It is here only so that the accepted path (the oven
 * and the welcome screen) can be seen before the access-code service exists. Remove it when the
 * service is connected: a code in the bundle is not a secret.
 */
export const MAINNET_ACCESS_PREVIEW_CODE = '47291835';

/**
 * Asks if an access code opens mainnet for this wallet.
 *
 * No access-code service exists yet. Until it does, the function accepts the preview code and
 * refuses every other code. Connect the service here. The sheet that calls this function shows a
 * refusal to the user, and an accepted code starts the welcome.
 */
export async function redeemMainnetAccessCode(code: string): Promise<MainnetAccessOutcome> {
  return code === MAINNET_ACCESS_PREVIEW_CODE ? 'granted' : 'rejected';
}
