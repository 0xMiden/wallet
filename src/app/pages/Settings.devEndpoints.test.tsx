import { isEndpointOverrideActive } from 'lib/miden-chain/effective-endpoints';

jest.mock('lib/miden-chain/effective-endpoints', () => ({
  isEndpointOverrideActive: jest.fn()
}));

// A pure unit over the visibility predicate the Settings page uses.
// eslint-disable-next-line import/first
import { shouldShowDevEndpointsRow } from './Settings';

describe('developer endpoints settings row visibility', () => {
  it('hidden when no override is active', async () => {
    (isEndpointOverrideActive as jest.Mock).mockResolvedValue(false);
    expect(await shouldShowDevEndpointsRow()).toBe(false);
  });

  it('shown when an override is active', async () => {
    (isEndpointOverrideActive as jest.Mock).mockResolvedValue(true);
    expect(await shouldShowDevEndpointsRow()).toBe(true);
  });
});
