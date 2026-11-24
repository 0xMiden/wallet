import { Address } from '@miden-sdk/miden-sdk/lazy';

export const ACTIVITY_COUNTERPARTY_HEX = '0x817edea77acc5d71616e493afecea3';
export const ACTIVITY_COUNTERPARTY_BECH32 = 'mtst1azqhah480tx96utpdeyn4lkw5v5fsdmw';
export const ACTIVITY_COUNTERPARTY_PUBLIC_KEY = `${ACTIVITY_COUNTERPARTY_BECH32}_qr7qqq9wr6w`;

export function mockActivityCounterpartyDecode() {
  const mockDecode = jest.mocked(Address.fromBech32);
  const decode = mockDecode.getMockImplementation();
  if (!decode) throw new Error('The Jest SDK address decoder is unavailable');
  const decoded = decode(ACTIVITY_COUNTERPARTY_BECH32);
  // The shared Jest SDK stub validates the shape but has no decoded account ID.
  jest.mocked(decoded.accountId).mockReturnValue({
    toString: () => ACTIVITY_COUNTERPARTY_HEX
  } as ReturnType<Address['accountId']>);
  mockDecode.mockImplementation(address => (address === ACTIVITY_COUNTERPARTY_BECH32 ? decoded : decode(address)));
  return () => mockDecode.mockImplementation(decode);
}
