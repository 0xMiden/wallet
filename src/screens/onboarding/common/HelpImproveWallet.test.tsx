import React from 'react';

import { render, screen, fireEvent, within } from '@testing-library/react';
import i18n from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';

import { hasTelemetryChoice, isTelemetryEnabled } from 'lib/settings/helpers';
import { initCrashReporting, stopCrashReporting } from 'lib/telemetry/crash';

import HelpImproveWalletScreen, { HelpImproveWalletScreen as NamedHelpImproveWalletScreen } from './HelpImproveWallet';
import en from '../../../../public/_locales/en/en.json';

// This screen is the only place a user is *asked* for consent, so its copy is
// the thing that makes the feature lawful. The real `en.json` is therefore
// seeded into a real i18n instance rather than stubbing `t()` to echo keys:
// asserting `helpImproveWalletDescription` rendered would prove nothing about
// whether the shipped sentence is honest.
//
// `lib/settings/helpers` is likewise NOT mocked — the assertions below read the
// consent back through `isTelemetryEnabled()` / `hasTelemetryChoice()`, which is
// what the rest of the wallet reads. Only the KV mirror behind it is stubbed.

const mockKvStore: Record<string, unknown> = {};
jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => ({
    get: async (keys: string[]) => {
      const out: Record<string, unknown> = {};
      for (const k of keys) if (k in mockKvStore) out[k] = mockKvStore[k];
      return out;
    },
    set: async (obj: Record<string, unknown>) => {
      Object.assign(mockKvStore, obj);
    }
  })
}));

let mockCrashReportingActive = false;
jest.mock('lib/telemetry/crash', () => ({
  initCrashReporting: jest.fn(() => {
    mockCrashReportingActive = true;
  }),
  stopCrashReporting: jest.fn(() => {
    mockCrashReportingActive = false;
  })
}));

const mockInitCrashReporting = initCrashReporting as jest.Mock;
const mockStopCrashReporting = jest.mocked(stopCrashReporting);

/**
 * Both buttons now AWAIT the consent write before calling `onSubmit`, so that
 * the background cannot still be reading the old value when navigation ends a
 * flow. Everything after the click therefore lands a microtask later.
 */
const flushConsentWrite = () => new Promise(resolve => setTimeout(resolve, 0));

// "Usage data" rather than "anonymous data": the ingest endpoint sees an IP like
// any request, so "anonymous" is a term of art that invites a stronger reading
// than this feature can support — and this is the one string doing the legal
// work. Pinned here so the narrower claim cannot quietly widen again.
const ACCEPT_LABEL = 'Share usage data';
const DECLINE_LABEL = 'Not now';

describe('HelpImproveWalletScreen', () => {
  let testI18n: typeof i18n;

  beforeEach(async () => {
    localStorage.clear();
    for (const k of Object.keys(mockKvStore)) delete mockKvStore[k];
    mockCrashReportingActive = false;
    mockInitCrashReporting.mockClear();
    mockStopCrashReporting.mockClear();

    testI18n = i18n.createInstance();
    await testI18n.use(initReactI18next).init({
      lng: 'en',
      fallbackLng: 'en',
      interpolation: { escapeValue: false, prefix: '$', suffix: '$' },
      resources: { en: { translation: en } }
    });
  });

  afterEach(() => {
    localStorage.clear();
  });

  const renderScreen = (props: Partial<React.ComponentProps<typeof HelpImproveWalletScreen>> = {}) =>
    render(
      <I18nextProvider i18n={testI18n}>
        <HelpImproveWalletScreen {...props} />
      </I18nextProvider>
    );

  it('renders the onboarding container with its test id', () => {
    renderScreen();
    expect(screen.getByTestId('onboarding-help-improve-wallet')).toBeInTheDocument();
  });

  // The E2E suites have to get past this screen on every profile that has never
  // answered, and both buttons carry nothing but a localized title — which makes
  // the harness's only hook a copy string that this very file pins as changeable
  // for legal reasons. These two ids are what `dismissTelemetryConsent`
  // (playwright/e2e/helpers/telemetry-consent.ts) drives, so they are part of the
  // contract, not decoration.
  it('exposes both choices to the E2E harness by test id', () => {
    renderScreen();

    expect(screen.getByTestId('help-improve-wallet-accept')).toHaveTextContent(ACCEPT_LABEL);
    expect(screen.getByTestId('help-improve-wallet-decline')).toHaveTextContent(DECLINE_LABEL);
  });

  it('puts the ids on the buttons themselves, inside the container the harness polls for', () => {
    renderScreen();
    const prompt = screen.getByTestId('onboarding-help-improve-wallet');

    for (const testId of ['help-improve-wallet-accept', 'help-improve-wallet-decline']) {
      const button = screen.getByTestId(testId);
      expect(button.tagName).toBe('BUTTON');
      // The harness scopes the click to the container, so an id that escaped it
      // would be found by `getByTestId` here and by nothing there.
      expect(prompt.contains(button)).toBe(true);
    }
  });

  it('declining by test id records usage refusal while leaving crash reporting active', async () => {
    const onSubmit = jest.fn();
    initCrashReporting();
    mockInitCrashReporting.mockClear();
    renderScreen({ onSubmit });

    fireEvent.click(screen.getByTestId('help-improve-wallet-decline'));
    expect(onSubmit).not.toHaveBeenCalled();
    await flushConsentWrite();

    expect(isTelemetryEnabled()).toBe(false);
    expect(hasTelemetryChoice()).toBe(true);
    expect(mockInitCrashReporting).not.toHaveBeenCalled();
    expect(mockStopCrashReporting).not.toHaveBeenCalled();
    expect(mockCrashReportingActive).toBe(true);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('asks rather than assumes: nothing is recorded or started by rendering the prompt', () => {
    renderScreen();

    expect(hasTelemetryChoice()).toBe(false);
    expect(isTelemetryEnabled()).toBe(false);
    expect(mockInitCrashReporting).not.toHaveBeenCalled();
  });

  it('titles itself with the localized heading', () => {
    renderScreen();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Help improve Wallet');
  });

  it('says in one line what sharing is for, under the heading', () => {
    renderScreen();
    expect(screen.getByText("Share usage data so we can fix what's breaking.")).toBeInTheDocument();
  });

  it('groups the disclosure as three titled facts: what is shared, what stays private, no tracking', () => {
    renderScreen();
    const body = screen.getByTestId('help-improve-wallet-disclosure');

    const titles = ['Only what helps us fix bugs', 'Your wallet stays private', 'No ads, no tracking'];
    for (const title of titles) expect(within(body).getByText(title)).toBeInTheDocument();
    // In that order: what is collected first, then the reassurances.
    const text = body.textContent ?? '';
    const positions = titles.map(title => text.indexOf(title));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    // And it still says the choice is not final.
    expect(body).toHaveTextContent(/you can change this any time in settings/i);
  });

  it('names what IS collected', () => {
    renderScreen();
    const body = screen.getByTestId('help-improve-wallet-disclosure');

    expect(body).toHaveTextContent(/which parts of Wallet you use/i);
    expect(body).toHaveTextContent(/where you get stuck/i);
    expect(body).toHaveTextContent(/broad error categories/i);
    expect(body).toHaveTextContent(/the app version/i);
    expect(body).toHaveTextContent(/your platform/i);
  });

  it('discloses always-on scrubbed crash reports separately from optional usage data', () => {
    renderScreen();
    const body = screen.getByTestId('help-improve-wallet-disclosure');
    const crashReports = within(body).getByTestId('help-improve-wallet-crash-reports');

    expect(crashReports.tagName).toBe('P');
    expect(crashReports).toHaveClass('text-body-sm', 'text-muted');
    expect(crashReports).toHaveTextContent(en.helpImproveWalletCrashReports);
    expect(crashReports).toHaveTextContent(/crash reports are sent either way/i);
    expect(crashReports).toHaveTextContent(/where it happened in the code/i);
    expect(crashReports).toHaveTextContent(/scrubbed to remove sensitive data/i);
    expect(crashReports).toHaveTextContent(/with no identifier for you or your device/i);
    expect(crashReports.nextElementSibling).toHaveTextContent(en.helpImproveWalletChangeAnyTime);
    expect(within(body).getByText(en.helpImproveWalletSharedDescription)).not.toHaveTextContent(/crash report/i);
  });

  it('names what is NOT collected, including the things a wallet must never send', () => {
    renderScreen();
    const body = screen.getByTestId('help-improve-wallet-disclosure');

    // The brief's own assertion: the phrase a user scanning for reassurance
    // looks for.
    expect(body).toHaveTextContent(/never your keys/i);
    for (const excluded of [
      'recovery phrase',
      'password',
      'addresses',
      'balances',
      'amounts',
      'transaction contents'
    ]) {
      expect(body).toHaveTextContent(new RegExp(excluded, 'i'));
    }
  });

  it('rules out tracking, advertising, and sale to data brokers', () => {
    renderScreen();
    const body = screen.getByTestId('help-improve-wallet-disclosure');

    expect(body).toHaveTextContent(/no tracking across other apps or sites/i);
    expect(body).toHaveTextContent(/nothing used for advertising/i);
    expect(body).toHaveTextContent(/nothing sold or shared with data brokers/i);
  });

  it('tells the user the choice is reversible', () => {
    renderScreen();
    expect(screen.getByTestId('help-improve-wallet-disclosure')).toHaveTextContent(/change this any time/i);
  });

  it('never claims anonymity, in the buttons or the body', () => {
    renderScreen();

    // "Anonymous" is a term of art that invites a stronger reading than this
    // feature can support: the ingest endpoint sees an IP like any other
    // request. The whole prompt is checked, not just the accept button, so the
    // claim cannot reappear in the disclosure once it has been taken off the
    // button.
    const prompt = screen.getByTestId('onboarding-help-improve-wallet').textContent ?? '';
    expect(prompt).not.toMatch(/anonym/i);
    // ...and the narrower claim really is the one on the button.
    expect(prompt).toContain(ACCEPT_LABEL);
  });

  it('records usage acceptance without restarting the active crash reporter', async () => {
    const onSubmit = jest.fn();
    initCrashReporting();
    mockInitCrashReporting.mockClear();
    renderScreen({ onSubmit });

    fireEvent.click(screen.getByText(ACCEPT_LABEL));
    expect(onSubmit).not.toHaveBeenCalled();
    await flushConsentWrite();

    expect(isTelemetryEnabled()).toBe(true);
    expect(hasTelemetryChoice()).toBe(true);
    expect(mockInitCrashReporting).not.toHaveBeenCalled();
    expect(mockStopCrashReporting).not.toHaveBeenCalled();
    expect(mockCrashReportingActive).toBe(true);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('is skippable, and records the refusal so the prompt does not reappear', async () => {
    const onSubmit = jest.fn();
    renderScreen({ onSubmit });

    fireEvent.click(screen.getByText(DECLINE_LABEL));
    await flushConsentWrite();

    expect(isTelemetryEnabled()).toBe(false);
    // A skip is still an answer — otherwise `hasTelemetryChoice()` stays false
    // and the user gets asked again on every launch.
    expect(hasTelemetryChoice()).toBe(true);
    // Declining must never start the reporter.
    expect(mockInitCrashReporting).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('mirrors the consent to the background store so the service worker agrees', async () => {
    renderScreen({ onSubmit: jest.fn() });

    fireEvent.click(screen.getByText(ACCEPT_LABEL));
    await flushConsentWrite();

    expect(mockKvStore['telemetry_consent_setting']).toBe(true);
  });

  it('renders the decline button as the secondary action', () => {
    renderScreen();

    // Accepting is the primary; a full-weight "Not now" would nudge, and the
    // opt-in has to be a real choice.
    // Compare the buttons themselves: the shared Button renders its label in an unclassed
    // span, so the variant shows on the button element rather than on the text node.
    const decline = screen.getByText(DECLINE_LABEL).closest('button')!;
    const accept = screen.getByText(ACCEPT_LABEL).closest('button')!;
    expect(decline.className).not.toEqual(accept.className);
  });

  it('does not throw when clicked without an onSubmit handler', () => {
    renderScreen();

    expect(() => fireEvent.click(screen.getByText(DECLINE_LABEL))).not.toThrow();
    expect(hasTelemetryChoice()).toBe(true);
  });

  it('exposes the same component as its default and named export', () => {
    expect(NamedHelpImproveWalletScreen).toBe(HelpImproveWalletScreen);
  });
});
