/**
 * @jest-environment node
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { markInfraAbort } from './dapp-cells';
import { loadMidenSdk } from './dapp-confirm';
import globalSetup, { probePublicFaucet } from './dapp-live-probe';
import { mintFromPublicFaucet, PublicFaucetError, publicFaucetApiUrl } from './public-faucet';

jest.mock('./dapp-confirm', () => ({ loadMidenSdk: jest.fn() }));
jest.mock('./dapp-cells', () => {
  const actual = jest.requireActual('./dapp-cells');
  return { ...actual, markInfraAbort: jest.fn(actual.markInfraAbort) };
});
jest.mock('./public-faucet', () => ({ ...jest.requireActual('./public-faucet'), mintFromPublicFaucet: jest.fn() }));

const loadSdk = jest.mocked(loadMidenSdk);
const mint = jest.mocked(mintFromPublicFaucet);
const mark = jest.mocked(markInfraAbort);

// The address a throwaway wallet gets: the network's prefix, the account id and the interface it was built with.
const fakeSdk = {
  AccountBuilder: class {
    withNoAuthComponent() {
      return this;
    }
    withBasicWalletComponent() {
      return this;
    }
    build() {
      return { account: { id: () => 'throwaway' } };
    }
  },
  NetworkId: { testnet: () => 'mtst', devnet: () => 'mdev' },
  Address: {
    fromAccountId: (id: string, accountInterface: string) => ({
      toBech32: (network: string) => `${network}1${id}-${accountInterface}`
    })
  }
} as unknown as Awaited<ReturnType<typeof loadMidenSdk>>;

const network = process.env.E2E_NETWORK;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dapp-live-probe-'));
  process.env.E2E_NETWORK = 'testnet';
  loadSdk.mockReset().mockResolvedValue(fakeSdk);
  mint.mockReset().mockResolvedValue({ noteId: `0x${'ab'.repeat(32)}` });
  mark.mockClear();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
afterAll(() => {
  if (network === undefined) delete process.env.E2E_NETWORK;
  else process.env.E2E_NETWORK = network;
});

describe('the dApp suite faucet probe', () => {
  it.each([
    ['testnet', 'mtst'],
    ['devnet', 'mdev']
  ])(
    'asks the %s public faucet for one grant to a throwaway wallet and marks nothing when it is granted',
    async (name, prefix) => {
      process.env.E2E_NETWORK = name;
      await probePublicFaucet(dir);
      expect(mint.mock.calls).toEqual([[publicFaucetApiUrl(name), `${prefix}1throwaway-BasicWallet`]]);
      expect(existsSync(join(dir, 'INFRA_ABORT'))).toBe(false);
    }
  );

  it('writes INFRA_ABORT naming the network and the faucet failure when the grant is refused, and lets the run go on', async () => {
    mint.mockRejectedValue(new PublicFaucetError('Public faucet grant failed: Error: 502 Bad Gateway'));
    await expect(probePublicFaucet(dir)).resolves.toBeUndefined();
    const reason = readFileSync(join(dir, 'INFRA_ABORT'), 'utf8');
    expect(reason).toContain('Public faucet probe failed on testnet');
    expect(reason).toContain('502 Bad Gateway');
  });

  it('leaves a network with no public faucet to the journeys: no SDK, no grant, no marker', async () => {
    process.env.E2E_NETWORK = 'localhost';
    await probePublicFaucet(dir);
    expect(loadSdk).not.toHaveBeenCalled();
    expect(mint).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'INFRA_ABORT'))).toBe(false);
  });

  it('fails the global setup when the SDK cannot load, rather than reporting a faucet outage', async () => {
    loadSdk.mockRejectedValue(new Error('WebAssembly.instantiate(): expected magic word'));
    await expect(probePublicFaucet(dir)).rejects.toThrow('expected magic word');
    expect(mint).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'INFRA_ABORT'))).toBe(false);
  });

  it('is the dApp config global setup, so every run probes once before its first journey', () => {
    const repoRoot = resolve(__dirname, '../../..');
    const config = readFileSync(join(repoRoot, 'playwright.dapp.config.ts'), 'utf8');
    const setup = config.match(/globalSetup: '([^']+)'/)?.[1];
    expect(setup && resolve(repoRoot, setup)).toBe(resolve(__dirname, 'dapp-live-probe.ts'));
  });

  it('marks the records directory the journeys and the judge read', async () => {
    mark.mockImplementationOnce(() => undefined);
    mint.mockRejectedValue(new PublicFaucetError('Public faucet grant failed: TimeoutError'));
    await globalSetup();
    expect(mark).toHaveBeenCalledWith(
      resolve(__dirname, '../../../test-results/dapp-cells'),
      expect.stringContaining('Public faucet probe failed on testnet')
    );
  });
});
