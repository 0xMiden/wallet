/**
 * `pingGuardianEndpointLatency` times the unauthenticated `GET /pubkey`: a real guardian answers
 * with a key commitment and gets a round trip in ms; anything else (error, timeout, empty
 * commitment) is null, which the screens read as offline. It must never throw: the result decides
 * whether the picker lets an operator be selected, and which operator onboarding picks.
 */
import { pingGuardianEndpointLatency } from './availability';

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

describe('pingGuardianEndpointLatency', () => {
  it('reports a round trip when the endpoint answers with a commitment', async () => {
    mockGetPubkey.mockResolvedValue({ commitment: '0xAAA' });

    await expect(pingGuardianEndpointLatency('https://g.example.com')).resolves.toEqual(expect.any(Number));
    expect(lastConstructedUrl).toBe('https://g.example.com');
    expect(mockGetPubkey).toHaveBeenCalledWith('https://g.example.com', 'ecdsa');
    // Registered for the mobile native-HTTP CORS bypass before pinging.
    expect(mockRegisterGuardianOrigin).toHaveBeenCalledWith('https://g.example.com');
  });

  it('reports offline when the request rejects (connection refused / 5xx)', async () => {
    mockGetPubkey.mockRejectedValue(new Error('Failed to fetch'));
    await expect(pingGuardianEndpointLatency('https://down.example.com')).resolves.toBeNull();
  });

  it('reports offline when the response carries no commitment', async () => {
    mockGetPubkey.mockResolvedValue({ commitment: '' });
    await expect(pingGuardianEndpointLatency('https://weird.example.com')).resolves.toBeNull();
  });

  // The body is an unchecked `response.json()` cast, so a host serving nonsense
  // reaches here as a number or an object. A truthiness test called that online;
  // only a guardian answers with a key commitment, which is the whole basis for
  // reading this probe as liveness. Same values `fetchOperatorCommitment` refuses.
  it.each([[1234], [true], [{ nested: 'object' }], [['a']], [null], [undefined]])(
    'reports offline when the commitment is not a string (%p)',
    async commitment => {
      mockGetPubkey.mockResolvedValue({ commitment });
      await expect(pingGuardianEndpointLatency('https://nonsense.example.com')).resolves.toBeNull();
    }
  );

  it('reports offline when the request outlives the deadline', async () => {
    jest.useFakeTimers();
    try {
      // Never settles — only the deadline can resolve the ping.
      mockGetPubkey.mockReturnValue(new Promise(() => undefined));

      const ping = pingGuardianEndpointLatency('https://slow.example.com', 1_000);
      jest.advanceTimersByTime(1_001);
      await expect(ping).resolves.toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('a response inside the deadline is not raced away by the timer', async () => {
    jest.useFakeTimers();
    try {
      mockGetPubkey.mockResolvedValue({ commitment: '0xBBB' });
      await expect(pingGuardianEndpointLatency('https://fast.example.com', 1_000)).resolves.toEqual(expect.any(Number));
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  // Onboarding picks the operator with the smallest number, so the number is the request's own
  // round trip: taken before the request goes out, read after the commitment is checked, rounded.
  it('measures the round trip of the request, in whole milliseconds', async () => {
    const now = jest.spyOn(performance, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(1234.4);
    try {
      mockGetPubkey.mockResolvedValue({ commitment: '0xCCC' });
      await expect(pingGuardianEndpointLatency('https://timed.example.com')).resolves.toBe(234);
    } finally {
      now.mockRestore();
    }
  });
});
