/** The number of digits in a mainnet access code. */
export const MAINNET_ACCESS_CODE_LENGTH = 8;

export type MainnetAccessOutcome = 'granted' | 'rejected';

/**
 * Asks if an access code opens mainnet for this wallet.
 *
 * No access-code service exists yet, so the function refuses every code. Connect the service here.
 * The sheet that calls this function shows the refusal to the user.
 */
export async function redeemMainnetAccessCode(_code: string): Promise<MainnetAccessOutcome> {
  return 'rejected';
}
