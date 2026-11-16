import { referenceSnapshot } from './fixtures';

it.each(['testnet', 'mainnet'] satisfies Array<'testnet' | 'mainnet'>)(
  'retains the final %s reference deployment through the real wallet document and derived decoders',
  network => {
    const snapshot = referenceSnapshot(network);
    expect(snapshot.config?.network).toBe(network);
    expect(snapshot.derived?.version).toBe(snapshot.config?.version);
    expect(
      snapshot.config?.supportedEvmChains[network === 'testnet' ? 'sepolia' : 'ethereum']?.bridges.epoch?.tokens.USDC
    ).toBeDefined();
    expect(snapshot.derived?.chains[network === 'testnet' ? 11155111 : 1]?.epoch.tokens.USDC?.state).toBe('ok');
    expect(snapshot.derived?.swap?.pairs.state).toBe('skipped');
  }
);
