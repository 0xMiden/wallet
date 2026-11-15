import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { CommandDraftProvider, useCommandDrafts } from 'screens/command/command-drafts';

import { CommandEarn } from './CommandEarn';
import { EARN_DATA } from './data';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/remote-config/use-feature-availability', () => ({
  useFeatureAvailability: () => ({ state: 'available' })
}));

const scope = { accountId: 'account-a', network: 'testnet', rpcUrl: 'https://rpc.example' };
const onDeposit = jest.fn();
const onWithdraw = jest.fn();

function DraftSelection() {
  const draft = useCommandDrafts().readDraft('earn');
  return (
    <output data-testid="earn-draft-selection">
      {draft ? `${draft.mode}:${draft.subjectId}:${draft.amount}` : 'none'}
    </output>
  );
}

function show(props: Partial<React.ComponentProps<typeof CommandEarn>> = {}) {
  return render(
    <CommandDraftProvider scope={scope}>
      <DraftSelection />
      <CommandEarn
        summary={EARN_DATA.summary}
        vaults={EARN_DATA.vaults}
        positions={EARN_DATA.positions}
        vaultsPending={false}
        isLoading={false}
        isRefreshing={false}
        onRetry={jest.fn()}
        onDeposit={onDeposit}
        onWithdraw={onWithdraw}
        {...props}
      />
    </CommandDraftProvider>
  );
}

beforeEach(() => {
  onDeposit.mockClear();
  onWithdraw.mockClear();
});

test('selects the exact vault and owned position rather than a fixed market', () => {
  const vaults = [EARN_DATA.vaults[0]!, { ...EARN_DATA.vaults[0]!, id: 'second-vault', name: 'Second market' }];
  const positions = [
    EARN_DATA.positions[0]!,
    { ...EARN_DATA.positions[0]!, id: 'second-position', name: 'Second position' }
  ];
  show({ vaults, positions });
  fireEvent.click(screen.getByTestId('command-earn-deposit-second-vault'));
  expect(onDeposit).toHaveBeenCalledWith('second-vault');
  expect(screen.getByTestId('earn-draft-selection')).toHaveTextContent('deposit:second-vault:');
  fireEvent.click(screen.getByTestId('command-earn-withdraw-second-position'));
  expect(onWithdraw).toHaveBeenCalledWith('second-position');
  expect(screen.getByTestId('earn-draft-selection')).toHaveTextContent('withdraw:second-position:');
});

test('keeps owned withdrawals available when deposits are closed and refuses stale positions', () => {
  show({
    vaults: [{ ...EARN_DATA.vaults[0]!, canOpen: false }],
    positions: [EARN_DATA.positions[0]!, { ...EARN_DATA.positions[0]!, id: 'stale-position', stale: true }]
  });
  expect(screen.getByTestId(`command-earn-deposit-${EARN_DATA.vaults[0]!.id}`)).toBeDisabled();
  expect(screen.getByTestId(`command-earn-withdraw-${EARN_DATA.positions[0]!.id}`)).toBeEnabled();
  expect(screen.getByTestId('command-earn-withdraw-stale-position')).toBeDisabled();
});

test('failed first load offers retry without showing an empty balance or deposit action', () => {
  const retry = jest.fn();
  show({ vaults: [], positions: [], error: 'failed', loadError: 'failed', onRetry: retry });
  expect(screen.queryByTestId('command-earn-summary')).not.toBeInTheDocument();
  expect(screen.queryByTestId('command-earn-deposit-anything')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'retry' }));
  expect(retry).toHaveBeenCalledTimes(1);
});
