import type { GcClaimDeploymentData } from './gc-claim-deployment';
import { resolveGcClaimDeployment } from './gc-claim-deployment';

let mockNetwork = 'testnet';
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveNetworkName: () => mockNetwork }));
afterEach(() => {
  mockNetwork = 'testnet';
});
it('pins only the deployed replacement Testnet issuer and its script', async () => {
  const config = await resolveGcClaimDeployment();
  expect(config).toMatchObject({
    issuerId: '0x97924b9a77ed54917ff6d6364ae661',
    issuerCodeCommitment: '0x2898ac7fc97bcd7605db86fa839f2e0d8c96c74ed238769b76716dbcd22e47d5',
    deploymentBlock: 461926,
    nativeSymbol: 'USDCX',
    nativeDecimals: 6
  });
  expect(config?.claimScriptBytes.length).toBeGreaterThan(0);
});
it('does not activate Mainnet or a custom network', async () => {
  for (const network of ['mainnet', 'devnet', 'localhost']) {
    mockNetwork = network;
    await expect(resolveGcClaimDeployment()).resolves.toBeUndefined();
  }
});
it('does not let a caller mutate the next prepared script', async () => {
  const first = await resolveGcClaimDeployment();
  if (!first || first.claimScriptBytes.length === 0) throw new Error('Missing pinned script');
  const initial = first.claimScriptBytes[0]!;
  first.claimScriptBytes[0] = initial ^ 255;
  const second = await resolveGcClaimDeployment();
  expect(second?.claimScriptBytes[0]).toBe(initial);
});

it('materializes reviewed v2 configuration without enabling the construction fixture', async () => {
  const { decodeGcClaimDeployment } = await import('./gc-claim-deployment');
  const raw: GcClaimDeploymentData = {
    network: 'testnet',
    genesisCommitment: `0x${'aa'.repeat(32)}`,
    issuerId: '0x97924b9a77ed54917ff6d6364ae661',
    issuerCodeCommitment: `0x${'bb'.repeat(32)}`,
    nativeAssetId: '0x4cbdcaffe75f0a317482224dae6436',
    claimScriptRoot: `0x${'cc'.repeat(32)}`,
    claimScriptHex: '010203',
    deploymentBlock: 500000,
    reclaimDelayBlocks: 100,
    nativeSymbol: 'USDCX',
    nativeDecimals: 6,
    distribution: {
      protocolVersion: 2,
      distributorId: '0x97924b9a77ed54917ff6d6364ae661',
      distributorCodeCommitment: `0x${'bb'.repeat(32)}`,
      gcFaucetId: '0xe1f2c48d5bfa8d5173dfcfdc8ac977',
      weeklyClaimsSlot: 'bread::gc::distributor::weekly_claims'
    }
  };
  const decoded = decodeGcClaimDeployment(raw);
  raw.distribution!.gcFaucetId = raw.issuerId;
  expect(decoded.distribution?.gcFaucetId).toBe('0xe1f2c48d5bfa8d5173dfcfdc8ac977');
  expect(decoded.claimScriptBytes).toEqual(new Uint8Array([1, 2, 3]));
  expect(() => decodeGcClaimDeployment(raw)).toThrow();
  expect((await resolveGcClaimDeployment())?.distribution).toBeUndefined();
});
