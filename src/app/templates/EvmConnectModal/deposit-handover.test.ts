import { depositSheetOf } from './deposit-handover';
import type { RelayTokenChoice } from './relay-token-choices';

const ETHEREUM = { id: 'ethereum', name: 'Ethereum' };
const CHOICE: RelayTokenChoice = {
  option: { id: '1:ETH', symbol: 'ETH', receivedSymbol: 'ETH', logoFaucetId: undefined, network: ETHEREUM },
  chainId: 1,
  token: 'ETH',
  address: '0x0000000000000000000000000000000000000000',
  routes: ['agglayer']
};

describe('depositSheetOf', () => {
  it('is the relay sheet when no other flow gives rows', () => {
    expect(depositSheetOf(undefined, [ETHEREUM], [CHOICE])).toEqual({ networks: [ETHEREUM], tokens: [CHOICE.option] });
  });

  it('is the rows that another flow gives', () => {
    const rows = { networks: [ETHEREUM, { id: 'solana', name: 'Solana' }], tokens: [CHOICE.option] };
    expect(depositSheetOf(rows, [ETHEREUM], [CHOICE])).toBe(rows);
  });
});
