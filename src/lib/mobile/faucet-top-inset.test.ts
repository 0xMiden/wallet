/**
 * @jest-environment jsdom
 */
import { getEffectiveFaucetUrl } from 'lib/miden-chain/effective-endpoints';

import { faucetNoTopInsetScript, isFaucetOrigin } from './faucet-top-inset';

jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveFaucetUrl: jest.fn() }));

const mockFaucetUrl = jest.mocked(getEffectiveFaucetUrl);

function runInjectedScript(faucetOrigin: string): void {
  // Runs the shipped string as the WebView does, so the test exercises the real code.
  // eslint-disable-next-line no-new-func
  new Function(faucetNoTopInsetScript(faucetOrigin))();
}

describe('isFaucetOrigin', () => {
  beforeEach(() => mockFaucetUrl.mockReturnValue('https://faucet.example.org/path?x=1'));

  it("accepts the active network's faucet origin", () => {
    expect(isFaucetOrigin('https://faucet.example.org')).toBe(true);
  });

  it('refuses any other origin', () => {
    expect(isFaucetOrigin('https://dapp.example.org')).toBe(false);
    expect(isFaucetOrigin('http://faucet.example.org')).toBe(false);
  });

  it('refuses everything when the effective faucet URL does not parse', () => {
    mockFaucetUrl.mockReturnValue('not a url');
    expect(isFaucetOrigin('https://faucet.example.org')).toBe(false);
    expect(isFaucetOrigin('null')).toBe(false);
  });

  it('refuses everything on a network with no faucet', () => {
    mockFaucetUrl.mockReturnValue(undefined);
    expect(isFaucetOrigin('https://faucet.testnet.miden.io')).toBe(false);
    expect(isFaucetOrigin('null')).toBe(false);
  });
});

describe('faucetNoTopInsetScript', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
  });

  it('drops the body top padding with one style element, however often it is injected', () => {
    runInjectedScript(window.location.origin);
    runInjectedScript(window.location.origin);

    const styles = document.querySelectorAll('#miden-faucet-no-top-inset');
    expect(styles).toHaveLength(1);
    expect(styles[0]!.textContent).toBe('body { padding-top: 0 !important; }');
  });

  it("adds nothing to a document whose own origin is not the faucet's", () => {
    runInjectedScript('https://faucet.example.org');

    expect(document.querySelectorAll('#miden-faucet-no-top-inset')).toHaveLength(0);
  });
});
