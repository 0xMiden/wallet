/**
 * @jest-environment node
 */
import { FakeEpochAllocator } from './fake-epoch-allocator';

describe('iOS FakeEpochAllocator', () => {
  const allocator = new FakeEpochAllocator(0);

  beforeAll(() => allocator.start());
  afterAll(() => allocator.stop());

  it('answers /health in the SDK HealthCheckResponse shape, so the Fast route reads as available', async () => {
    const res = await fetch(`${allocator.baseUrl}/health`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      status: 'healthy',
      allocatorAddresses: { '11155111': expect.any(String), '999999999': expect.any(String) },
      arbiterAddresses: { '11155111': expect.any(String), '999999999': expect.any(String) },
      compactAddresses: { '11155111': expect.any(String), '999999999': expect.any(String) },
      compactLockResetPeriod: 4,
      compactLockScope: 0,
      compactExpirySeconds: 600,
      compactExpiryBufferSeconds: 60,
      midenRecallBufferBlocks: 1000,
      midenVirtualChainId: 999999999,
      supportedChains: expect.any(Array)
    });
  });

  it('answers /miden-recipient with the collateral config the SDK reads', async () => {
    const res = await fetch(`${allocator.baseUrl}/miden-recipient`);
    await expect(res.json()).resolves.toMatchObject({
      midenP2IDRecipientAccountId: expect.stringMatching(/^0x[0-9a-f]{30}$/),
      midenMinReclaimBlocks: expect.any(Number)
    });
  });

  it('quotes the deposit amount in EVM USDC base units at 18 decimals', async () => {
    const res = await fetch(`${allocator.baseUrl}/checkIfDepositNeeded`, { method: 'POST', body: '{}' });
    await expect(res.json()).resolves.toMatchObject({ tokenIn: '1010000000000000000', tokenInDecimals: 18 });
  });
});
