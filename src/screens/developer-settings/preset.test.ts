import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/constants';

import { ENDPOINT_PRESETS, NETWORK_ID_OPTIONS, presetToOverride } from './preset';

describe('preset helper', () => {
  it('lists the selectable presets', () => {
    expect(ENDPOINT_PRESETS).toEqual([
      MIDEN_NETWORK_NAME.TESTNET,
      MIDEN_NETWORK_NAME.DEVNET,
      MIDEN_NETWORK_NAME.LOCALNET
    ]);
  });

  it('lists Mainnet plus every preset network for the network-id picker', () => {
    expect(NETWORK_ID_OPTIONS).toEqual([
      MIDEN_NETWORK_NAME.MAINNET,
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
