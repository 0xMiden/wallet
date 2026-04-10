/**
 * Coverage tests for `lib/miden-chain/constants.ts`.
 *
 * Covers the getNetworkId function.
 */

import { getNetworkId } from './constants';

describe('miden-chain/constants', () => {
  it('getNetworkId returns a NetworkId', () => {
    const id = getNetworkId();
    expect(id).toBeDefined();
  });
});
