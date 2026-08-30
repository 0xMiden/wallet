/**
 * `pingGuardianEndpoint` answers "is this operator responding right now?" via
 * the unauthenticated `GET /pubkey` — a real guardian answers with a key
 * commitment; anything else (error, timeout, empty commitment) is offline.
 * It must never throw: the result drives an advisory chip in the picker.
 */
import { pingGuardianEndpoint } from './availability';

const mockGetPubkey = jest.fn();
jest.mock('@openzeppelin/guardian-client', () => ({
  GuardianHttpClient: class {
    constructor(public url: string) {
      lastConstructedUrl = this.url;
    }
    getPubkey(scheme: string) {
      return mockGetPubkey(this.url, scheme);
    }
  }
}));
let lastConstructedUrl: string | undefined;

const mockRegisterGuardianOrigin = jest.fn();
jest.mock('lib/miden/guardian/native-http', () => ({
  registerGuardianOrigin: (...args: unknown[]) => mockRegisterGuardianOrigin(...args)
}));

beforeEach(() => {
  jest.clearAllMocks();
  lastConstructedUrl = undefined;
});

describe('pingGuardianEndpoint', () => {
  it('reports online when the endpoint answers with a commitment', async () => {
    mockGetPubkey.mockResolvedValue({ commitment: '0xAAA' });

    await expect(pingGuardianEndpoint('https://g.example.com')).resolves.toBe(true);
    expect(lastConstructedUrl).toBe('https://g.example.com');
    expect(mockGetPubkey).toHaveBeenCalledWith('https://g.example.com', 'ecdsa');
    // Registered for the mobile native-HTTP CORS bypass before pinging.
    expect(mockRegisterGuardianOrigin).toHaveBeenCalledWith('https://g.example.com');
  });

  it('reports offline when the request rejects (connection refused / 5xx)', async () => {
    mockGetPubkey.mockRejectedValue(new Error('Failed to fetch'));
    await expect(pingGuardianEndpoint('https://down.example.com')).resolves.toBe(false);
  });

  it('reports offline when the response carries no commitment', async () => {
    mockGetPubkey.mockResolvedValue({ commitment: '' });
    await expect(pingGuardianEndpoint('https://weird.example.com')).resolves.toBe(false);
  });

  // The body is an unchecked `response.json()` cast, so a host serving nonsense
  // reaches here as a number or an object. A truthiness test called that online;
  // only a guardian answers with a key commitment, which is the whole basis for
  // reading this probe as liveness. Same values `fetchOperatorCommitment` refuses.
  it.each([[1234], [true], [{ nested: 'object' }], [['a']], [null], [undefined]])(
    'reports offline when the commitment is not a string (%p)',
    async commitment => {
      mockGetPubkey.mockResolvedValue({ commitment });
      await expect(pingGuardianEndpoint('https://nonsense.example.com')).resolves.toBe(false);
    }
  );

  it('reports offline when the request outlives the deadline', async () => {
    jest.useFakeTimers();
    try {
      // Never settles — only the deadline can resolve the ping.
      mockGetPubkey.mockReturnValue(new Promise(() => undefined));

      const ping = pingGuardianEndpoint('https://slow.example.com', 1_000);
      jest.advanceTimersByTime(1_001);
      await expect(ping).resolves.toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('a response inside the deadline is not raced away by the timer', async () => {
    jest.useFakeTimers();
    try {
      mockGetPubkey.mockResolvedValue({ commitment: '0xBBB' });
      await expect(pingGuardianEndpoint('https://fast.example.com', 1_000)).resolves.toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
