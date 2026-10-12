/**
 * @jest-environment node
 */
import { buildDummyLendingItem } from './fake-epoch-positions';
import { MOCK_USDC_ADDRESS } from '../ios/helpers/evm-doubles';

describe('buildDummyLendingItem', () => {
  it('reports the EVM USDC at 18 decimals, as the Sepolia token and the Anvil mock answer', () => {
    const position = buildDummyLendingItem({ depositAmount: '10' }).data[0]?.positions[0];
    expect(position?.underlyingInfo.asset).toMatchObject({ address: MOCK_USDC_ADDRESS, decimals: 18, symbol: 'USDC' });
  });

  it('keys a position by the market uid the wallet derives from the served document', () => {
    const position = buildDummyLendingItem({ depositAmount: '10' }).data[0]?.positions[0];
    expect(position?.marketUid).toBe('DUMMY_LENDING:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69');
  });
});
