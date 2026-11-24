import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/constants';

import { ENDPOINT_PRESETS, NETWORK_ID_OPTIONS, presetToOverride } from './preset';

describe('preset helper', () => {
  it('lists the selectable presets', () => {
    expect(ENDPOINT_PRESETS).toEqual([
      MIDEN_NETWORK_NAME.MAINNET,
      MIDEN_NETWORK_NAME.TESTNET,
      MIDEN_NETWORK_NAME.DEVNET,
      MIDEN_NETWORK_NAME.LOCALNET
    ]);
  });

  it('the Mainnet preset prefills the mainnet RPC, prover, transport, explorer and network id, and no faucet', () => {
    const o = presetToOverride(MIDEN_NETWORK_NAME.MAINNET);
    expect(o.networkName).toBe(MIDEN_NETWORK_NAME.MAINNET);
    expect(o.presetName).toBe(MIDEN_NETWORK_NAME.MAINNET);
    expect(o.rpcUrl).toBe('https://rpc.mainnet.miden.io');
    expect(o.proverUrl).toBe('https://tx-prover.mainnet.miden.io');
    expect(o.noteTransportUrl).toBe('https://transport.mainnet.miden.io');
    expect(o.explorerUrl).toBe('https://explorer.mainnet.miden.io');
    expect(o.faucetUrl).toBe('');
    expect(o.faucetApiUrl).toBe('');
  });

  it('lists the same networks for the network-id picker', () => {
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
