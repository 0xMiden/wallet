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
