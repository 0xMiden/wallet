export const MIDEN_BRIDGE_ID = '0xa22ec154f9a36d911953fd5c9260a7';
export const MIDEN_AGGLAYER_FAUCET_ID = '0x387149ae66116cf114eebd60bb7381';

// Agglayer network id of the EVM destination (Sepolia / L1 origin network) used
// as the destination network when bridging Miden → EVM.
export const EVM_AGGLAYER_NETWORK_ID = 0;

// E2E-only override for the bridgeable AggLayer faucet id. Production leaves this
// null (the hook that sets it is installed only under MIDEN_E2E_TEST), so the
// real bridge faucet is used. The bridge-OUT AggLayer harness can't mint the real
// faucet (custom transfer-policy, no key), so it points the whole Slow route at a
// runtime-created test faucet instead. Mirrors `setAgglayerSenderForE2E`
// (bridge-in). Read on the FRONT (createB2AggNote + the send-flow route gate);
// `hasAgglayerFaucetOverride()` also flips the note's asset-callback flag so a
// plain CLI faucet's (Disabled-flagged) balance is found — see b2agg/index.ts.
let e2eFaucetOverride: string | null = null;

export function setAgglayerFaucetForE2E(faucetId: string): void {
  e2eFaucetOverride = faucetId;
}

export function getAgglayerFaucetId(): string {
  return e2eFaucetOverride ?? MIDEN_AGGLAYER_FAUCET_ID;
}

export function hasAgglayerFaucetOverride(): boolean {
  return e2eFaucetOverride !== null;
}
