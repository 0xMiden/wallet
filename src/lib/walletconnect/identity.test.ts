import { chromeExtensionWalletConnectId } from './identity';

describe('Chrome WalletConnect identity', () => {
  it('returns the extension ID that a receiving wallet can show as the request origin', () => {
    expect(
      chromeExtensionWalletConnectId({
        protocol: 'chrome-extension:',
        host: 'abcdefghijklmnopabcdefghijklmnop'
      })
    ).toBe('abcdefghijklmnopabcdefghijklmnop');
  });

  it.each([
    { protocol: 'https:', host: 'miden.io' },
    { protocol: 'moz-extension:', host: 'abcdefghijklmnopabcdefghijklmnop' },
    { protocol: 'chrome-extension:', host: 'example.com' }
  ])('does not present $protocol$host as a Chrome extension ID', location => {
    expect(chromeExtensionWalletConnectId(location)).toBeUndefined();
  });
});
