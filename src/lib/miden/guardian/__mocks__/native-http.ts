/**
 * The native-HTTP double the guardian suites share through `jest.mock` with no factory. It records
 * each probe and its verdict, and runs `withGuardianProbe` with native-http's own lifetime (pinned
 * in native-http.test.ts) over that recording probe. A suite reads the recorder through
 * `jest.requireMock`, which returns the instance its code under test imported, and resets it in its
 * beforeEach.
 */
import type * as NativeHttp from '../native-http';

/** Every endpoint probed, in order. */
export const mockProbedEndpoints: string[] = [];
/** Each probe's verdict as `[endpoint, isGuardian]`. The first settle decides, as in native-http. */
export const mockProbeVerdicts: [string, boolean][] = [];

export function resetMockProbes(): void {
  mockProbedEndpoints.length = 0;
  mockProbeVerdicts.length = 0;
}

export const registerGuardianOrigin = jest.fn<void, [string]>();

export const probeGuardianOrigin: typeof NativeHttp.probeGuardianOrigin = endpoint => {
  mockProbedEndpoints.push(endpoint);
  let settled = false;
  return isGuardian => {
    if (settled) return;
    settled = true;
    mockProbeVerdicts.push([endpoint, isGuardian]);
  };
};

export const withGuardianProbe: typeof NativeHttp.withGuardianProbe = async (
  endpoint,
  check,
  isGuardian = () => true
) => {
  const settle = probeGuardianOrigin(endpoint);
  try {
    const result = await check();
    settle(isGuardian(result));
    return result;
  } finally {
    settle(false);
  }
};
