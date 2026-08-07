import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/constants';

import { ENDPOINT_PRESETS, presetToOverride } from './preset';

describe('preset helper', () => {
  it('lists the selectable presets', () => {
    expect(ENDPOINT_PRESETS).toEqual([
      MIDEN_NETWORK_NAME.TESTNET,
      MIDEN_NETWORK_NAME.DEVNET,
      MIDEN_NETWORK_NAME.LOCALNET
    ]);
  });

  it('presetToOverride prefills all fields and stamps presetName', () => {
    const o = presetToOverride(MIDEN_NETWORK_NAME.DEVNET);
    expect(o.networkName).toBe(MIDEN_NETWORK_NAME.DEVNET);
    expect(o.presetName).toBe(MIDEN_NETWORK_NAME.DEVNET);
    expect(o.rpcUrl).toContain('devnet');
  });
});
