import { isDepositScreenPath, nearIntentsDepositPath, pendingDepositPath } from './pending-deposit-route';

jest.mock('screens/send-flow/bridge-networks', () => ({ getBridgeNetworkByChainId: () => undefined }));
jest.mock('lib/remote-config/values', () => ({ selectRelayChain: () => null }));

describe('pending deposit route', () => {
  it('opens the deposit screen on a pending deposit, with the id encoded', () => {
    expect(pendingDepositPath('a/b c')).toBe('/bridge/deposit?pending=a%2Fb%20c');
  });

  it('opens the deposit page of a NEAR Intents row, with the id encoded', () => {
    expect(nearIntentsDepositPath('a/b c')).toBe('/receive/near-intents/a%2Fb%20c');
  });

  it.each([
    ['/bridge/deposit', true],
    ['/bridge/deposit/step', true],
    ['/bridge/depositx', false],
    ['/', false]
  ])('tells whether %s is the deposit screen', (pathname, expected) => {
    expect(isDepositScreenPath(pathname)).toBe(expected);
  });
});
