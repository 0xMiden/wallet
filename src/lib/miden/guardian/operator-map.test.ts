/**
 * operator-map maps each built-in Guardian operator's public key commitment
 * (fetched unauthenticated via GET /pubkey) to the ResolvedGuardianOption
 * that operates it, so an on-chain guardian commitment can be reverse-mapped
 * back to a known operator (or flagged as custom/rotated when no match is
 * found).
 *
 * `@openzeppelin/guardian-client` is normally auto-mocked to a jest.fn()
 * stub (see __mocks__/@openzeppelin/guardian-client.ts) but this suite needs
 * `getPubkey` to return specific per-endpoint commitments, so it overrides
 * the auto-mock with an explicit factory below. `jest.mock` calls are
 * hoisted above imports by the Jest transform, so it's safe to declare it
 * after the imports here (matches this repo's `import/first` lint rule).
 */
import { GuardianHttpClient } from '@openzeppelin/guardian-client';

import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/constants';

import {
  buildOperatorKeyMap,
  checkEndpointCommitment,
  identifyGuardianOperator,
  normalizeHex,
  verifyEndpointMatchesCommitment
} from './operator-map';

jest.mock('@openzeppelin/guardian-client', () => ({
  GuardianHttpClient: class {
    constructor(public url: string) {}
    async getPubkey() {
      const byUrl: Record<string, string> = {
        'https://guardian.openzeppelin.com': '0xAAA',
        'https://miden-guardian.dev.eu-north-3.gateway.fm': '0xBBB',
        'https://miden-guardian.lambdaclass.com': '0xCCC',
        'https://guardian-testnet.kodax.com': '0xDDD'
      };
      return { commitment: byUrl[this.url] };
    }
  }
}));

jest.mock('lib/miden/guardian/native-http', () => ({
  registerGuardianOrigin: jest.fn()
}));

afterEach(() => {
  jest.restoreAllMocks();
});

describe('normalizeHex', () => {
  it('strips 0x and lowercases', () => {
    expect(normalizeHex('0xABC')).toBe('abc');
  });

  it('lowercases when there is no 0x prefix', () => {
    expect(normalizeHex('ABC')).toBe('abc');
  });
});

describe('buildOperatorKeyMap', () => {
  it('maps each reachable operator commitment (normalized) to its ResolvedGuardianOption', async () => {
    const map = await buildOperatorKeyMap(MIDEN_NETWORK_NAME.TESTNET);

    expect(map.get('aaa')?.id).toBe('open-zeppelin');
    expect(map.get('bbb')?.id).toBe('gateway');
    expect(map.get('ccc')?.id).toBe('lambda-class');
    expect(map.get('ddd')?.id).toBe('kodax');
  });

  it('skips an operator whose endpoint is unreachable, without throwing', async () => {
    jest.spyOn(GuardianHttpClient.prototype, 'getPubkey').mockImplementationOnce(async () => {
      throw new Error('network unreachable');
    });

    const map = await buildOperatorKeyMap(MIDEN_NETWORK_NAME.TESTNET);

    // The first operator (open-zeppelin) fails and is skipped; the other
    // built-in operators are still present.
    expect(map.get('aaa')).toBeUndefined();
    expect(map.get('bbb')?.id).toBe('gateway');
    expect(map.get('ccc')?.id).toBe('lambda-class');
    expect(map.get('ddd')?.id).toBe('kodax');
  });
});

describe('identifyGuardianOperator', () => {
  it('identifies the operator whose pubkey matches the on-chain commitment', async () => {
    const op = await identifyGuardianOperator('aaa', MIDEN_NETWORK_NAME.TESTNET); // unprefixed on-chain form
    expect(op?.id).toBe('open-zeppelin');
  });

  it('returns undefined when no operator matches (custom/rotated)', async () => {
    expect(await identifyGuardianOperator('deadbeef', MIDEN_NETWORK_NAME.TESTNET)).toBeUndefined();
  });
});

// The tri-state exists so a caller can tell "it said no" from "it never
// answered": collapsing them makes a network blip indistinguishable from a
// genuine out-of-band guardian switch, and the drift reconciler acts on that
// difference.
describe('checkEndpointCommitment', () => {
  it('reports a match when the endpoint pubkey commitment matches (normalized)', async () => {
    expect(await checkEndpointCommitment('https://guardian.openzeppelin.com', '0xaaa')).toBe('match');
  });

  it('reports a mismatch when the endpoint answers with a different key', async () => {
    expect(await checkEndpointCommitment('https://guardian.openzeppelin.com', 'bbb')).toBe('mismatch');
  });

  it('reports unreachable when the endpoint fetch throws', async () => {
    jest.spyOn(GuardianHttpClient.prototype, 'getPubkey').mockImplementationOnce(async () => {
      throw new Error('network unreachable');
    });

    expect(await checkEndpointCommitment('https://guardian.openzeppelin.com', 'aaa')).toBe('unreachable');
  });

  // An answer carrying no commitment is not a guardian answering, so it is no
  // more evidence of a mismatch than a dropped connection is.
  it('reports unreachable when the endpoint answers without a commitment', async () => {
    expect(await checkEndpointCommitment('https://not-a-guardian.test', 'aaa')).toBe('unreachable');
  });

  // This runs from the ~3s sync tick and the guardian client exposes no abort, so
  // an unbounded wait would park one request per tick against a hung operator.
  it('reports unreachable when the endpoint never answers', async () => {
    jest.useFakeTimers();
    jest.spyOn(GuardianHttpClient.prototype, 'getPubkey').mockImplementationOnce(() => new Promise(() => {}));

    const verdict = checkEndpointCommitment('https://hung.guardian', 'aaa');
    await jest.advanceTimersByTimeAsync(5_000);

    expect(await verdict).toBe('unreachable');
    jest.useRealTimers();
  });
});

describe('verifyEndpointMatchesCommitment', () => {
  it('returns true when the endpoint pubkey commitment matches (normalized)', async () => {
    expect(await verifyEndpointMatchesCommitment('https://guardian.openzeppelin.com', '0xaaa')).toBe(true);
  });

  it('returns false when the endpoint pubkey commitment does not match', async () => {
    expect(await verifyEndpointMatchesCommitment('https://guardian.openzeppelin.com', 'bbb')).toBe(false);
  });

  // Boolean by design for callers about to WRITE the endpoint: unreachable and
  // mismatched are the same answer there — do not persist the unconfirmed.
  it('returns false when the endpoint fetch throws', async () => {
    jest.spyOn(GuardianHttpClient.prototype, 'getPubkey').mockImplementationOnce(async () => {
      throw new Error('network unreachable');
    });

    expect(await verifyEndpointMatchesCommitment('https://guardian.openzeppelin.com', 'aaa')).toBe(false);
  });

  // This is one-shot and user-initiated, so it gets a far longer budget than the
  // repeating sync tick's: on the tick a slow operator is simply retried in 3s,
  // whereas here a `false` is shown to the user as "that URL is the WRONG
  // operator" and blocks the write. A cold-starting but perfectly correct
  // self-hosted guardian must not be reported that way.
  it('waits well past the tick budget before giving up on a slow endpoint', async () => {
    jest.useFakeTimers();
    jest
      .spyOn(GuardianHttpClient.prototype, 'getPubkey')
      .mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve({ commitment: '0xAAA' }), 12_000)));

    const verdict = verifyEndpointMatchesCommitment('https://slow.self-hosted.test', 'aaa');
    await jest.advanceTimersByTimeAsync(12_000);

    expect(await verdict).toBe(true);
    jest.useRealTimers();
  });

  it('still gives up eventually on an endpoint that never answers', async () => {
    jest.useFakeTimers();
    jest.spyOn(GuardianHttpClient.prototype, 'getPubkey').mockImplementationOnce(() => new Promise(() => {}));

    const verdict = verifyEndpointMatchesCommitment('https://hung.self-hosted.test', 'aaa');
    await jest.advanceTimersByTimeAsync(20_000);

    expect(await verdict).toBe(false);
    jest.useRealTimers();
  });
});

// On mobile, guardian traffic reaches the network only through the CapacitorHttp
// CORS bypass, and that interceptor routes REGISTERED origins only. The built-ins
// are pre-seeded, so this is what makes a custom / self-hosted endpoint work —
// and the custom endpoint is exactly what the drift reconciler and the
// manual-URL apply hand to these probes.
describe('mobile CORS-bypass registration', () => {
  const { registerGuardianOrigin } = jest.requireMock('lib/miden/guardian/native-http');

  beforeEach(() => registerGuardianOrigin.mockClear());

  it('registers the probed origin from checkEndpointCommitment', async () => {
    await checkEndpointCommitment('https://custom.guardian.test', 'aaa');
    expect(registerGuardianOrigin).toHaveBeenCalledWith('https://custom.guardian.test');
  });

  it('registers the probed origin from verifyEndpointMatchesCommitment', async () => {
    await verifyEndpointMatchesCommitment('https://custom.guardian.test', 'aaa');
    expect(registerGuardianOrigin).toHaveBeenCalledWith('https://custom.guardian.test');
  });

  it('registers every built-in origin it probes from buildOperatorKeyMap', async () => {
    await buildOperatorKeyMap(MIDEN_NETWORK_NAME.TESTNET);
    expect(registerGuardianOrigin).toHaveBeenCalledWith('https://guardian.openzeppelin.com');
    expect(registerGuardianOrigin).toHaveBeenCalledWith('https://miden-guardian.lambdaclass.com');
  });
});
