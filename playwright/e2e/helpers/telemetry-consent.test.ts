/**
 * The CDP path of `dismissTelemetryConsent`, against a fake WebView whose answers take as long as
 * the stalls seen on CI. Declining navigates to the wallet home for the first time after
 * onboarding, and on an emulator or simulator that first render has held the main thread for
 * 5-7 s, during which no CDP poll is answered either.
 */
import { dismissTelemetryConsent, type TelemetryConsentCdpDriver } from './telemetry-consent';

interface Answer {
  mounted: boolean;
  /** Wall clock the answer takes to come back. */
  ms: number;
}

let clock = 0;

beforeEach(() => {
  clock = 1_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
});

afterEach(() => jest.restoreAllMocks());

// The prompt is up until the decline is clicked; after that each poll takes the next answer.
function webView(afterClick: Answer[], storedConsent: string | null = 'false'): TelemetryConsentCdpDriver {
  let clicked = false;
  const answers = [...afterClick];
  return {
    evalJs: jest.fn().mockImplementation(async (js: string) => {
      if (js.includes('localStorage')) return storedConsent;
      if (!clicked) return true;
      const next = answers.shift() ?? { mounted: true, ms: 0 };
      clock += next.ms;
      return next.mounted;
    }),
    click: jest.fn().mockImplementation(async () => {
      clicked = true;
    }),
    delay: jest.fn().mockImplementation(async (ms: number) => {
      clock += ms;
    })
  };
}

describe('dismissTelemetryConsent over CDP', () => {
  it('waits out a first wallet render that stalls the WebView for 6 s', async () => {
    const driver = webView([
      { mounted: true, ms: 6_000 },
      { mounted: false, ms: 5 }
    ]);

    await expect(dismissTelemetryConsent(driver)).resolves.toBe(true);
  });

  it('fails only on an answer asked after the deadline, not one that crossed it during a stall', async () => {
    const driver = webView([
      { mounted: true, ms: 29_000 },
      // Asked at 29.25 s, answered at 35.25 s: the prompt was still up when the poll was sent.
      { mounted: true, ms: 6_000 },
      { mounted: false, ms: 5 }
    ]);

    await expect(dismissTelemetryConsent(driver)).resolves.toBe(true);
  });

  it('still fails a prompt that never leaves, naming the consent the click stored', async () => {
    const driver = webView([]);

    await expect(dismissTelemetryConsent(driver)).rejects.toThrow(
      /"Not now" was clicked but .* is still mounted after 30000ms \(stored consent: false\)/
    );
  });
});
