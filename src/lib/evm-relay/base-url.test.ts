import { getRelayConfig } from 'lib/remote-config/values';

import { getRelayBaseUrl } from './base-url';
import { relayConfig } from './testing';

jest.mock('lib/remote-config/values', () => ({ getRelayConfig: jest.fn() }));

const DOCUMENT_URL = 'https://relay.example.workers.dev';
const savedDefine = process.env.MIDEN_EVM_RELAY_URL;

beforeEach(() => {
  delete process.env.MIDEN_EVM_RELAY_URL;
  jest.mocked(getRelayConfig).mockReset().mockReturnValue(null);
});

afterAll(() => {
  if (savedDefine === undefined) delete process.env.MIDEN_EVM_RELAY_URL;
  else process.env.MIDEN_EVM_RELAY_URL = savedDefine;
});

describe('getRelayBaseUrl', () => {
  it.each([
    ['http://localhost:8788', 'http://localhost:8788'],
    ['http://127.0.0.1:8788/', 'http://127.0.0.1:8788'],
    ['  http://localhost:8788//  ', 'http://localhost:8788']
  ])('lets a loopback define %j go before the document', (define, expected) => {
    process.env.MIDEN_EVM_RELAY_URL = define;
    jest.mocked(getRelayConfig).mockReturnValue(relayConfig(DOCUMENT_URL));
    expect(getRelayBaseUrl()).toBe(expected);
    expect(getRelayConfig).not.toHaveBeenCalled();
  });

  it.each([
    ['an https define', 'https://relay.other.workers.dev'],
    ['an http define on another host', 'http://relay.example.com'],
    ['an empty define', ''],
    ['a define that is not a URL', 'localhost:8788']
  ])("ignores %s and takes the document's URL", (_name, define) => {
    process.env.MIDEN_EVM_RELAY_URL = define;
    jest.mocked(getRelayConfig).mockReturnValue(relayConfig(DOCUMENT_URL));
    expect(getRelayBaseUrl()).toBe(DOCUMENT_URL);
  });

  it("takes the document's URL with no define", () => {
    jest.mocked(getRelayConfig).mockReturnValue(relayConfig(DOCUMENT_URL));
    expect(getRelayBaseUrl()).toBe(DOCUMENT_URL);
  });

  it('gives null with neither a loopback define nor a document URL', () => {
    process.env.MIDEN_EVM_RELAY_URL = 'https://relay.other.workers.dev';
    expect(getRelayBaseUrl()).toBeNull();
  });
});
