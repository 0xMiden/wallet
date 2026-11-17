import React from 'react';

import { act, cleanup, render } from '@testing-library/react';

import type { UiEvidenceInput } from 'lib/telemetry/ui-producer-diagnostics';
import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';

import { EarnLoadError } from './EarnLoadError';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/telemetry/user-visible-error', () => ({ reportUserVisibleError: jest.fn() }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
afterEach(() => {
  cleanup();
  jest.useRealTimers();
  jest.clearAllMocks();
});
it('does not put Earn positions evidence on a vault-only warning', () => {
  jest.useFakeTimers();
  const evidence: UiEvidenceInput = {
    kind: 'earn_positions_load',
    earnPositionsLoadStage: 'configuration',
    earnPositionsLoadOutcome: 'complete_failure'
  };
  const props = {
    onRetry: () => {},
    errorId: 'earnVaultLoadError' as const,
    errorDiagnostics: evidence
  };
  render(<EarnLoadError {...props} />);
  act(() => jest.advanceTimersByTime(1000));
  expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['earnVaultLoadError', 'notice']]);
});
it('forwards the matching closed source observation to the displayed positions warning', () => {
  jest.useFakeTimers();
  const evidence: UiEvidenceInput = {
    kind: 'earn_positions_load',
    earnPositionsLoadStage: 'request',
    earnPositionsLoadOutcome: 'partial_failure'
  };
  render(<EarnLoadError {...{ onRetry: () => {}, errorDiagnostics: evidence }} />);
  act(() => jest.advanceTimersByTime(1000));
  expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['earnPositionsLoadError', 'notice', evidence]]);
});

it('shows progress and blocks Retry until the request ends', () => {
  const onRetry = jest.fn();
  const { getByRole, rerender } = render(<EarnLoadError onRetry={onRetry} isRetrying />);
  const button = getByRole('button', { name: 'retry' });
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute('aria-busy', 'true');
  expect(button.querySelector('svg circle')).not.toBeNull();
  rerender(<EarnLoadError onRetry={onRetry} isRetrying={false} />);
  expect(button).toBeEnabled();
  expect(button).toHaveAttribute('aria-busy', 'false');
  expect(button.querySelector('svg circle')).toBeNull();
});
