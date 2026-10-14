import React from 'react';

import { render, screen } from '@testing-library/react';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

import FullScreenPage from 'app/layouts/FullScreenPage';
import { Button } from 'components/Button';
import { RecoverySeedPrompt } from 'components/RecoverySeedPrompt';
import { ReviewLayout } from 'components/review/ReviewLayout';
import { ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import { HelpImproveWalletScreen } from 'screens/onboarding/common/HelpImproveWallet';
import { SetupBiometricScreen } from 'screens/onboarding/common/SetupBiometric';

import { SubPageLayout } from './SubPageLayout';

jest.mock('react-i18next', () => {
  const messages = require('../../../public/_locales/en/en.json');
  const t = (key: string) => messages[key] ?? key;
  return { useTranslation: () => ({ t }) };
});
jest.mock('lib/platform', () => ({
  isIOS: () => true,
  isMobile: () => true,
  isAndroid: () => false,
  isExtension: () => false
}));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('lib/mobile/useHideNavbarWhileOpen', () => ({ useHideNavbarWhileOpen: jest.fn() }));
jest.mock('lib/mobile/useMobileBackHandler', () => ({ useMobileBackHandler: jest.fn() }));
jest.mock('lib/mobile/screenshot-guard', () => ({ useScreenshotGuard: () => true }));
jest.mock('lib/mobile/webview-state', () => ({ isReturningFromWebview: () => true }));
jest.mock('lib/biometric', () => ({
  checkBiometricSetup: async () => ({ available: true }),
  authenticate: async () => false,
  openBiometricSettings: jest.fn()
}));
jest.mock('lib/settings/helpers', () => ({ setTelemetrySetting: jest.fn() }));
jest.mock('lib/telemetry/crash', () => ({ initCrashReporting: jest.fn() }));
jest.mock('lib/store', () => ({ useWalletStore: () => jest.fn() }));
jest.mock('lib/miden/activity', () => ({ requestSWTransactionProcessing: jest.fn() }));
jest.mock('components/flow/useSlideOnReflow', () => ({ useSlideOnReflow: jest.fn() }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getTestNetworkNameKey: () => null }));
jest.mock('components/NetworkModeSheet', () => ({ NetworkModeSheet: () => null }));

const rows = Array.from({ length: 28 }, (_, index) => (
  <Button key={index} title={`Row ${index + 1}`} data-testid={`row-${index + 1}`} />
));

const originalDirectory = process.env.WALLET_CANVAS_ORIGINAL;
const Review = originalDirectory ? require(join(originalDirectory, 'ReviewLayout.tsx')).ReviewLayout : ReviewLayout;
const SubPage = originalDirectory ? require(join(originalDirectory, 'SubPageLayout.tsx')).SubPageLayout : SubPageLayout;
const Biometric = originalDirectory
  ? require(join(originalDirectory, 'SetupBiometric.tsx')).SetupBiometricScreen
  : SetupBiometricScreen;
const Consent = originalDirectory
  ? require(join(originalDirectory, 'HelpImproveWallet.tsx')).HelpImproveWalletScreen
  : HelpImproveWalletScreen;
const Recovery = originalDirectory
  ? require(join(originalDirectory, 'RecoverySeedPrompt.tsx')).RecoverySeedPrompt
  : RecoverySeedPrompt;

const recoveryTransaction: ITransaction = {
  id: 'layout-fixture',
  type: 'send',
  accountId: 'layout-only-placeholder',
  status: ITransactionStatus.Queued,
  initiatedAt: 0,
  displayIcon: 'SEND'
};

const cases = [
  {
    name: 'review',
    node: (
      <Review
        hero={<h1>Review</h1>}
        primary={{ label: 'Confirm', onPress: jest.fn() }}
        secondary={{ label: 'Back', onPress: jest.fn() }}
      >
        {rows}
      </Review>
    ),
    targetText: 'Back'
  },
  { name: 'subpage-list', node: <SubPage title="List">{rows}</SubPage>, targetText: 'Row 28' },
  {
    name: 'subpage-footer',
    node: (
      <SubPage title="List" footer={<Button title="Continue" />} footerNavbarCushion={false}>
        {rows}
      </SubPage>
    ),
    targetText: 'Continue'
  },
  { name: 'biometric', node: <Biometric />, targetText: 'Use passcode instead' },
  { name: 'consent', node: <Consent />, targetText: 'Not now' },
  {
    name: 'recovery',
    node: <Recovery transaction={recoveryTransaction} onClose={jest.fn()} />,
    targetText: 'Close'
  }
];

describe('wallet canvas actual DOM fixtures', () => {
  it.each(cases)('retains the real layout and actionable target for $name', async ({ name, node, targetText }) => {
    const { container } = render(<FullScreenPage entrance="fade">{node}</FullScreenPage>);
    if (name === 'biometric') await screen.findByText('Biometric authentication failed');
    const buttons = Array.from(container.querySelectorAll('button'));
    const target = buttons.find(button => button.textContent === targetText);
    expect(target).toBeDefined();
    expect(target).toHaveClass('h-12');
    target!.setAttribute('data-canvas-target', name);
    const directory = process.env.WALLET_CANVAS_DOM_EXPORT;
    if (directory) {
      mkdirSync(directory, { recursive: true });
      const ancestry = [];
      for (let parent: HTMLElement | null = target!; parent && parent !== container; parent = parent.parentElement) {
        ancestry.push({
          tag: parent.tagName,
          className: parent.className,
          attributes: Object.fromEntries(
            Array.from(parent.attributes).map(attribute => [attribute.name, attribute.value])
          )
        });
      }
      writeFileSync(
        join(directory, `${name}.json`),
        JSON.stringify({ name, targetText, html: container.innerHTML, ancestry }, null, 2)
      );
    }
  });
});
