import { MAINNET_ACCESS_CODE_LENGTH, MAINNET_ACCESS_PREVIEW_CODE, redeemMainnetAccessCode } from './mainnet-access';

describe('mainnet access code (placeholder until the service exists)', () => {
  it('accepts the preview code, which has the length the sheet asks for', async () => {
    expect(MAINNET_ACCESS_PREVIEW_CODE).toHaveLength(MAINNET_ACCESS_CODE_LENGTH);
    await expect(redeemMainnetAccessCode(MAINNET_ACCESS_PREVIEW_CODE)).resolves.toBe('granted');
  });

  it('refuses every other code', async () => {
    await expect(redeemMainnetAccessCode('00000000')).resolves.toBe('rejected');
    await expect(redeemMainnetAccessCode('')).resolves.toBe('rejected');
  });
});
