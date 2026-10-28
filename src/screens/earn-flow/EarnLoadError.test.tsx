import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';
import { EarnLoadError } from './EarnLoadError';
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/telemetry/user-visible-error', () => ({ reportUserVisibleError: jest.fn() }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
afterEach(() => { cleanup(); jest.useRealTimers(); jest.clearAllMocks(); });
it('does not put Earn positions evidence on a vault-only warning', () => {
  jest.useFakeTimers();
  const props = { onRetry: () => {}, errorId: 'earnVaultLoadError' as const, errorDiagnostics: {
    kind: 'earn_positions_load', earnPositionsLoadStage: 'configuration', earnPositionsLoadOutcome: 'complete_failure'
  } };
  render(<EarnLoadError {...props} />);
  act(() => jest.advanceTimersByTime(1000));
  expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['earnVaultLoadError', 'notice']]);
});
it('forwards the matching closed source observation to the displayed positions warning', () => {
  jest.useFakeTimers();
  const evidence = { kind: 'earn_positions_load', earnPositionsLoadStage: 'request', earnPositionsLoadOutcome: 'partial_failure' };
  render(<EarnLoadError {...{ onRetry: () => {}, errorDiagnostics: evidence }} />);
  act(() => jest.advanceTimersByTime(1000));
  expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['earnPositionsLoadError', 'notice', evidence]]);
});
