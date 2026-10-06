/**
 * @jest-environment node
 */
import { MOCK_AGGLAYER_BRIDGE_RUNTIME, MOCK_USDC_RUNTIME } from './evm-doubles';

// A function the runtime dispatches on appears as PUSH4 (0x63) followed by its selector.
const dispatches = (runtime: string, selector: string) => runtime.includes(`63${selector}`);

describe('Anvil doubles answer what the wallet derives from the real contracts', () => {
  it('MockAggLayerBridge dispatches networkID() as well as bridgeAsset()', () => {
    expect(dispatches(MOCK_AGGLAYER_BRIDGE_RUNTIME, 'bab161bf')).toBe(true);
    expect(dispatches(MOCK_AGGLAYER_BRIDGE_RUNTIME, 'cd586579')).toBe(true);
  });

  it('MockUsdc dispatches symbol() and decimals(), and decimals() returns 18', () => {
    expect(dispatches(MOCK_USDC_RUNTIME, '95d89b41')).toBe(true);
    expect(dispatches(MOCK_USDC_RUNTIME, '313ce567')).toBe(true);
    // decimals() body: PUSH1 0x12 stored and returned; the 6-decimal mock pushed 0x06 here.
    expect(MOCK_USDC_RUNTIME).toContain('604051601281526020');
    expect(MOCK_USDC_RUNTIME).not.toContain('604051600681526020');
  });
});
